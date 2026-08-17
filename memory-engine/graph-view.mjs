// graph-view.mjs — the dashboard memory-graph payload, composed engine-side (MEM-39 step 1).
//
// One read-path brick: the middleware's /__cockpit_graph and /__cockpit_dossier routes call
// these composers instead of assembling frontmatter themselves, so the payload logic sits in
// the engine's own test lane (node --test) rather than untestable inside a Vite plugin.
// Read-only: loads through loadPool/loadDossiers/loadLinks, writes nothing.
//
// The composition itself is pure (composeGraphPayload over already-loaded data) so tests can
// drive it with fixtures without touching the store loaders.

import { loadPool, poolOf } from './nodes.mjs';
import { loadDossiers } from './dossiers.mjs';
import { loadLinks } from './links.mjs';
import { registeredScopes } from './paths.mjs';

// Scope wall (MEM-39 review finding, highest severity): graphView previously served every
// node in the flat pool dir, so unregistered/walled scopes (the seeded `demo` node) leaked
// into the payload while sourcesView already walled to the registry. Walled-in = registered
// scopes plus 'global' (the cross-scope marker dossiers use when their sources span scopes —
// a designation, not a scope dir) plus nodes carrying no scope at all (legacy v1 nodes;
// hiding them entirely would misreport the pool, and they carry no wall to honor).
export function scopeWall(registered) {
  const allowed = new Set(registered);
  allowed.add('global');
  return (scope) => scope == null || allowed.has(scope);
}

// links.json endpoints are either bare node ids (legacy, implicit node:) or prefixed
// (MEM-34 §6a.8d). The graph renders nodes and dossiers; other prefixes (insight:, skill:,
// mcp:, proposal:) have no renderable target on this surface and are excluded — counted,
// never silently dropped.
export function normalizeEndpoint(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.startsWith('node:')) return { kind: 'node', id: raw.slice(5) };
  if (raw.startsWith('entity:')) return { kind: 'dossier', id: raw.slice(7) };
  if (raw.includes(':')) return null; // typed, non-renderable here
  return { kind: 'node', id: raw };
}

const srcAnchorOf = (fm) =>
  typeof fm.citation === 'string' && fm.citation.startsWith('src:') ? fm.citation.slice(4) : null;

// Count `- ` claim bullets in a dossier body's ## Claims section (stops at the next heading).
export function claimCount(body) {
  // No m flag here: $ must mean end-of-text, not end-of-line, or the section truncates.
  const m = (body || '').match(/(?:^|\n)## Claims[^\n]*\n([\s\S]*?)(?=\n## |$)/);
  if (!m) return 0;
  return (m[1].match(/^- /gm) || []).length;
}

// Pure composer. Inputs are the loaders' shapes: pool = [{id, frontmatter, body}],
// dossiers = [{id, frontmatter, body}], edges = links.json rows, registered = scope slugs.
// Membership sets (not id-keyed records) on purpose: external ids never become object keys
// here, so the check-proto hazard class doesn't apply.
export function composeGraphPayload({ pool, dossiers, edges, registered }) {
  const walledIn = scopeWall(registered);

  // Every passthrough field is type-guarded (fail-soft, §4): YAML happily produces objects
  // and numbers where a string is expected, and one malformed store file must degrade to
  // nulls in the payload, never crash a client that renders the value (legend labels,
  // canvas label.slice — both found by the adversarial round).
  const str = (v) => (typeof v === 'string' ? v : null);
  // Wall semantics per scope VALUE: absent (null/undefined) passes — a legacy node carries
  // no wall to honor; a present-but-malformed scope fails CLOSED — a wall that admits
  // whatever YAML corruption produces is not a wall.
  const walledInRaw = (raw) => (raw == null ? true : typeof raw === 'string' && walledIn(raw));
  const walledInPool = pool.filter((n) => walledInRaw(n.frontmatter.scope));
  const walledInDossiers = dossiers.filter((d) => walledInRaw(d.frontmatter.scope));
  const outNodes = walledInPool.map((n) => ({
    id: n.id,
    title: str(n.frontmatter.title) ?? n.id,
    type: str(n.frontmatter.type),
    pool: poolOf(n),
    claim: str(n.frontmatter.claim),
    scope: str(n.frontmatter.scope),
    provenance: str(n.frontmatter.provenance),
    source: str(n.frontmatter.source),
    centrality: typeof n.frontmatter.centrality === 'number' ? n.frontmatter.centrality : null,
    cluster: str(n.frontmatter.cluster),
    tags: Array.isArray(n.frontmatter.tags) ? n.frontmatter.tags.filter((t) => typeof t === 'string') : [],
    superseded: n.frontmatter.superseded === true,
    srcAnchor: srcAnchorOf(n.frontmatter),
    created: str(n.frontmatter.created),
    updated: str(n.frontmatter.updated),
  }));

  const outDossiers = walledInDossiers.map((d) => ({
    id: d.id,
    title: str(d.frontmatter.title) ?? d.id,
    entityKind: str(d.frontmatter.entity_kind),
    scope: str(d.frontmatter.scope),
    verified: d.frontmatter.verified === true,
    backingSource: str(d.frontmatter.backing_source),
    claimCount: claimCount(d.body),
  }));

  const nodeIds = new Set(outNodes.map((n) => n.id));
  const dossierIds = new Set(outDossiers.map((d) => d.id));
  const live = (ep) =>
    ep !== null && (ep.kind === 'node' ? nodeIds.has(ep.id) : dossierIds.has(ep.id));

  const outEdges = [];
  let droppedEdges = 0;
  for (const e of edges) {
    const a = normalizeEndpoint(e.a);
    const b = normalizeEndpoint(e.b);
    // Both endpoints must be live, walled-in artifacts: a typed non-renderable endpoint, a
    // pruned/missing id, or a walled-out artifact all drop the edge (and bump the counter —
    // the wall and the prune lag stay visible in stats, never silent).
    if (!live(a) || !live(b)) {
      droppedEdges += 1;
      continue;
    }
    outEdges.push({
      a: a.id,
      b: b.id,
      aKind: a.kind,
      bKind: b.kind,
      source: typeof e.source === 'string' ? e.source : null,
      note: typeof e.note === 'string' ? e.note : null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: outNodes,
    dossiers: outDossiers,
    edges: outEdges,
    stats: {
      nodeCount: outNodes.length,
      dossierCount: outDossiers.length,
      edgeCount: outEdges.length,
      srcNodeCount: outNodes.filter((n) => n.srcAnchor).length,
      droppedEdges,
      walledNodes: pool.length - outNodes.length,
      walledDossiers: dossiers.length - outDossiers.length,
    },
  };
}

// Store-backed entry points (what the middleware calls).

// Detail-route wall check against the LIVE registry (same fail-closed semantics as the
// payload wall): the graph hiding a walled node while its detail route serves the full body
// is a cosmetic wall — /__cockpit_node and /__cockpit_dossier both gate through this.
export function walledIn(rawScope) {
  if (rawScope == null) return true;
  return typeof rawScope === 'string' && scopeWall(registeredScopes())(rawScope);
}

export async function graphViewPayload() {
  const [pool, dossiers, edges] = await Promise.all([loadPool(), loadDossiers(), loadLinks()]);
  return composeGraphPayload({ pool, dossiers, edges, registered: registeredScopes() });
}

// One dossier's detail (claims body + audit trail), same wall as the graph. Returns null for
// an unknown or walled-out id — the route turns that into a 404, never a path probe.
export async function dossierViewPayload(id) {
  const dossiers = await loadDossiers();
  const d = dossiers.find((x) => x.id === id);
  if (!d) return null;
  if (!walledIn(d.frontmatter.scope ?? null)) return null;
  return { id: d.id, frontmatter: d.frontmatter, body: d.body };
}
