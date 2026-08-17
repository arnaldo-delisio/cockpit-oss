// harness.test.mjs — smoke test: the fixture pool is readable by the real engine.
// The invariant matrix lands in later files; this only proves the harness works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, makeNode, writePool, TEST_MEMORY_ROOT } from './fixtures.mjs';

test('fixture pool round-trips through the real loadPool', async () => {
  assert.equal(engine.MEMORY_ROOT, TEST_MEMORY_ROOT);  // never the real memory repo

  await writePool([
    { id: 'fixture-identity', type: 'identity', claim: 'preference', scope: 'cockpit' },
    { id: 'fixture-feedback', type: 'feedback', claim: 'principle', scope: 'writing', centrality: 0.9 },
    { id: 'fixture-fact', type: 'knowledge', claim: 'fact', citation: 'DECISIONS.md#MEM-38' },
  ]);

  const pool = await engine.loadPool();
  assert.equal(pool.length, 3);

  const fact = pool.find(n => n.id === 'fixture-fact');
  assert.equal(fact.frontmatter.citation, 'DECISIONS.md#MEM-38');
  assert.equal(fact.frontmatter.source, 'capture');  // loadPool's provenance default
  assert.equal(fact.prose, fact.body);
  assert.equal(pool.find(n => n.id === 'fixture-feedback').frontmatter.centrality, 0.9);
});

// The suite must be runnable offline (Codex review 2026-07-25): setup.mjs disables both model
// sources, so ANY test reaching embed() fails fast instead of downloading/loading the model. This
// asserts the guard is actually in force — importing retrieval.mjs is model-free by itself.
test('offline guard: no test can load an embedding model', async () => {
  const { embed } = await import('../retrieval.mjs');
  await assert.rejects(() => embed(['a text to embed']), /disabled/);
});

test('serializeNode/parseNode preserve fields and canonical order', () => {
  const node = makeNode({ id: 'fixture-order', title: 'Fixture Order', claim: 'fact', citation: 'src.md' });
  const parsed = engine.parseNode(engine.serializeNode(node), node.id);
  assert.deepEqual(parsed.frontmatter, node.frontmatter);
  assert.equal(parsed.body, node.body);
  const keys = Object.keys(parsed.frontmatter);
  const ranks = keys.map(k => engine.FIELD_ORDER.indexOf(k));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});
