#!/usr/bin/env node
// relevance.mjs — the relevance sidecar (MEM-33 A1; spec in
// decisions/attention-capture-lifecycle.md "First spike"). Engine + CLI.
//
// LIVE since MEM-38 step 4: recall.mjs reads the written sidecar (loadSidecar) as the third factor
// of its ranking product, and dream.sh recomputes + commits it nightly. Shadow scoring below stays
// as the CALIBRATION view (raw vs weighted), it is no longer the only tie-in.
//
// Computes a per-node relevance score (recency decay, rate-modulated by structure) and writes
// a disposable sidecar. Truth and relevance are separate stores: this file NEVER mutates a
// node, a cursor, or anything under knowledge/ — losing the sidecar loses zero truth.
//
// LOCKED INVARIANTS (this file must never break):
//   • READ-ONLY to the record  — never writes knowledge/nodes/*.md, links.json, or the cursors.
//   • sidecar OUTSIDE knowledge/ — .reconciler/relevance.json, so it never trips the
//     reconciler's knowledgeTreeDirty() guard or rides a node commit (the git race, MEM-33).
//   • ELIGIBILITY stays on raw cosine — relevance only re-orders the already-eligible set, in the
//     shadow view here and in recall.mjs's live ranking alike. It can down-rank a stale node; it
//     can never surface anything from below the cosine floor.
//   • centrality modulates the decay RATE, not a floor — foundational nodes fade slower;
//     ordinary old nodes actually fade (a centrality floor pinned the median at ~0.84).
//   • superseded is MIRRORED, never set — supersession is a distillation decision.
//   • `now` is a parameter      — engine functions never call Date.now() (reproducibility).
//
// Usage:
//   node relevance.mjs --dry-run              # sorted table + summary; writes NOTHING
//   node relevance.mjs --explain <id>         # one node's full derivation
//   node relevance.mjs --score "<prompt>" [--scope <s>]   # shadow: raw vs weighted ranking
//   node relevance.mjs --write [--commit]     # write .reconciler/relevance.json (+ commit it alone)

import { readFile, readdir, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { MEMORY_ROOT, loadPool } from './nodes.mjs';
import { loadLinks, degreeOf } from './links.mjs';
import { commitAt } from './scoped-commit.mjs';   // shared commit path, incl. the no-identity fallback

const execFileP = promisify(execFile);

export const SIDECAR_FILE = resolve(MEMORY_ROOT, '.reconciler', 'relevance.json');

// --- tunables (v1 guesses — calibrated empirically on the live pool, like the 0.35 floor) ---
const DEFAULTS = {
  half_life_days: 45,   // base half-life for an ordinary (low-structure) node
  rate_min: 0.5,        // half-life multiplier at structure 0  (fades ~2x faster than base)
  rate_max: 4.0,        // half-life multiplier at structure 1  (fades ~4x slower than base)
  rate_exp: 4,          // curve exponent — pool centrality is compressed (median 0.84), so the
                        // curve must spread the top; linear would hand the median node rate_max
  degree_rate: 0.05,    // extra half-life per link edge (structure beyond judge-scored centrality)
  degree_cap: 6,        // ...capped, so a hub can't buy more than +30%
  pin_centrality: 0.95, // explicit top-centrality pin — a SMALL set (0.9 caught 59/207 nodes)
};

const DAY_MS = 86_400_000;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ============================================================ inputs (all read-only)

// Coarse per-session recall recency from MEM-30's dedup cursors (scopes/*/staging/.recall/*.json).
// Each cursor is an overwrite-snapshot { injectedIds: [...], updated } — so the ONLY derivable
// signal is "the newest session-`updated` whose set contains this id" (per-node recall time and
// count are NOT recoverable here; that needs the Phase-2 hit-log). Returns Map<id, {at, session}>.
async function loadRecallRecency() {
  const recency = new Map();
  const scopesDir = resolve(MEMORY_ROOT, 'scopes');
  let scopes = [];
  try { scopes = await readdir(scopesDir); } catch { return recency; }
  for (const scope of scopes) {
    const dir = resolve(scopesDir, scope, 'staging', '.recall');
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let cur;
      try { cur = JSON.parse(await readFile(resolve(dir, f), 'utf8')); } catch { continue; }
      if (!cur || typeof cur !== 'object' || !Array.isArray(cur.injectedIds)) continue;  // tolerate bad shapes, not just bad JSON
      const at = Date.parse(cur.updated);
      if (!Number.isFinite(at)) continue;
      const session = `${scope}/${basename(f, '.json')}`;
      for (const id of cur.injectedIds) {
        const prev = recency.get(id);
        if (!prev || at > prev.at) recency.set(id, { at, session });
      }
    }
  }
  return recency;
}

// The always-load projection fence — ONE derivation, shared with recall.mjs (which imports
// loadFenceIds from here; MEM-38 step 4 wired the two modules together, so the second copy that
// used to live in recall.mjs lost its reason to exist). Projected nodes are pinned: they are the
// behavioral spine, already loaded every session.
function fenceIdsFromState(stateJson) {
  const ids = new Set();
  for (const route of Object.values(stateJson || {})) {
    for (const id of Object.keys(route.graduated || {})) ids.add(id);
    for (const r of route.emerging || []) if (r && r.source) ids.add(r.source);
  }
  return ids;
}
export async function loadFenceIds() {
  try {
    return fenceIdsFromState(JSON.parse(await readFile(resolve(MEMORY_ROOT, '.reconciler', 'projection-state.json'), 'utf8')));
  } catch { return new Set(); }
}

// ============================================================ scoring (pure)

// effective half-life = base * multiplier(structure). Structure = judge-scored centrality run
// through a spreading curve, plus a small capped link-degree bonus. This is the "rate, not floor"
// correction: high structure slows fading; nothing here stops fading.
function effectiveHalfLife(centrality, degree, cfg = DEFAULTS) {
  const c = clamp01(Number(centrality) || 0);
  const mult = cfg.rate_min + (cfg.rate_max - cfg.rate_min) * c ** cfg.rate_exp;
  const degreeBonus = 1 + cfg.degree_rate * Math.min(Number(degree) || 0, cfg.degree_cap);
  const hl = cfg.half_life_days * mult * degreeBonus;
  return Number.isFinite(hl) && hl > 0 ? hl : DEFAULTS.half_life_days;  // bad cfg must not NaN-poison the pool
}

// Score one node -> its sidecar entry. `now` in ms; `recalled` = {at, session} | undefined.
function scoreNode(node, { degree = 0, fence, recalled, now, cfg = DEFAULTS }) {
  const fm = node.frontmatter || {};
  const reasons = [];

  const pins = [];
  if (fm.type === 'identity') pins.push('pin:identity');
  if (fence && fence.has(node.id)) pins.push('pin:projected');
  if ((fm.centrality ?? 0) >= cfg.pin_centrality) pins.push('pin:top-centrality');
  const pinned = pins.length > 0;
  reasons.push(...pins);

  let updatedMs = Date.parse(fm.updated ?? fm.created);
  if (!Number.isFinite(updatedMs)) { updatedMs = now; reasons.push('no-timestamp'); }
  let lastTouch = updatedMs;
  if (recalled && recalled.at > lastTouch) { lastTouch = recalled.at; reasons.push('touch:recalled'); }
  else reasons.push('touch:updated');

  const age_days = Math.max(0, (now - lastTouch) / DAY_MS);
  const halfLife = effectiveHalfLife(fm.centrality, degree, cfg);
  const base = 0.5 ** (age_days / halfLife);
  if (!pinned) reasons.push(`half-life:${Math.round(halfLife)}d`);

  const entry = {
    relevance: pinned ? 1.0 : round4(clamp01(base)),
    base: round4(clamp01(base)),
    pinned,
    superseded: !!fm.superseded,     // MIRRORED from frontmatter — never set here
    age_days: round1(age_days),
    centrality: fm.centrality ?? 0,
    reasons,
  };
  if (recalled) entry.last_recalled_session = recalled.session;
  return entry;
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;
const round1 = (x) => Math.round(x * 10) / 10;

// Full pass over the pool -> the sidecar object. Pure given its inputs.
export function computeSidecar({ pool, edges, fence, recency, now, cfg = DEFAULTS }) {
  // NULL-PROTOTYPE, and this is the producer half of a class we already closed on the consumer half.
  // Node ids come off filenames, so a node named `__proto__` assigned into a plain object would mutate
  // the map's PROTOTYPE instead of creating an own entry: JSON.stringify then omits it, the sidecar
  // never carries it, and live recall reads a missing relevance as 1, so that node silently evades the
  // decay this function just computed for it. Every attacker-influenced string used as an object key
  // in this engine has this hole (Codex 2026-07-25; the same class turned a node's `provenance` into a
  // function and aborted a nightly reconcile mid-write).
  const nodes = Object.create(null);
  for (const n of [...pool].sort((a, b) => a.id.localeCompare(b.id))) {   // diff-stable key order
    nodes[n.id] = scoreNode(n, { degree: degreeOf(edges, n.id), fence, recalled: recency.get(n.id), now, cfg });
  }
  return { schema: 1, generated: new Date(now).toISOString(), half_life_days: cfg.half_life_days, nodes };
}

// Convenience: gather every input (read-only) and compute. The one entry point callers need.
export async function computeRelevance({ now, cfg = DEFAULTS } = {}) {
  const [pool, edges, fence, recency] = await Promise.all([loadPool(), loadLinks(), loadFenceIds(), loadRecallRecency()]);
  return { sidecar: computeSidecar({ pool, edges, fence, recency, now, cfg }), pool, edges };
}

export async function loadSidecar() {
  try { return JSON.parse(await readFile(SIDECAR_FILE, 'utf8')); } catch { return null; }
}

// ============================================================ shadow scoring (the calibration view)
// What a relevance-weighted ranking WOULD look like for a prompt, beside the raw one. Mirrors
// recall.mjs's visibility rules (scope+global, not superseded, fence-deduped) and its calibrated
// constants. The safe-influence shape from the spec: FLOOR on raw cosine decides ELIGIBILITY;
// relevance only re-orders the already-eligible set — so shadow can down-rank stale nodes but can
// never surface anything new from below the floor.
// FLOOR and MAX_NODES now come from retrieval.mjs, the one home they share with live recall
// (MEM-38 step 4). The copies that used to sit here had DRIFTED — this file measured on a 4-slot
// budget while live recall injected 6 — which is what two homes for one number always eventually
// costs.
export async function shadowScore({ prompt, scope, now, cfg = DEFAULTS }) {
  const { EmbeddingCache, syncCache, searchScored, CACHE_FILE, FLOOR, MAX_NODES } = await import('./retrieval.mjs');
  const { sidecar, pool } = await computeRelevance({ now, cfg });
  const stored = await loadSidecar();
  const relSource = stored && stored.nodes ? stored : sidecar;   // a malformed stored sidecar must not crash calibration
  const rel = (id) => relSource.nodes[id]?.relevance ?? 1;

  const fence = await loadFenceIds();
  const visible = pool.filter((n) =>
    !n.frontmatter.superseded
    && (!scope || [scope, 'global'].includes(n.frontmatter.scope))
    && !fence.has(n.id));

  const cache = await new EmbeddingCache(CACHE_FILE).load();                                         // read-only
  await syncCache(visible.map((n) => ({ id: n.id, prose: n.prose })), cache);                        // in-memory warm only
  // FULL length, matching live recall. The `MAX_NODES * 3` cutoff that used to sit here made the
  // calibration path structurally incapable of showing the promotion the live path was missing: it
  // applied the identical raw-cosine truncation, so any node that weighting would have promoted from
  // outside the top-18 was already discarded before the comparison. A shadow that cannot see the
  // defect it exists to measure is worse than no shadow. MAX_NODES still bounds the DISPLAY below.
  const scored = await searchScored(prompt, visible.map((n) => ({ id: n.id, prose: n.prose })), cache, visible.length);

  const eligible = scored.filter((r) => r.score >= FLOOR);
  const raw = eligible.map((r) => ({ id: r.id, cosine: round4(r.score), relevance: rel(r.id) }));
  const weighted = [...raw].sort((a, b) => b.cosine * b.relevance - a.cosine * a.relevance);
  // `scoredTop` is full-depth deliberately. It carried a `slice(0, MAX_NODES * 3)` until MEM-38 step 4,
  // the last surviving copy of the truncation that WAS the defect: bounding candidates by raw cosine
  // before the product is applied discards nodes that trust and relevance would have promoted. The
  // field has no consumers today, so the slice was inert, but leaving a stale bound inside the very
  // function whose depth was just fixed is how a future reader re-introduces it.
  return { floor: FLOOR, max_nodes: MAX_NODES, scoredTop: scored, raw, weighted, source: stored ? 'sidecar' : 'computed' };
}

export function renderShadow(sh) {
  const pick = (list) => list.slice(0, sh.max_nodes).map((r) => r.id);
  const rawTop = pick(sh.raw), wTop = pick(sh.weighted);
  const lines = [];
  lines.push(`shadow ranking (relevance source: ${sh.source}) — floor=${sh.floor} on RAW cosine; relevance re-orders eligible only`);
  // Both columns are CALIBRATION views, and neither is the live selection model: since MEM-38 step 4
  // recall ranks on cosine x trust x relevance and allocates per pool, so a flat single-slate ranking
  // (raw or relevance-weighted) is no longer what production does. Labelling either as "live" is how a
  // future recalibration ends up tuning against a model that no longer exists.
  lines.push('  raw cosine only (calibration)      vs  cosine x relevance (calibration)');
  const width = Math.max(...sh.raw.map((r) => r.id.length), 10);
  for (let i = 0; i < Math.max(sh.raw.length, sh.weighted.length); i++) {
    const a = sh.raw[i], b = sh.weighted[i];
    const mark = (x, top) => (x ? `${top.includes(x.id) ? '►' : ' '} ${x.id.padEnd(width)} ${x.cosine.toFixed(3)}·r${x.relevance.toFixed(2)}` : ''.padEnd(width + 14));
    lines.push(`  ${mark(a, rawTop)}   ${mark(b, wTop)}`);
  }
  const dropped = rawTop.filter((id) => !wTop.includes(id));
  const promoted = wTop.filter((id) => !rawTop.includes(id));
  lines.push(dropped.length || promoted.length
    ? `  Δ top-${sh.max_nodes}: down-ranked ${JSON.stringify(dropped)} · promoted ${JSON.stringify(promoted)} (both were already eligible)`
    : `  Δ top-${sh.max_nodes}: none — weighting changes nothing for this prompt`);
  if (!sh.raw.length) lines.push('  (nothing cleared the floor — both rankings empty)');
  return lines.join('\n');
}

// ============================================================ sidecar write + lone commit
// ATOMIC tmp+rename, the same pattern (and `.tmp-${pid}` suffix) as projection.mjs's
// writeInsightFile and reconcile.mjs's preference-queue write. Direct-to-target was survivable while
// the sidecar was shadow-only; step 4 made it consumed on EVERY prompt, so an interrupted nightly
// would leave unparseable JSON, loadSidecar would return null, and every node's relevance would
// silently fall back to 1 — the live multiplier disabled on every prompt until some later run
// happened to succeed, with the graph intact and nothing looking broken. The temp file is a SIBLING
// inside .reconciler/, so it is on the same filesystem as the target and the rename is a genuine
// atomic replace rather than a copy. On any failure the temp file is removed, so a partial write can
// never linger under a name something else might pick up.
export async function writeSidecar(sidecar) {
  await mkdir(resolve(MEMORY_ROOT, '.reconciler'), { recursive: true });
  // Per-CALL entropy, not just per-process. A pid-only suffix (the convention the four cited
  // precedents share) makes the temp path unique across processes but SHARED between two concurrent
  // calls inside one process: they interleave their writeFile output and one renames the mixed bytes
  // onto the target, which is the exact corruption this function exists to prevent, just moved from
  // "interrupted run" to "concurrent caller" (reproduced: 7 of 40 trials published unparseable JSON).
  // No caller writes concurrently in-process today, so this is a latent edge on a newly load-bearing
  // exported function rather than a live bug. randomUUID is stdlib, so it costs no dependency.
  const tmp = `${SIDECAR_FILE}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
    await rename(tmp, SIDECAR_FILE);
  } catch (err) {
    await unlink(tmp).catch(() => {});   // best-effort cleanup; the original error is what matters
    throw err;
  }
}

// Commit ONLY the sidecar (never anything under knowledge/), with the locale-proof
// empty-commit guard (MEM-29 — check the index, not stderr text).
export async function commitSidecar() {
  const git = (args) => execFileP('git', ['-C', MEMORY_ROOT, ...args]);
  await git(['add', '--', '.reconciler/relevance.json']);
  // Guard AND commit are pathspec-scoped: pre-staged unrelated work must neither trigger the
  // commit (guard) nor ride along in it (commit pathspec) — Codex review 2026-07-04, blocker #1.
  try { await git(['diff', '--cached', '--quiet', '--', '.reconciler/relevance.json']); return false; }  // exit 0 ⇒ sidecar unchanged
  catch { /* sidecar staged with changes */ }
  await commitAt(MEMORY_ROOT, ['-m', 'relevance: recompute sidecar (live since MEM-38 step 4)', '--quiet', '--', '.reconciler/relevance.json']);
  return true;
}

// ============================================================ CLI
function renderTable(sidecar, pool) {
  const typeOf = new Map(pool.map((n) => [n.id, n.frontmatter.type]));
  const rows = Object.entries(sidecar.nodes)
    .sort((a, b) => b[1].relevance - a[1].relevance || a[0].localeCompare(b[0]));
  const w = Math.min(Math.max(...rows.map(([id]) => id.length)), 52);
  const lines = [`${'id'.padEnd(w)}  type       cent  age_d   base   relev  pin  reasons`];
  for (const [id, e] of rows) {
    lines.push(`${id.slice(0, w).padEnd(w)}  ${String(typeOf.get(id) || '?').padEnd(9)}  ${e.centrality.toFixed(2)}  ${String(e.age_days).padStart(5)}  ${e.base.toFixed(3)}  ${e.relevance.toFixed(3)}  ${e.pinned ? ' ●' : '  '}   ${e.reasons.join(',')}`);
  }
  const es = Object.values(sidecar.nodes);
  const unpinned = es.filter((e) => !e.pinned).map((e) => e.relevance).sort((a, b) => a - b);
  const bucket = (lo, hi) => unpinned.filter((r) => r >= lo && r < hi).length;
  lines.push('', `nodes=${es.length}  pinned=${es.filter((e) => e.pinned).length} `
    + `(identity=${es.filter((e) => e.reasons.includes('pin:identity')).length} `
    + `projected=${es.filter((e) => e.reasons.includes('pin:projected')).length} `
    + `top-centrality=${es.filter((e) => e.reasons.includes('pin:top-centrality')).length})  superseded=${es.filter((e) => e.superseded).length}`);
  lines.push(`unpinned=${unpinned.length}  median=${unpinned.length ? unpinned[Math.floor(unpinned.length / 2)].toFixed(3) : '-'}  `
    + `buckets: <0.2=${bucket(0, 0.2)}  0.2-0.5=${bucket(0.2, 0.5)}  0.5-0.8=${bucket(0.5, 0.8)}  ≥0.8=${bucket(0.8, 1.01)}`);
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const now = Date.now();  // the CLI is the trigger — the engine itself never reads the clock

  if (has('--dry-run')) {
    const { sidecar, pool } = await computeRelevance({ now });
    console.log(renderTable(sidecar, pool));
  } else if (has('--explain')) {
    const id = valOf('--explain');
    const { sidecar, edges } = await computeRelevance({ now });
    const e = sidecar.nodes[id];
    if (!e) { console.error(`no such node: ${id}`); process.exit(1); }
    console.log(JSON.stringify({ id, ...e, degree: degreeOf(edges, id), effective_half_life_days: Math.round(effectiveHalfLife(e.centrality, degreeOf(edges, id))) }, null, 2));
  } else if (has('--score')) {
    const prompt = valOf('--score');
    if (!prompt) { console.error('usage: node relevance.mjs --score "<prompt>" [--scope <s>]'); process.exit(2); }
    console.log(renderShadow(await shadowScore({ prompt, scope: valOf('--scope'), now })));
  } else if (has('--write') || has('--commit')) {
    const { sidecar } = await computeRelevance({ now });
    await writeSidecar(sidecar);
    console.log(`wrote ${SIDECAR_FILE} (${Object.keys(sidecar.nodes).length} nodes)`);
    if (has('--commit')) console.log((await commitSidecar()) ? 'committed .reconciler/relevance.json' : 'no change — commit skipped');
  } else {
    console.error('usage: node relevance.mjs --dry-run | --explain <id> | --score "<prompt>" [--scope <s>] | --write [--commit]');
    process.exit(2);
  }
}
