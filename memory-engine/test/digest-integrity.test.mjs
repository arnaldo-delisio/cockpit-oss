// digest-integrity.test.mjs — MEM-38 step 4 gate, READ side: what buildDigest lets through.
//
// Two properties here are silent failures, which is why they get direct assertions rather than
// riding along inside a mint test:
//   1. harness scaffolding must not survive INTO turnIndex. It used to reach the mint path inside a
//      turn stamped `claude:typed`, i.e. the graph's own recall prose re-read as human-authored;
//   2. turnIndex keys must stay the ORIGINAL turn indices. The distiller writes `source_turns` as
//      `[Tn]` ids taken from the digest text, and reconcile.mjs resolves them by that number — a
//      renumber after a dropped turn would silently re-point every citation at a NEIGHBOURING turn,
//      producing a perfectly well-formed node that cites words nobody said.
//
// Plus the two cases test/fixtures.mjs's old dense-array turnIndex made unreachable: a `source_turns`
// ref to a turn the digest dropped, and one to a turn DIGEST_TURN_CAP truncated away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProposal } from './fixtures.mjs';

const RECALL = '<!-- cockpit:recall:begin v1 -->\nRelevant memory: [[some-node]] says a thing.\n<!-- cockpit:recall:end -->';

// a parsed staging turn in the shape parseStaging emits (buildDigest's only input).
const turn = (role, text, { tags = [], via = null } = {}) => ({ role, tags, text, ts: null, via });

const newAudit = () => ({ added: [], modified: [], superseded: [], held: [], autoApplied: [], unmentioned: [], reflectSkipped: [], clamped: [] });
async function mint(proposal) {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const pool = [];
  await applyConsolidation([{ action: 'new', backing: [proposal.idx ?? 0], centrality: 0.5, cluster: proposal.cluster }],
    [proposal], [], 'cockpit', pool, new Set(), newAudit());
  return pool;
}

// ---------------------------------------------------------------- harness stripping before selection

test('a turn that is ENTIRELY an ambient-recall block leaves both the digest and turnIndex', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  const { digest, turnIndex } = buildDigest([
    turn('user', 'Ship the gate today.', { tags: ['decision'], via: 'claude:typed' }),
    turn('user', RECALL, { tags: ['keep'], via: 'claude:typed' }),
    turn('assistant', 'On it.', { tags: ['keep'] }),
  ]);
  assert.deepEqual(Object.keys(turnIndex), ['0', '2'], 'the pure-scaffolding turn must not be indexable at all');
  assert.equal(turnIndex[1], undefined);
  assert.doesNotMatch(digest, /cockpit:recall/);
  assert.doesNotMatch(digest, /some-node/);
  assert.doesNotMatch(digest, /\[T1\]/);
});

test('a turn MIXING human text with a recall block keeps the human text in turnIndex, not just in the digest', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  const { digest, turnIndex } = buildDigest([
    turn('user', `${RECALL}\n\nNo, that is not what I meant.`, { tags: ['#bad', 'correction'], via: 'claude:typed' }),
  ]);
  assert.equal(turnIndex[0].text, 'No, that is not what I meant.');
  assert.equal(turnIndex[0].via, 'claude:typed');       // stripping must not cost the channel
  assert.doesNotMatch(digest, /cockpit:recall/);
  assert.match(digest, /No, that is not what I meant\./);
});

test('a system-reminder-only turn drops, and a mixed one keeps only the human half', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  const { turnIndex } = buildDigest([
    turn('user', '<system-reminder>Contents of CLAUDE.md …</system-reminder>', { tags: ['keep'] }),
    turn('user', 'Lock the decision. <system-reminder>noise</system-reminder>', { tags: ['decision'] }),
    turn('user', '<local-command-stdout>on branch port</local-command-stdout>', { tags: ['keep'] }),
  ]);
  assert.deepEqual(Object.keys(turnIndex), ['1']);
  assert.equal(turnIndex[1].text, 'Lock the decision.');
});

// THE off-by-one assertion: the highest-value one in this file.
test('turnIndex keys stay the ORIGINAL turn indices after stripping drops turns', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  const turns = [
    turn('user', RECALL, { tags: ['keep'] }),                       // 0 — drops
    turn('user', 'FIRST real turn.', { tags: ['decision'] }),        // 1
    turn('user', RECALL, { tags: ['keep'] }),                       // 2 — drops
    turn('user', '<system-reminder>x</system-reminder>', { tags: ['keep'] }),  // 3 — drops
    turn('user', 'SECOND real turn.', { tags: ['decision'] }),       // 4
  ];
  const { digest, turnIndex } = buildDigest(turns);
  assert.deepEqual(Object.keys(turnIndex), ['1', '4']);
  assert.equal(turnIndex[1].text, 'FIRST real turn.');
  assert.equal(turnIndex[4].text, 'SECOND real turn.');
  // the digest's [Tn] labels are what the distiller copies into source_turns — they must agree.
  assert.match(digest, /\[T1\] \(user\).*FIRST real turn\./);
  assert.match(digest, /\[T4\] \(user\).*SECOND real turn\./);
  assert.doesNotMatch(digest, /\[T0\]|\[T2\]|\[T3\]/);
});

test('the safety-net sweep also judges emptiness AFTER stripping (a scaffolding-only user turn is not a sample)', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  // no tags anywhere -> keep.size 0 -> the `role === 'user' && stripped[i]` sweep runs.
  const { turnIndex } = buildDigest([
    turn('user', RECALL),
    turn('user', 'A real question.'),
    turn('assistant', 'A real answer.'),
  ]);
  assert.deepEqual(Object.keys(turnIndex), ['1']);
});

// ---------------------------------------------------------------- source_turns pointing at nothing

test('a source_turns ref to a turn the digest DROPPED degrades: no citation, inferred, no tier invented', async () => {
  // exactly what the distiller can produce: it sees [T0] and [T2] and writes "#1" (a stale id, a
  // renumbering mistake, or a hallucinated one). turnIndex[1] is undefined.
  const pool = await mint(makeProposal({
    turnIndex: { 0: { text: 'Kept turn zero.', via: 'claude:typed' }, 2: { text: 'Kept turn two.', via: 'claude:typed' } },
    source_turns: ['#1'],
  }));
  assert.equal(pool.length, 1, 'the mint must still happen — a dangling ref is not a crash');
  const fm = pool[0].frontmatter;
  assert.equal(fm.citation, undefined);
  assert.equal(fm.claim, 'inference');
  assert.equal(fm.provenance, 'inferred');
  assert.equal(fm.provenance_via, undefined);          // never a tier borrowed from a sibling turn
});

test('a dangling ref does not borrow the channel of a turn that IS present', async () => {
  const pool = await mint(makeProposal({
    turnIndex: { 5: { text: 'A typed turn nobody cited.', via: 'claude:typed' } },
    source_turns: ['#4'],
  }));
  assert.equal(pool[0].frontmatter.provenance, 'inferred');
  assert.equal(pool[0].frontmatter.citation, undefined);
});

test('a mix of a dangling and a live ref resolves through the live one', async () => {
  const pool = await mint(makeProposal({
    turnIndex: { 7: { text: 'The real referent.', via: 'subagent' } },
    source_turns: ['#3', '#7'],
  }));
  assert.match(pool[0].frontmatter.citation, /^stg:sessions\/2026-07-25:[0-9a-f]{8}$/);
  assert.equal(pool[0].frontmatter.provenance, 'relayed');
});

// ---------------------------------------------------------------- DIGEST_TURN_CAP

test('DIGEST_TURN_CAP: the first 80 selected turns survive into turnIndex and the rest vanish', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  const turns = Array.from({ length: 100 }, (_, i) => turn('user', `Turn number ${i}.`, { tags: ['decision'], via: 'claude:typed' }));
  const { digest, turnIndex } = buildDigest(turns);
  const keys = Object.keys(turnIndex).map(Number);
  assert.equal(keys.length, 80);
  assert.deepEqual(keys, Array.from({ length: 80 }, (_, i) => i));   // the CAP truncates the TAIL
  assert.equal(turnIndex[79].text, 'Turn number 79.');
  assert.equal(turnIndex[80], undefined);
  assert.match(digest, /\[T79\]/);
  assert.doesNotMatch(digest, /\[T80\]/);
});

test('DIGEST_TURN_CAP truncation interacts with stripping: dropped turns do not consume cap slots', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  // turns 0..9 are pure scaffolding; the cap should therefore reach original index 89, not 79.
  const turns = Array.from({ length: 100 }, (_, i) =>
    turn('user', i < 10 ? RECALL : `Turn number ${i}.`, { tags: ['decision'] }));
  const keys = Object.keys(buildDigest(turns).turnIndex).map(Number);
  assert.equal(keys.length, 80);
  assert.equal(keys[0], 10);
  assert.equal(keys[79], 89);
});

test('a source_turns ref to a CAP-truncated turn behaves exactly like the dropped case', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  const turns = Array.from({ length: 100 }, (_, i) => turn('user', `Turn number ${i}.`, { tags: ['decision'], via: 'claude:typed' }));
  const { turnIndex } = buildDigest(turns);
  const pool = await mint(makeProposal({ turnIndex, source_turns: ['#95'] }));
  assert.equal(pool[0].frontmatter.citation, undefined);
  assert.equal(pool[0].frontmatter.provenance, 'inferred');
  assert.equal(pool[0].frontmatter.provenance_via, undefined);
});

// ---------------------------------------------------------------- citation-hash consequence

test('the citation hash is now over the STRIPPED text — a harness block no longer alters it', async () => {
  const { buildDigest } = await import('../read-pass.mjs');
  const clean = buildDigest([turn('user', 'Decided: ship it.', { tags: ['decision'], via: 'claude:typed' })]).turnIndex;
  const wrapped = buildDigest([turn('user', `${RECALL}\n\nDecided: ship it.`, { tags: ['decision'], via: 'claude:typed' })]).turnIndex;
  assert.deepEqual(wrapped[0], clean[0]);
  const a = await mint(makeProposal({ turnIndex: clean, source_turns: ['#0'] }));
  const b = await mint(makeProposal({ turnIndex: wrapped, source_turns: ['#0'] }));
  assert.equal(a[0].frontmatter.citation, b[0].frontmatter.citation);
});
