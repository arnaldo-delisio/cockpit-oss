#!/usr/bin/env node
// links.mjs — the associations sidecar (DESIGN §6a.5; MEM-31 v1 link-only). Pure helpers + I/O.
//
// Associations between nodes live in a reconciler-owned edge-list knowledge/links.json — NOT in
// node bodies/frontmatter (a link in a node would bump its `updated`, churn prose, and re-fire the
// MEM-29/31 cost guard every night). Undirected: each edge stores its endpoint pair sorted (a<b)
// so the canonical key is trivial and dedup is exact. This module only reads/writes + maintains the
// edge set — it holds NO judgment (that's visionary.mjs / the reconciler, the sole writer MEM-8).
//
//   edge := { a, b, source, note, created }   // a<b (sorted); source ∈ dreaming|ported|manual|distiller
//
// Typed endpoints (MEM-34 step 4, §6a.8d): an endpoint is `node:<id>` | `insight:<id>` |
// `proposal:<id>` | `skill:<name>` | `mcp:<tool>` | `entity:<dossier-id>` (MEM-35) — OR a bare
// graph-node id with no prefix, kept
// for backward compatibility with every edge minted before this extension (reconcile.mjs/
// visionary.mjs's existing addEdge() call sites still pass bare node ids; the live links.json is
// never migrated — a bare endpoint is treated as an implicit `node:`). A type-prefixed string still
// sorts/dedups correctly under edgeKey()'s existing canonical-sorted-pair scheme (just another
// string). addEdge() itself needs no change — it's already type-agnostic (any two distinct strings).
//
// Importing this module must never trigger a run.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { MEMORY_ROOT } from './nodes.mjs';

const LINKS_FILE = resolve(MEMORY_ROOT, 'knowledge', 'links.json');

const nowISO = () => new Date().toISOString();

// canonical undirected key for a pair (order-independent).
export function edgeKey(a, b) {
  return a < b ? `${a}\t${b}` : `${b}\t${a}`;
}

// load the edge list -> Array<edge>; [] if the sidecar doesn't exist yet or is unreadable.
export async function loadLinks() {
  try {
    const j = JSON.parse(await readFile(LINKS_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// persist the edge list, sorted by canonical key for a diff-stable commit (it rides knowledge/).
export async function saveLinks(edges) {
  const sorted = [...edges].sort((x, y) => edgeKey(x.a, x.b).localeCompare(edgeKey(y.a, y.b)));
  await mkdir(dirname(LINKS_FILE), { recursive: true });
  await writeFile(LINKS_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

// add an undirected edge if new. Mutates `edges`. Skips self-pairs and exact-key duplicates.
// Returns true iff an edge was appended (so callers can enforce a budget on real additions).
export function addEdge(edges, a, b, { source, note } = {}) {
  if (!a || !b || a === b) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const key = edgeKey(lo, hi);
  if (edges.some((e) => edgeKey(e.a, e.b) === key)) return false;
  edges.push({ a: lo, b: hi, source: source || 'dreaming', note: note || '', created: nowISO() });
  return true;
}

// drop any edge whose endpoint is missing from / superseded in the live pool. Mutates `edges`
// in place (keeps the reference the reconciler/sidecar share); returns the removed edges for audit.
//
// Per-type liveness (MEM-34 step 4, §6a.8d) via the optional `opts` sets — each defaults to "always
// live" (never pruned) when the caller doesn't pass one, so every pre-existing call site (reconcile.mjs
// passes only `liveIds`) keeps its exact prior behavior; a caller only opts a type into pruning by
// supplying its live-id set:
//   node:<id> | bare id -> pruned exactly as before (missing/superseded from `liveIds`)
//   insight:<id>        -> pruned only if opts.insightIds is given AND the id is absent (the FILE is
//                           gone) — never merely for reaching a terminal status (dismissed/applied/
//                           promoted findings still exist and are still worth a connection)
//   proposal:<id>       -> always dead: the harness-proposals store was removed (ATT-3), so no
//                           producer exists and any such edge is pruned
//   skill:<name>        -> pruned only if opts.skillNames is given AND the name is absent (its
//                           SKILL.md no longer exists)
//   mcp:<tool>          -> never pruned in v1 (no deregistration signal exists yet — a tool merely
//                           unused this window still exists)
//   entity:<dossier-id> -> pruned only if opts.entityIds is given AND the id is absent (the dossier
//                           FILE is gone — MEM-35 dossiers are regenerable, but a deleted one should
//                           not keep dangling edges)
export function prune(edges, liveIds, opts = {}) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const { insightIds, skillNames, entityIds } = opts;
  const isLive = (endpoint) => {
    if (endpoint.startsWith('insight:')) return !insightIds || insightIds.has(endpoint.slice(8));
    if (endpoint.startsWith('proposal:')) return false;   // no producer since the harness-proposals cut (ATT-3): dead by definition
    if (endpoint.startsWith('skill:')) return !skillNames || skillNames.has(endpoint.slice(6));
    if (endpoint.startsWith('entity:')) return !entityIds || entityIds.has(endpoint.slice(7));
    if (endpoint.startsWith('mcp:')) return true;
    const id = endpoint.startsWith('node:') ? endpoint.slice(5) : endpoint;
    return live.has(id);
  };
  const removed = [];
  for (let i = edges.length - 1; i >= 0; i--) {
    if (!isLive(edges[i].a) || !isLive(edges[i].b)) removed.push(...edges.splice(i, 1));
  }
  return removed;
}

// degree of a node id in the edge set (how many edges touch it) — used for under-linked anchor bias.
export function degreeOf(edges, id) {
  let d = 0;
  for (const e of edges) if (e.a === id || e.b === id) d++;
  return d;
}

// the live neighbor ids already linked to `id` (so the judge never re-proposes an existing edge).
export function neighborsOf(edges, id) {
  const out = [];
  for (const e of edges) {
    if (e.a === id) out.push(e.b);
    else if (e.b === id) out.push(e.a);
  }
  return out;
}
