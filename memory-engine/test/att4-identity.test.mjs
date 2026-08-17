// att4-identity.test.mjs — ATT-4 step 1: item-identity.mjs, the composite identity contract
// (board-rethink-design §5). Authored as the independent test pass; discrimination evidence in
// the pass report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './fixtures.mjs';   // preload guard: dies unless COCKPIT_MEMORY_ROOT is a temp dir

import { canonicalItemText, itemHash, compositeItemKey, tokenSetSimilarity } from '../item-identity.mjs';

// ---------- canonicalItemText ----------

test('canonical: strips unchecked checkbox marker', () => {
  assert.equal(canonicalItemText('- [ ] Do the thing'), 'do the thing');
});

test('canonical: strips checked checkbox marker identically (done state is not identity)', () => {
  assert.equal(canonicalItemText('- [x] Do the thing'), canonicalItemText('- [ ] Do the thing'));
});

test('canonical: strips → pointer segments so identity survives pointer edits', () => {
  const a = canonicalItemText('- [ ] Ship the board → decisions/board-rethink-design.md');
  const b = canonicalItemText('- [ ] Ship the board');
  assert.equal(a, b);
});

test('canonical: mid-text pointer cut ends at comma/semicolon, no stray space before punctuation', () => {
  const got = canonicalItemText('- [ ] Ship it → decisions/x.md, then verify');
  assert.equal(got, 'ship it, then verify');
});

test('canonical: pointer strip eats ONE token only — trailing prose after the pointer stays identity-bearing', () => {
  const a = canonicalItemText('- [ ] Ship the board → decisions/x.md after review');
  const b = canonicalItemText('- [ ] Ship the board after approval');
  assert.notEqual(itemHash(a), itemHash(b), 'items differing only after the pointer token must NOT collide');
  assert.equal(a, 'ship the board after review');
});

test('canonical: pointer-only edits still collide (identity survives repointing)', () => {
  const a = canonicalItemText('- [ ] Ship the board → decisions/x.md');
  const b = canonicalItemText('- [ ] Ship the board → decisions/y.md');
  assert.equal(itemHash(a), itemHash(b));
});

test('canonical: whitespace collapsed, lowercased, trimmed', () => {
  assert.equal(canonicalItemText('  Ship   THE\n  Board  '), 'ship the board');
});

test('canonical: checkbox marker only stripped at the start, not mid-text', () => {
  assert.equal(canonicalItemText('text mentions - [ ] literally'), 'text mentions - [ ] literally');
});

// ---------- itemHash ----------

test('itemHash: 16 lowercase hex chars, deterministic, content-sensitive', () => {
  const h = itemHash('ship the board');
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, itemHash('ship the board'));
  assert.notEqual(h, itemHash('ship the other board'));
});

test('itemHash: known sha256 prefix (first 16 hex of sha256("a"))', () => {
  // sha256("a") = ca978112ca1bbdca...
  assert.equal(itemHash('a'), 'ca978112ca1bbdca');
});

// ---------- compositeItemKey ----------

test('compositeItemKey: same text in two projects of one scope must NOT collide', () => {
  const h = itemHash(canonicalItemText('- [ ] identical task text'));
  const k1 = compositeItemKey('cockpit', 'proj-a', h);
  const k2 = compositeItemKey('cockpit', 'proj-b', h);
  assert.notEqual(k1, k2);
  assert.equal(k1, `cockpit/proj-a/${h}`);
});

test('compositeItemKey: scope also distinguishes', () => {
  const h = itemHash('x');
  assert.notEqual(compositeItemKey('cockpit', 'p', h), compositeItemKey('personal', 'p', h));
});

// ---------- tokenSetSimilarity ----------

test('similarity: identical texts → 1 (through checkbox/case/pointer noise)', () => {
  assert.equal(tokenSetSimilarity('- [ ] Ship The Board → decisions/x.md', 'ship the board'), 1);
});

test('similarity: both empty token sets → 1', () => {
  assert.equal(tokenSetSimilarity('', '   '), 1);
});

test('similarity: one empty set matches nothing → 0', () => {
  assert.equal(tokenSetSimilarity('', 'ship the board'), 0);
});

test('similarity: disjoint sets → 0', () => {
  assert.equal(tokenSetSimilarity('alpha beta', 'gamma delta'), 0);
});

test('similarity: exact Jaccard value on a known overlap (2 shared of 4 union = 0.5)', () => {
  assert.equal(tokenSetSimilarity('one two three', 'two three four'), 0.5);
});

test('similarity: duplicate tokens within one text collapse (set semantics)', () => {
  // multiset would give a different ratio; sets: {go} vs {go stop} = 1/2
  assert.equal(tokenSetSimilarity('go go go go', 'go stop'), 0.5);
});

test('similarity: symmetric', () => {
  const a = 'fix the board comparator now';
  const b = 'fix the feed comparator';
  assert.equal(tokenSetSimilarity(a, b), tokenSetSimilarity(b, a));
});

test('similarity: a checkbox-only line has an empty token set (marker stripped)', () => {
  assert.equal(tokenSetSimilarity('- [ ] ', '- [x] '), 1);
});
