#!/usr/bin/env node
// retrieval.mjs — the MEM-24 in-process retrieval engine (DESIGN §7).
//
// A minimal, swappable stack the reconciler `require`s in-process — no daemon, no vector DB:
//   embeddings : @huggingface/transformers running all-MiniLM-L6-v2 (ONNX, local/zero-network
//                after the first ~23 MB model fetch into ~/.cache/huggingface)
//   cache      : id -> { hash, vec } JSON sidecar; re-embed ONLY on content-hash change
//   semantic   : brute-force cosine (vectors are mean-pooled + normalized -> cosine == dot)
//   keyword    : ripgrep over the node pool (L1-L2)
//   fusion     : reciprocal rank fusion, k=60 (MEM-19)
//
// The owned markdown is the store of record; this cache is disposable (losing it = lose
// convenience, not knowledge — re-embed rebuilds it). Brute-force stays interactive to
// ~50k-100k nodes (MEM-24), far above our ceiling; an ANN index is a later drop-in swap.

import { pipeline } from '@huggingface/transformers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEMORY_ROOT } from './paths.mjs';

const execFileP = promisify(execFile);

// The disposable embedding cache, one home (MEM-38 step 4): it was literalled in every consumer,
// which is exactly how a reader and a writer end up pointing at different files. Gitignored derived
// data — losing it costs a re-embed, not knowledge.
export const CACHE_FILE = resolve(MEMORY_ROOT, '.cache', 'embeddings.json');

// The two calibrated read-path constants, also one home (MEM-38 step 4). They live HERE, with the
// engine whose output they gate, rather than in recall.mjs, for a mechanical reason: recall.mjs
// imports relevance.mjs and has a top-level await in its CLI, so a constants import in the other
// direction closes a cycle that DEADLOCKS the CLI rather than merely being untidy. recall.mjs
// re-exports both, so it stays the documented face of the read path.
//   FLOOR    — absolute cosine cutoff for eligibility. Originally calibrated on the live pool
//              (2026-06-25) against SYNTHETIC nulls: on-topic hits >=0.40, null noise <=0.21, so
//              0.35 sat in a clean gap. RECALIBRATED 2026-08-13 to 0.38 against REAL sessions
//              (MEM-33 precision audit, artifacts/research/recall-precision-2026-08-13.md): 177
//              logged hits joined to the prompts that fired them and judged by hand. The synthetic
//              gap does not exist in live use -- the 0.35-0.39 band ran 29% noise for only 31%
//              useful, while 0.38 lifts event precision 38% -> 48%, drops noise 29% -> 24%, and
//              nearly halves injected hits (139 -> 80) at a cost of 4 useful recalls out of 24.
//              0.40 is strictly dominated (same precision, 2 more good events lost).
//              Applies to RAW cosine only — never to a weighted or multiplied score, which would
//              redefine eligibility every time a downstream dial moved.
//   MAX_NODES — the injection budget. It was duplicated in relevance.mjs at 4 while recall injected
//              6, so every shadow measurement taken since MEM-33 was on the wrong budget.
export const FLOOR = 0.38;
export const MAX_NODES = 6;

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const RRF_K = 60;
const EMBED_BATCH = 8;   // MEM-24: batch of 8 avoids the single-padded-batch RAM spike

export function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---------- embeddings (lazy singleton; model loads/downloads once) ----------
let _extractor = null;
async function extractor() {
  if (!_extractor) _extractor = await pipeline('feature-extraction', MODEL);
  return _extractor;
}

// embed(texts) -> Array<Float32Array(384)>, mean-pooled + L2-normalized (so cosine == dot).
export async function embed(texts) {
  if (!texts.length) return [];
  const ex = await extractor();
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const t = await ex(batch, { pooling: 'mean', normalize: true });
    for (let b = 0; b < batch.length; b++) {
      out.push(Float32Array.from(t.data.slice(b * DIM, (b + 1) * DIM)));
    }
  }
  return out;
}

// ---------- cache: id -> { hash, vec[] } ; disposable JSON sidecar ----------
export class EmbeddingCache {
  constructor(path) { this.path = path; this.map = new Map(); }
  async load() {
    try {
      const j = JSON.parse(await readFile(this.path, 'utf8'));
      for (const [id, v] of Object.entries(j)) this.map.set(id, v);
    } catch { /* fresh cache */ }
    return this;
  }
  async save() {
    // Null-prototype accumulator: node ids are untrusted keys, and on a plain `{}` an id of
    // `__proto__` assigns the prototype instead of an own property, so that node's vector never
    // reaches the file. The load side is already safe (Object.entries sees it as an own key).
    const obj = Object.create(null);
    for (const [id, v] of this.map) obj[id] = v;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(obj), 'utf8');
  }
  get(id, hash) {
    const e = this.map.get(id);
    return e && e.hash === hash ? Float32Array.from(e.vec) : null;
  }
  set(id, hash, vec) { this.map.set(id, { hash, vec: Array.from(vec) }); }
  delete(id) { this.map.delete(id); }
  prune(liveIds) { const live = new Set(liveIds); for (const id of this.map.keys()) if (!live.has(id)) this.map.delete(id); }
}

// Ensure every node's current prose is embedded in the cache (re-embed only changed/missing).
// nodes: Array<{ id, prose }>. Mutates + returns the cache. Caller persists via cache.save().
export async function syncCache(nodes, cache) {
  const stale = nodes.filter(n => !cache.get(n.id, contentHash(n.prose)));
  if (stale.length) {
    const vecs = await embed(stale.map(n => n.prose));
    stale.forEach((n, i) => cache.set(n.id, contentHash(n.prose), vecs[i]));
  }
  cache.prune(nodes.map(n => n.id));
  return cache;
}

// ---------- brute-force cosine ----------
export function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// queryVec vs entries:[{id,vec}] -> [{id,score}] desc, top-k.
// Ties break on id, INSIDE the shared function rather than at any call site. JS sort is stable, so
// equal scores would otherwise preserve input order, and the pool loaders consume readdir() output
// unsorted — meaning with more than k equal-scoring candidates the FILESYSTEM enumeration order
// decided which survived the cutoff. A downstream tie-break cannot repair that: the discarded
// candidates are already gone. Deterministic is strictly better for every consumer here.
export function cosineTopK(queryVec, entries, k) {
  return entries
    .map(e => ({ id: e.id, score: dot(queryVec, e.vec) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, k);
}

// ---------- keyword (ripgrep over the node pool) ----------
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Returns node ids (filename minus .md) ranked by match count, best first.
export async function ripgrepSearch(query, dir, limit = 20) {
  const terms = (query.match(/[\p{L}\p{N}]{3,}/gu) || []).map(escapeRe);
  if (!terms.length) return [];
  const pattern = terms.join('|');
  // A pool directory that does not exist yet is "nothing to search", not a tool failure: rg would
  // exit 2 on it and the loud branch below would print an error on every recall. A real rg fault
  // still reaches that branch.
  if (!existsSync(dir)) return [];
  try {
    const { stdout } = await execFileP('rg', ['-c', '-i', '--no-messages', '-e', pattern, '--glob', '*.md', dir]);
    return stdout.trim().split('\n').filter(Boolean)
      .map(line => { const i = line.lastIndexOf(':'); return { id: basename(line.slice(0, i), '.md'), n: +line.slice(i + 1) }; })
      .sort((a, b) => b.n - a.n).slice(0, limit).map(r => r.id);
  } catch (err) {
    // rg exit 1 means zero matches (the common case): stay silent. Anything else (ENOENT
    // missing binary, other exit codes, spawn errors) is an environment fault: log loudly
    // so an unattended nightly surfaces it, then still return [] (recall degrades, never crashes).
    if (err?.code !== 1) console.error(`ripgrepSearch: rg failed (code ${err?.code ?? 'unknown'}): ${err?.message ?? err}`);
    return [];
  }
}

// ---------- RRF fusion (MEM-19, k=60) ----------
function rrfFuse(lists, k = RRF_K) {
  const score = new Map();
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ---------- top-level hybrid search ----------
// nodes:[{id,prose}], cache synced by caller. Returns ranked node ids (semantic x keyword, RRF).
export async function search(query, nodes, cache, dir, k = 10) {
  const [qv] = await embed([query]);
  const entries = nodes
    .map(n => ({ id: n.id, vec: cache.get(n.id, contentHash(n.prose)) }))
    .filter(e => e.vec);
  const sem = cosineTopK(qv, entries, k * 2).map(r => r.id);
  const kw = await ripgrepSearch(query, dir, k * 2);
  return rrfFuse([sem, kw]).slice(0, k);
}

// semantic-only SCORED retrieval — for callers that need a relevance FLOOR (an absolute cosine
// cutoff), which the RRF rank-fusion in search() discards. Returns [{id, score}] desc, top-k.
// Cache-only, exactly like search(): a node whose cached vec is missing/stale is skipped (the
// reconciler keeps the cache warm; §7 freshness). Pure reader — never mutates/saves the cache.
export async function searchScored(query, nodes, cache, k = 10) {
  const [qv] = await embed([query]);
  const entries = nodes
    .map(n => ({ id: n.id, vec: cache.get(n.id, contentHash(n.prose)) }))
    .filter(e => e.vec);
  return cosineTopK(qv, entries, k);
}

// Direct-run smoke test:  node retrieval.mjs            (self-contained, no corpus needed)
//                         node retrieval.mjs "<query>"  (search the live node pool)
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = process.argv[2];
  if (!arg) {
    const docs = [
      'The reconciler is the single writer of canonical memory nodes.',
      'Cats are small domesticated carnivorous mammals.',
      'Brute-force cosine similarity stays fast below fifty thousand vectors.',
    ];
    const t0 = Date.now();
    const vecs = await embed(docs);
    const [q] = await embed(['who writes the memory graph?']);
    const ranked = cosineTopK(q, vecs.map((vec, i) => ({ id: String(i), vec })), 3);
    console.log(`embedded ${docs.length} docs + query in ${Date.now() - t0} ms; dim=${vecs[0].length}`);
    console.log('cosine ranking (expect doc 0 first):', ranked.map(r => `${r.id}:${r.score.toFixed(3)}`).join('  '));
  } else {
    const { loadPool, NODES_DIR } = await import('./nodes.mjs');
    const nodes = await loadPool();
    const cache = await new EmbeddingCache(CACHE_FILE).load();
    await syncCache(nodes, cache);
    const ids = await search(arg, nodes, cache, NODES_DIR);
    console.log(ids.length ? ids.join('\n') : '(no matches — pool may be empty)');
  }
}
