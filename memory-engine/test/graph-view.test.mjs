// graph-view.test.mjs — MEM-39 step 1: the dashboard graph payload composer.
//
// Regression-prone seams pinned here (per the design's review): the scope wall (graphView
// previously leaked unregistered scopes), typed-endpoint normalization (entity:/node: edges
// were silently dropped by the bare-id membership test), and absent-store fail-soft (the
// payload must compose on a fresh clone with no links.json / dossiers dir at all).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  scopeWall,
  normalizeEndpoint,
  claimCount,
  composeGraphPayload,
  graphViewPayload,
  dossierViewPayload,
} from '../graph-view.mjs';
import { writeNode } from '../nodes.mjs';
import { writeDossier } from '../dossiers.mjs';
import { saveLinks } from '../links.mjs';
import { makeNode, TEST_MEMORY_ROOT } from './fixtures.mjs';

// ---- normalizeEndpoint ----

test('normalizeEndpoint: bare id is an implicit node', () => {
  assert.deepEqual(normalizeEndpoint('some-node'), { kind: 'node', id: 'some-node' });
});

test('normalizeEndpoint: node: and entity: prefixes resolve to their kinds', () => {
  assert.deepEqual(normalizeEndpoint('node:a-node'), { kind: 'node', id: 'a-node' });
  assert.deepEqual(normalizeEndpoint('entity:fal-ai'), { kind: 'dossier', id: 'fal-ai' });
});

test('normalizeEndpoint: non-renderable typed endpoints and junk return null', () => {
  for (const raw of ['insight:x', 'skill:watch', 'mcp:tool', 'proposal:dead', '', null, 7]) {
    assert.equal(normalizeEndpoint(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

// ---- scopeWall ----

test('scopeWall: registered in, unregistered out, global and absent always in', () => {
  const walledIn = scopeWall(['cockpit', 'personal']);
  assert.equal(walledIn('cockpit'), true);
  assert.equal(walledIn('demo'), false);
  assert.equal(walledIn('global'), true);
  assert.equal(walledIn(null), true);
  assert.equal(walledIn(undefined), true);
});

// ---- claimCount ----

test('claimCount: counts bullets under ## Claims only, stopping at the next heading', () => {
  const body = '## Claims\n\n- one (src:a)\n- two (src:a)\n\n## Audit trail\n\n- 2026-07-29: minted';
  assert.equal(claimCount(body), 2);
  assert.equal(claimCount('no claims heading\n- stray bullet'), 0);
  assert.equal(claimCount(''), 0);
});

// ---- composeGraphPayload (pure) ----

const fixtureInputs = () => ({
  pool: [
    makeNode({ id: 'lib-node', type: 'knowledge', claim: 'reported', provenance: 'relayed', citation: 'src:a-source', centrality: 0.7 }),
    makeNode({ id: 'beh-node', type: 'feedback', provenance: 'authored', centrality: 0.9 }),
    makeNode({ id: 'walled-node', scope: 'demo' }),
    makeNode({ id: 'dead-node', superseded: true }),
  ],
  dossiers: [
    { id: 'fal-ai', frontmatter: { id: 'fal-ai', title: 'fal.ai', entity_kind: 'organization', scope: 'cockpit', verified: false, backing_source: 'fallback' }, body: '## Claims\n\n- claim (src:a-source)\n' },
    { id: 'walled-dossier', frontmatter: { id: 'walled-dossier', title: 'walled', scope: 'demo' }, body: '' },
  ],
  edges: [
    { a: 'beh-node', b: 'lib-node', source: 'dreaming', note: 'why they relate' },
    { a: 'entity:fal-ai', b: 'node:lib-node', source: 'entity-backing-link', note: 'backing' },
    { a: 'lib-node', b: 'walled-node', source: 'dreaming', note: '' },
    { a: 'insight:card', b: 'lib-node', source: 'manual', note: '' },
    { a: 'lib-node', b: 'gone-node', source: 'dreaming', note: '' },
  ],
  registered: ['cockpit'],
});

test('compose: scope wall drops walled artifacts and counts them in stats', () => {
  const p = composeGraphPayload(fixtureInputs());
  assert.deepEqual(p.nodes.map((n) => n.id).sort(), ['beh-node', 'dead-node', 'lib-node']);
  assert.deepEqual(p.dossiers.map((d) => d.id), ['fal-ai']);
  assert.equal(p.stats.walledNodes, 1);
  assert.equal(p.stats.walledDossiers, 1);
});

test('compose: pool is derived per node, trust and claim fields are carried', () => {
  const p = composeGraphPayload(fixtureInputs());
  const lib = p.nodes.find((n) => n.id === 'lib-node');
  const beh = p.nodes.find((n) => n.id === 'beh-node');
  assert.equal(lib.pool, 'library');
  assert.equal(beh.pool, 'behavioral');
  assert.equal(lib.provenance, 'relayed');
  assert.equal(lib.claim, 'reported');
  assert.equal(lib.srcAnchor, 'a-source');
  assert.equal(beh.srcAnchor, null);
});

test('compose: superseded nodes are flagged, never dropped', () => {
  const p = composeGraphPayload(fixtureInputs());
  const dead = p.nodes.find((n) => n.id === 'dead-node');
  assert.ok(dead);
  assert.equal(dead.superseded, true);
});

test('compose: bare and typed live edges pass with endpoint kinds and metadata', () => {
  const p = composeGraphPayload(fixtureInputs());
  const bare = p.edges.find((e) => e.a === 'beh-node');
  assert.deepEqual(bare, { a: 'beh-node', b: 'lib-node', aKind: 'node', bKind: 'node', source: 'dreaming', note: 'why they relate' });
  const backing = p.edges.find((e) => e.aKind === 'dossier');
  assert.deepEqual(backing, { a: 'fal-ai', b: 'lib-node', aKind: 'dossier', bKind: 'node', source: 'entity-backing-link', note: 'backing' });
});

test('compose: walled, non-renderable, and dead endpoints drop their edges and are counted', () => {
  const p = composeGraphPayload(fixtureInputs());
  assert.equal(p.edges.length, 2);
  assert.equal(p.stats.droppedEdges, 3); // walled-node edge, insight: edge, gone-node edge
});

test('compose: stats reflect the walled-in view', () => {
  const p = composeGraphPayload(fixtureInputs());
  assert.equal(p.stats.nodeCount, 3);
  assert.equal(p.stats.dossierCount, 1);
  assert.equal(p.stats.edgeCount, 2);
  assert.equal(p.stats.srcNodeCount, 1);
});

test('compose: empty store composes an empty payload, never throws', () => {
  const p = composeGraphPayload({ pool: [], dossiers: [], edges: [], registered: [] });
  assert.deepEqual(p.nodes, []);
  assert.deepEqual(p.dossiers, []);
  assert.deepEqual(p.edges, []);
  assert.equal(p.stats.droppedEdges, 0);
});

// ---- store-backed entry points (real loaders against the temp root) ----

test('graphViewPayload: walls and normalizes through the real store', async () => {
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(['cockpit']), 'utf8');
  await mkdir(resolve(TEST_MEMORY_ROOT, 'knowledge', 'nodes'), { recursive: true });
  await writeNode(makeNode({ id: 'gv-live', type: 'feedback', provenance: 'authored' }));
  await writeNode(makeNode({ id: 'gv-walled', scope: 'demo' }));
  await writeDossier({ id: 'gv-dossier', frontmatter: { artifact: 'dossier', id: 'gv-dossier', title: 'GV', entity_kind: 'concept', scope: 'cockpit', verified: false, backing_source: 'fallback', claim: 'compilation' }, body: '## Claims\n\n- c (src:x)\n' });
  await saveLinks([
    { a: 'entity:gv-dossier', b: 'node:gv-live', source: 'entity-backing-link', note: 'n', created: '2026-07-29T00:00:00.000Z' },
    { a: 'gv-live', b: 'gv-walled', source: 'dreaming', note: '', created: '2026-07-29T00:00:00.000Z' },
  ]);
  const p = await graphViewPayload();
  assert.ok(p.nodes.some((n) => n.id === 'gv-live'));
  assert.ok(!p.nodes.some((n) => n.id === 'gv-walled'));
  assert.deepEqual(p.dossiers.map((d) => d.id), ['gv-dossier']);
  assert.equal(p.edges.length, 1);
  assert.equal(p.edges[0].aKind, 'dossier');
  assert.equal(p.stats.droppedEdges, 1);
  assert.equal(typeof p.generatedAt, 'string');
});

test('compose: malformed frontmatter degrades to nulls, never non-string passthrough', () => {
  const p = composeGraphPayload({
    pool: [
      makeNode({ id: 'mangled', title: 2024, type: { a: 1 }, claim: 7, cluster: ['x'], tags: ['ok', 3, null] }),
    ],
    dossiers: [
      { id: 'mangled-d', frontmatter: { id: 'mangled-d', title: { t: 1 }, entity_kind: 9, scope: 'cockpit' }, body: '' },
    ],
    edges: [],
    registered: ['cockpit'],
  });
  const n = p.nodes[0];
  assert.equal(n.title, 'mangled'); // falls back to id, never a number
  assert.equal(n.type, null);
  assert.equal(n.claim, null);
  assert.equal(n.cluster, null);
  assert.deepEqual(n.tags, ['ok']);
  assert.equal(p.dossiers[0].title, 'mangled-d');
  assert.equal(p.dossiers[0].entityKind, null);
});

test('compose: a present-but-malformed scope fails CLOSED at the wall', () => {
  const p = composeGraphPayload({
    pool: [makeNode({ id: 'bad-scope', scope: { walled: 'maybe' } })],
    dossiers: [],
    edges: [],
    registered: ['cockpit'],
  });
  assert.deepEqual(p.nodes, []);
  assert.equal(p.stats.walledNodes, 1);
});

test('walledIn: registered and absent pass, unregistered and malformed fail', async () => {
  const { walledIn } = await import('../graph-view.mjs');
  assert.equal(walledIn('cockpit'), true);
  assert.equal(walledIn(null), true);
  assert.equal(walledIn(undefined), true);
  assert.equal(walledIn('demo'), false);
  assert.equal(walledIn({ scope: 'cockpit' }), false);
});

test('dossierViewPayload: serves walled-in, nulls unknown and walled-out', async () => {
  const served = await dossierViewPayload('gv-dossier');
  assert.equal(served.frontmatter.title, 'GV');
  assert.match(served.body, /## Claims/);
  assert.equal(await dossierViewPayload('no-such-dossier'), null);
  await writeDossier({ id: 'gv-walled-d', frontmatter: { artifact: 'dossier', id: 'gv-walled-d', title: 'W', scope: 'demo', claim: 'compilation' }, body: '' });
  assert.equal(await dossierViewPayload('gv-walled-d'), null);
});
