// links-prune.test.mjs — MEM-38 step 8 cut 2 regression: proposal: endpoints are dead.
//
// The harness-proposals store was removed (ATT-3), so links.mjs prune()'s isLive returns
// false for any `proposal:` endpoint: an edge with proposal: on either side is pruned
// unconditionally, with no opts set involved. Controls: a bare-id edge between two live
// nodes survives, and an mcp: endpoint is always live in v1. Pure unit test of prune(),
// no filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prune, addEdge, edgeKey } from '../links.mjs';

const mk = (a, b) => {
  const edges = [];
  addEdge(edges, a, b, { source: 'manual' });
  return edges;
};

test('prune drops an edge whose endpoint a is proposal:', () => {
  // edgeKey sorts endpoints, so pick ids where the proposal: side lands in slot a.
  const edges = mk('proposal:p1', 'zzz-live');
  assert.equal(edges[0].a, 'proposal:p1');
  const removed = prune(edges, ['zzz-live']);
  assert.equal(edges.length, 0);
  assert.equal(removed.length, 1);
  assert.equal(edgeKey(removed[0].a, removed[0].b), edgeKey('proposal:p1', 'zzz-live'));
});

test('prune drops an edge whose endpoint b is proposal:', () => {
  const edges = mk('aaa-live', 'proposal:p2');
  assert.equal(edges[0].b, 'proposal:p2');
  const removed = prune(edges, ['aaa-live']);
  assert.equal(edges.length, 0);
  assert.equal(removed.length, 1);
});

test('prune keeps a bare-id edge between two live nodes', () => {
  const edges = mk('alpha', 'beta');
  const removed = prune(edges, ['alpha', 'beta']);
  assert.equal(removed.length, 0);
  assert.equal(edges.length, 1);
});

test('prune keeps an mcp: endpoint (always live in v1)', () => {
  const edges = mk('alpha', 'mcp:some-tool');
  const removed = prune(edges, ['alpha']);
  assert.equal(removed.length, 0);
  assert.equal(edges.length, 1);
});
