// near-duplicate-merge.test.mjs — the automatic half of the write-time duplicate check
// (reconcile.mjs mergeNearDuplicates + NEAR_DUPLICATE_MERGE_COSINE).
//
// Operator decision 2026-08-15: above 0.95 the run stops asking and folds the duplicate away itself.
// The whole safety of that rests on WHICH node survives and on nothing being deleted — the older node
// keeps its prose untouched, the mint's evidence folds into it, and the mint is superseded, not
// removed, so git is the undo. Every test below therefore asserts the survivor's prose is byte-identical
// afterwards and that the absorbed node still exists.
//
// Same hand-built unit vectors as near-duplicate-flag.test.mjs: exact cosines, no model load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingCache, contentHash } from '../retrieval.mjs';
import {
  mergeNearDuplicates, findNearDuplicates, NEAR_DUPLICATE_MERGE_COSINE, NEAR_DUPLICATE_COSINE,
} from '../reconcile.mjs';
import { makeNode } from './fixtures.mjs';

function vecAt(deg) {
  const v = new Float32Array(384);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
}

function setup(specs) {
  const cache = new EmbeddingCache('/dev/null/unused');
  const pool = specs.map(({ id, deg, title = id, ...rest }) => {
    const node = makeNode({ id, title, body: `Prose for ${id}.`, ...rest });
    node.prose = node.body;
    cache.set(id, contentHash(node.prose), vecAt(deg));
    return node;
  });
  const byId = new Map(pool.map((n) => [n.id, n]));
  const audit = { added: [], modified: [], superseded: [], held: [], autoApplied: [] };
  return { cache, pool, byId, audit };
}

// 10° ⇒ 0.985 (over the merge line); 25° ⇒ 0.906 (in the flag band); 40° ⇒ 0.766 (below both).
const OVER_MERGE = 10, IN_FLAG_BAND = 25, BELOW_BOTH = 40;

test('a mint over the merge line is folded into the older node, which keeps its prose', async () => {
  const { cache, pool, byId, audit } = setup([
    { id: 'older', deg: 0, title: 'Operator identity', tags: ['identity'] },
    { id: 'mint', deg: OVER_MERGE, title: 'Founder identity', tags: ['founder'], citation: 'stg:sess-x:abc12345' },
  ]);
  const proseBefore = byId.get('older').prose;

  await mergeNearDuplicates(['mint'], pool, cache, byId, audit);

  assert.equal(audit.nearDuplicateMerged.length, 1);
  assert.deepEqual(
    { id: audit.nearDuplicateMerged[0].id, into: audit.nearDuplicateMerged[0].into },
    { id: 'mint', into: 'older' },
  );
  assert.ok(audit.nearDuplicateMerged[0].score >= NEAR_DUPLICATE_MERGE_COSINE);

  // the older node survives, wording untouched, with the mint's evidence folded in.
  assert.equal(byId.get('older').prose, proseBefore);
  assert.equal(byId.get('older').frontmatter.superseded, undefined);
  assert.deepEqual(byId.get('older').frontmatter.tags.sort(), ['founder', 'identity']);
  assert.equal(byId.get('older').frontmatter.citation, 'stg:sess-x:abc12345');

  // the duplicate is retired, NOT deleted — that is what makes acting automatically reversible.
  assert.equal(byId.get('mint').frontmatter.superseded, true);
  assert.ok(pool.some((n) => n.id === 'mint'), 'the absorbed node was removed from the pool');
  assert.deepEqual(audit.superseded.map((x) => x.id), ['mint']);
});

test('a mint in the flag band is left alone for the human', async () => {
  const { cache, pool, byId, audit } = setup([
    { id: 'older', deg: 0 },
    { id: 'mint', deg: IN_FLAG_BAND },
  ]);

  await mergeNearDuplicates(['mint'], pool, cache, byId, audit);

  assert.deepEqual(audit.nearDuplicateMerged, []);
  assert.equal(byId.get('mint').frontmatter.superseded, undefined);
  // ...and it is the flag pass that picks it up instead.
  const { pairs } = findNearDuplicates(['mint'], pool, cache);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].score >= NEAR_DUPLICATE_COSINE && pairs[0].score < NEAR_DUPLICATE_MERGE_COSINE);
});

test('a mint below both lines is neither merged nor flagged', async () => {
  const { cache, pool, byId, audit } = setup([
    { id: 'older', deg: 0 },
    { id: 'mint', deg: BELOW_BOTH },
  ]);

  await mergeNearDuplicates(['mint'], pool, cache, byId, audit);
  const { pairs } = findNearDuplicates(['mint'], pool, cache);

  assert.deepEqual(audit.nearDuplicateMerged, []);
  assert.deepEqual(pairs, []);
});

test('when both twins are mints of the same run, the earlier one survives', async () => {
  const { cache, pool, byId, audit } = setup([
    { id: 'zzz-first-minted', deg: 0 },
    { id: 'aaa-second-minted', deg: OVER_MERGE },
  ]);

  // mint order, NOT id order: ids are alphabetically reversed here so a stray sort would be visible.
  await mergeNearDuplicates(['zzz-first-minted', 'aaa-second-minted'], pool, cache, byId, audit);

  assert.equal(audit.nearDuplicateMerged.length, 1);
  assert.equal(audit.nearDuplicateMerged[0].into, 'zzz-first-minted');
  assert.equal(byId.get('aaa-second-minted').frontmatter.superseded, true);
  assert.equal(byId.get('zzz-first-minted').frontmatter.superseded, undefined);
});

test('a family of three mints collapses onto one survivor, not into a chain', async () => {
  const ids = ['m0', 'm1', 'm2'];
  const { cache, pool, byId, audit } = setup(ids.map((id, i) => ({ id, deg: i * 4 })));

  await mergeNearDuplicates(ids, pool, cache, byId, audit);

  // every merge must land on the SAME live survivor: re-ranking per mint is what stops m1 being
  // folded into m0 and then m2 being folded into the now-superseded m1.
  assert.equal(audit.nearDuplicateMerged.length, 2);
  assert.deepEqual([...new Set(audit.nearDuplicateMerged.map((m) => m.into))], ['m0']);
  assert.deepEqual(pool.filter((n) => !n.frontmatter.superseded).map((n) => n.id), ['m0']);
});

test('an already-absorbed mint is not merged again', async () => {
  const { cache, pool, byId, audit } = setup([
    { id: 'older', deg: 0 },
    { id: 'mint', deg: OVER_MERGE },
  ]);

  // the same id twice in the mint list. Two things independently prevent a second merge — the explicit
  // superseded skip, and the fact that a superseded node has no live vector to score — so this pins the
  // OUTCOME rather than either guard: no single-line mutation fails it, removing both does.
  await mergeNearDuplicates(['mint', 'mint'], pool, cache, byId, audit);

  assert.equal(audit.nearDuplicateMerged.length, 1);
  assert.equal(audit.superseded.length, 1);
});
