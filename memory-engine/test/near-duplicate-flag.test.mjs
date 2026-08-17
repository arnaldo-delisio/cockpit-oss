// near-duplicate-flag.test.mjs — the write-time near-duplicate flag (reconcile.mjs
// findNearDuplicates + NEAR_DUPLICATE_COSINE).
//
// Scope: the LOWER band only — the pairs the run reports and does not act on. The automatic merge
// above NEAR_DUPLICATE_MERGE_COSINE lives in near-duplicate-merge.test.mjs.
//
// What this exists to catch: in this band the check must only look. MEM-27 removed the cosine→merge
// mint path on the measured finding that cosine cannot separate same-rule from different-rule, and
// this band is where that still binds, so a regression that let it fold, supersede, or block a mint
// here would reinstate exactly what was rejected. Assertions therefore also check the pool came back
// untouched.
//
// Angles are chosen to land INSIDE the reported band (0.85 to 0.95, i.e. roughly 20° to 32° apart), so
// the cases mirror what production actually flags. The two multi-mint arithmetic cases at the bottom
// are the exception and say so: ten pairs cannot all sit inside that band in any geometry, and what
// they pin is the cap-and-dedupe counting, which takes its threshold as a parameter.
//
// Vectors are hand-built unit vectors written straight into a real EmbeddingCache, so the cosines are
// exact and no model loads: embed() is offline-rejected in this suite by design (test/setup.mjs), and
// a test that needed the real encoder would be testing the encoder, not the flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingCache, contentHash } from '../retrieval.mjs';
import { findNearDuplicates, NEAR_DUPLICATE_COSINE, NEAR_DUPLICATE_MAX_PAIRS } from '../reconcile.mjs';
import { makeNode } from './fixtures.mjs';

// a 2-D unit vector at `deg` degrees, zero-padded to the real 384 dims. cos(a,b) = cos(a_deg - b_deg),
// so a pair's similarity is stated directly by the angle between them.
function vecAt(deg) {
  const v = new Float32Array(384);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
}

// pool node + its cache entry, keyed on the SAME contentHash(prose) the reader uses.
function seed(cache, { id, deg, scope = 'cockpit', title = id }) {
  const node = makeNode({ id, title, scope, body: `Prose for ${id}.` });
  node.prose = node.body;
  cache.set(id, contentHash(node.prose), vecAt(deg));
  return node;
}

function setup(specs) {
  const cache = new EmbeddingCache('/dev/null/unused');
  const pool = specs.map((s) => seed(cache, s));
  return { cache, pool, snapshot: JSON.stringify(pool) };
}

test('a mint above the threshold is flagged against its nearest live neighbor', () => {
  // 25° apart ⇒ cosine 0.906: inside the reported band, below the merge line.
  const { cache, pool, snapshot } = setup([
    { id: 'twin-old', deg: 0, title: 'Operator identity' },
    { id: 'twin-new', deg: 25, title: 'Founder identity' },
    { id: 'unrelated', deg: 80 },
  ]);

  const { pairs, unchecked } = findNearDuplicates(['twin-new'], pool, cache);

  assert.equal(unchecked.length, 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].id, 'twin-new');
  assert.equal(pairs[0].nearest, 'twin-old');
  assert.equal(pairs[0].nearestTitle, 'Operator identity');
  assert.ok(pairs[0].score > NEAR_DUPLICATE_COSINE, `score ${pairs[0].score}`);
  // flag only: nothing merged, nothing superseded, nothing dropped.
  assert.equal(JSON.stringify(pool), snapshot);
});

test('a mint below the threshold is not flagged', () => {
  // 40° apart ⇒ cosine 0.766: a real near-neighbor, still under the flag line.
  const { cache, pool } = setup([
    { id: 'existing', deg: 0 },
    { id: 'fresh', deg: 40 },
  ]);

  const { pairs, unchecked } = findNearDuplicates(['fresh'], pool, cache);

  assert.deepEqual(pairs, []);
  assert.deepEqual(unchecked, []);
});

test('the flag crosses scopes — the gap per-scope consolidation cannot see', () => {
  const { cache, pool } = setup([
    { id: 'cockpit-node', deg: 0, scope: 'cockpit' },
    { id: 'studio-node', deg: 25, scope: 'studio' },
  ]);

  const { pairs } = findNearDuplicates(['studio-node'], pool, cache);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].scope, 'studio');
  assert.equal(pairs[0].nearestScope, 'cockpit');
});

test('two mints of the same run that flag each other report one pair, not two', () => {
  const { cache, pool } = setup([
    { id: 'mint-a', deg: 0 },
    { id: 'mint-b', deg: 25 },
  ]);

  const { pairs } = findNearDuplicates(['mint-a', 'mint-b'], pool, cache);

  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].id, pairs[0].nearest].sort(), ['mint-a', 'mint-b']);
});

test('a superseded neighbor is not a duplicate', () => {
  const { cache, pool } = setup([
    { id: 'dead-twin', deg: 0 },
    { id: 'fresh', deg: 25 },
  ]);
  pool[0].frontmatter.superseded = true;

  const { pairs } = findNearDuplicates(['fresh'], pool, cache);

  assert.deepEqual(pairs, []);
});

test('a mint with no usable vector reports as unchecked, never as clean', () => {
  const { cache, pool } = setup([
    { id: 'existing', deg: 0 },
    { id: 'stale', deg: 25 },
  ]);
  // stale cache entry: the id is present but its hash no longer matches the prose, which is exactly
  // what cache.get() rejects. A silent skip here would read as "checked, no duplicate found".
  cache.set('stale', 'not-the-current-hash', vecAt(25));

  const { pairs, unchecked } = findNearDuplicates(['stale'], pool, cache);

  assert.deepEqual(pairs, []);
  assert.deepEqual(unchecked, ['stale']);
});

test('a mint in a family of twins reports every neighbor over the line, not just the closest', () => {
  // three live restatements, each in the reported band from the mint, plus one unrelated node.
  const { cache, pool } = setup([
    { id: 'variant-a', deg: 22 },
    { id: 'variant-b', deg: 25 },
    { id: 'variant-c', deg: 28 },
    { id: 'unrelated', deg: 80 },
    { id: 'fresh', deg: 0 },
  ]);

  const { pairs } = findNearDuplicates(['fresh'], pool, cache);

  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs.map((p) => p.nearest).sort(), ['variant-a', 'variant-b', 'variant-c']);
  assert.ok(pairs.every((p) => p.id === 'fresh' && !p.more));
});

test('past the per-mint cap the overflow is stated, never silently dropped', () => {
  // five neighbors spread across the reported band (0.927 down to 0.866), cap is three.
  const family = Array.from({ length: NEAR_DUPLICATE_MAX_PAIRS + 2 }, (_, i) => ({ id: `variant-${i}`, deg: 22 + i * 2 }));
  const { cache, pool } = setup([...family, { id: 'fresh', deg: 0 }]);

  const { pairs } = findNearDuplicates(['fresh'], pool, cache);

  assert.equal(pairs.length, NEAR_DUPLICATE_MAX_PAIRS);
  // all five sit inside the band, so two are over the cap and must be counted, not dropped.
  assert.ok(pairs.every((p) => p.more === 2), JSON.stringify(pairs.map((p) => p.more)));
});

test('a family of mints over the cap loses no relationship to the dedupe (Codex round 2)', () => {
  // Five mutually similar nodes, all minted this run: 10 unordered pairs, every one over the flag
  // line. Deliberately tighter than the reported band — no arrangement puts ten pairs inside a
  // 0.85-to-0.95 window — because what is under test here is the counting, not the band.

  // The per-mint cap is 3, so the run reports 3 + 3 + 3 + 1 = 10 only if the dedupe is applied BEFORE
  // the cap. Capping first would let the fourth mint spend its slice on pairs already reported and
  // drop its relationship to the fifth entirely.
  const ids = ['m0', 'm1', 'm2', 'm3', 'm4'];
  const { cache, pool } = setup(ids.map((id, i) => ({ id, deg: i })));

  const { pairs } = findNearDuplicates(ids, pool, cache);

  const reported = new Set(pairs.map((p) => JSON.stringify([p.id, p.nearest].sort())));
  const expected = new Set();
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expected.add(JSON.stringify([ids[i], ids[j]]));
  assert.equal(pairs.length, reported.size, 'a pair was reported twice');
  assert.deepEqual([...reported].sort(), [...expected].sort());
  // every pair was ultimately reported, so no entry may claim an unreported neighbor: a pair one
  // mint's cap discarded gets emitted from the other end later (Codex review round 3).
  assert.deepEqual(pairs.filter((p) => p.more), []);
});

test('a node is never its own duplicate', () => {
  const { cache, pool } = setup([{ id: 'lonely', deg: 0 }]);

  const { pairs, unchecked } = findNearDuplicates(['lonely'], pool, cache);

  assert.deepEqual(pairs, []);
  assert.deepEqual(unchecked, []);
});
