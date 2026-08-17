#!/usr/bin/env node
// visionary.mjs — the visionary association-surfacing pass (DESIGN §8 mode 2b / §6a.5; MEM-31 v1).
//
// The *associative* half of dreaming that --reflect's consolidation does NOT do: it surfaces real
// associations between EXISTING nodes into the knowledge/links.json sidecar (links.mjs). v1 is
// LINK-ONLY — it invents no nodes and writes no node bodies (except the one-time migration that
// ports pre-existing in-body `Links:` suffixes into the sidecar). It never touches the always-load
// projection layer. Candidates come from semantic proximity (searchScored, brute-force cosine over
// the warm cache — MEM-24, no graph DB; the graph has ~no links to traverse, so proximity is the
// candidate source). One judge('hard') call per anchor neighborhood proposes the genuinely-associated
// pairs. Brain-neutral; the reconciler is the sole writer (MEM-8) and commits the sidecar (PHASE-1).
//
// Importing this module must never trigger a run.

import { judge } from './judge.mjs';
import { searchScored } from './retrieval.mjs';
import { addEdge, edgeKey, degreeOf, neighborsOf } from './links.mjs';

// --- tunables (grey-area picks; tune after reading a week of audit diffs) ---
const ANCHOR_CAP = 12;           // max anchors per run ⇒ ≤12 judge('hard') calls (early-stop once budget fills)
const ANCHOR_PER_CLUSTER = 2;    // cluster-diversity cap on anchors: stops one big high-centrality cluster (e.g. the
                                 // 13-node identity cluster) from sweeping every anchor slot, so a run explores
                                 // ACROSS clusters/scopes — cross-pollination is MEM-31's headline value (G1).
const K_NEIGHBORS = 6;           // semantic neighbors pulled per anchor (searchScored k; anchor self is dropped)
const LINKS_PER_ANCHOR = 2;      // max edges one anchor neighborhood may contribute, so a single DENSE cluster
                                 // (e.g. the identity twins) can't monopolize the global budget — spreads links
                                 // across anchors/scopes (breadth = the cross-pollination value, G1).
const ANCHOR_PROSE_CHARS = 500;  // anchor prose handed to searchScored / the judge
const NEIGHBOR_PROSE_CHARS = 400;// per-candidate prose truncation in the judge prompt
const VISIONARY_TIMEOUT_MS = 90_000;
const W_CENTRALITY = 1.0;        // anchor score weights: load-bearing nodes...
const UNDERLINK_BONUS = 0.5;     // ...that are under-linked (degree 0)...
const W_RECENCY = 0.3;           // ...and recently changed are explored first.

const truncate = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const isLive = (n) => n && !n.frontmatter.superseded;

// ============================================================ one-time migration (DESIGN §6a.5; catch #6)
// Port the reconciler-owned `Links:` SUFFIX line (the bodyWithLinks pattern) into the sidecar:
//   - target resolving to a live node id  -> add a {source:'ported'} edge
//   - non-resolving (doc/decision decoration, e.g. [[STATE.md]]) -> drop, recorded in the audit
// The whole suffix line is then removed (every target is either ported or dropped). Inline `[[ ]]`
// inside the distilled PROSE are left untouched (the distiller owns prose, MEM-27). Idempotent: a
// second run finds no `Links:` suffix to port. Sets `updated` once on each stripped node so PHASE-1
// writes it; the visionary fingerprint is computed AFTER this revision so it ignores it.
//   dryRun: still computes the full port/drop plan into the audit, but mutates NO node body.
const SUFFIX_RE = /^Links:\s*(.*\[\[.*)$/;   // reconciler-owned suffix line (starts with "Links:" + has a wikilink)

export function portInBodyLinks(pool, edges, liveIds, { dryRun = false } = {}) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const audit = { ported: [], dropped: [], stripped: [] };
  const nowISO = () => new Date().toISOString();

  for (const node of pool) {
    if (node.frontmatter.superseded) continue;
    const lines = (node.body || '').split('\n');
    // find the LAST line that is the reconciler-owned Links: suffix (appended at the end by bodyWithLinks)
    let li = -1;
    for (let i = lines.length - 1; i >= 0; i--) { if (SUFFIX_RE.test(lines[i].trim())) { li = i; break; } }
    if (li === -1) continue;                                   // no suffix → nothing to port (idempotent)

    const targets = [...lines[li].matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    for (const t of targets) {
      const id = t.split('|')[0].split('#')[0].trim();          // handle [[id|label]] and [[id#heading]]
      if (live.has(id)) {
        if (addEdge(edges, node.id, id, { source: 'ported', note: 'ported from in-body link' }))
          audit.ported.push({ a: node.id < id ? node.id : id, b: node.id < id ? id : node.id });
      } else {
        audit.dropped.push({ from: node.id, target: id });      // dangling decoration → drop, never silent
      }
    }

    // remove the whole suffix line (+ a trailing blank line left before it), update prose, stamp once.
    audit.stripped.push(node.id);
    if (dryRun) continue;
    lines.splice(li, 1);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    node.body = lines.join('\n').trim();
    node.prose = node.body;
    node.frontmatter.updated = nowISO();
  }
  return audit;
}

// ============================================================ anchor selection (catch #7)
// Bias toward high-centrality + UNDER-LINKED (degree 0) + recently-`updated`, then spread the picks
// ACROSS clusters (≤ANCHOR_PER_CLUSTER each) so one big high-centrality cluster can't sweep every slot
// — cross-cluster/cross-scope exploration is the headline value (G1). Always returns up to ANCHOR_CAP
// (the starvation breaker: backfill by raw score if cluster-capping left slots; a stable-but-executing
// graph still gets a sweep — the saturation guard in reconcile.mjs is what stops re-running an UNCHANGED
// graph). Pure.
function selectAnchors(live, edges, cap = ANCHOR_CAP, perCluster = ANCHOR_PER_CLUSTER) {
  const byRecency = [...live].sort((a, b) =>
    String(b.frontmatter.updated || '').localeCompare(String(a.frontmatter.updated || '')));
  const recencyRank = new Map(byRecency.map((n, i) => [n.id, i]));
  const n = Math.max(1, live.length);
  const score = (node) =>
    W_CENTRALITY * (Number(node.frontmatter.centrality) || 0)
    + (degreeOf(edges, node.id) === 0 ? UNDERLINK_BONUS : 0)
    + W_RECENCY * (1 - (recencyRank.get(node.id) || 0) / n);
  const ranked = [...live].sort((a, b) => score(b) - score(a));
  const out = [], picked = new Set(), perCount = new Map();
  for (const node of ranked) {                                  // first pass: cluster-diverse
    if (out.length >= cap) break;
    const c = node.frontmatter.cluster || 'unclustered';
    if ((perCount.get(c) || 0) >= perCluster) continue;
    perCount.set(c, (perCount.get(c) || 0) + 1); out.push(node); picked.add(node.id);
  }
  for (const node of ranked) {                                  // backfill by score if clusters were too few
    if (out.length >= cap) break;
    if (!picked.has(node.id)) { out.push(node); picked.add(node.id); }
  }
  return out;
}

// ============================================================ the pass
// surfaceAssociations(pool, cache, edges, opts) — mutates `edges` (adds {source:'dreaming'} edges up
// to `budget`), returns an audit. dryRun pays the judge cost (to preview real edges) but writes
// nothing to disk (the reconciler skips PHASE-1). Global budget — one cross-scope pass (MEM-31 G5).
export async function surfaceAssociations(pool, cache, edges, { dryRun = false, budget = 8 } = {}) {
  const audit = { added: [], skippedExisting: 0, droppedOverCap: 0, droppedPerAnchor: 0, anchorsConsidered: 0 };
  const live = pool.filter(isLive);
  const byId = new Map(live.map((n) => [n.id, n]));
  if (live.length < 2) return audit;

  for (const anchor of selectAnchors(live, edges)) {
    if (audit.added.length >= budget) break;                    // early-stop: budget filled
    audit.anchorsConsidered++;

    const hood = await searchScored(truncate(anchor.prose, ANCHOR_PROSE_CHARS), live, cache, K_NEIGHBORS + 1);
    const existing = new Set(neighborsOf(edges, anchor.id));
    const candidates = [];
    for (const { id } of hood) {
      if (id === anchor.id || !byId.has(id)) continue;
      if (existing.has(id)) { audit.skippedExisting++; continue; }
      if (candidates.some((c) => c.id === id)) continue;
      candidates.push({ id, node: byId.get(id) });
    }
    if (!candidates.length) continue;

    let proposed;
    try { proposed = await judge(visionaryPrompt(anchor, candidates), { tier: 'hard', json: true, timeoutMs: VISIONARY_TIMEOUT_MS }); }
    catch (e) { console.error(`visionary: judge failed for anchor ${anchor.id} (${e.message}); skipping.`); continue; }
    if (!Array.isArray(proposed)) { console.error(`visionary: non-array reply for anchor ${anchor.id}; skipping.`); continue; }

    const candIds = new Set(candidates.map((c) => c.id));
    let addedThisAnchor = 0;
    for (const p of proposed) {
      if (!p || !candIds.has(p.id)) continue;                   // only the proximity candidates we handed it
      if (!isLive(byId.get(p.id))) continue;                    // both endpoints live + not superseded
      if (addedThisAnchor >= LINKS_PER_ANCHOR) { audit.droppedPerAnchor++; continue; }  // breadth: cap one neighborhood
      if (audit.added.length >= budget) { audit.droppedOverCap++; continue; }
      if (addEdge(edges, anchor.id, p.id, { source: 'dreaming', note: truncate(p.note, 160) })) {
        const [a, b] = anchor.id < p.id ? [anchor.id, p.id] : [p.id, anchor.id];
        audit.added.push({ a, b, note: truncate(p.note, 160) });
        candIds.delete(p.id);                                   // don't double-count if the model repeats it
        addedThisAnchor++;
      }
    }
  }
  if (audit.droppedOverCap) console.error(`visionary: ${audit.droppedOverCap} association(s) dropped over the ${budget}-link/run budget.`);
  return audit;
}

function visionaryPrompt(anchor, candidates) {
  const list = candidates.map((c, i) =>
    `[${i}] id="${c.id}" (${c.node.frontmatter.type}) ${c.node.frontmatter.title}\n    ${truncate(c.node.prose, NEIGHBOR_PROSE_CHARS)}`
  ).join('\n\n');
  return `You are the memory reconciler's VISIONARY association-surfacer. You are given one ANCHOR \
note from a personal knowledge graph and a set of semantically-nearby CANDIDATE notes. Identify which \
candidates are GENUINELY, NON-TRIVIALLY ASSOCIATED with the anchor — a real cross-link a thoughtful \
person would draw between the two ideas (shared mechanism, cause/effect, one informs or motivates the \
other, productive tension, same underlying principle across different domains). Cross-domain links are \
especially valuable. Be STRICT: surfacing nothing is correct when the only relation is generic topic \
overlap or boilerplate similarity. Do NOT invent new claims — only relate the two existing notes.

ANCHOR id="${anchor.id}" (${anchor.frontmatter.type}) ${anchor.frontmatter.title}
    ${truncate(anchor.prose, ANCHOR_PROSE_CHARS)}

CANDIDATES:
${list}

Return ONLY a JSON array (possibly empty) of the candidates that are genuinely associated:
[ { "id": "<candidate id, exactly as given>", "note": "<≤1 line: why these two relate>" } ]
Omit candidates that are not a real association. Return [] if none qualify.`;
}
