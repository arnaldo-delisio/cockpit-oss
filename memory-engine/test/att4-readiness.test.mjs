// att4-readiness.test.mjs — ATT-4 step 1: attention.mjs deterministicReadiness, the monotonic
// pre-pass (board-rethink-design §4). Authored as the independent test pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

// COCKPIT_OWNER is pinned the way att4-pins.test.mjs pins it, and for the same reason:
// attention.mjs builds its owner-named human-gate phrases at IMPORT time from ownerName()
// (paths.mjs), which falls back to whatever git identity the box carries. Unpinned, every
// literal-phrase assertion below would only hold on the author's machine. The pin states what
// the assertions actually mean: "the owner is arnaldo, so the phrase reads this way".
// The import is dynamic because a static one would hoist above this assignment.
process.env.COCKPIT_OWNER = 'arnaldo';
const { deterministicReadiness, HUMAN_GATE_PHRASES } = await import('../attention.mjs');

const execFileP = promisify(execFile);

// a decisions dir the pointer tests resolve against (never the live repo's decisions/)
const DEC_DIR = resolve(TEST_MEMORY_ROOT, 'readiness-decisions');
const OPTS = { decisionsDirs: [DEC_DIR] };

test('every human-gate phrase → final needs-me naming the phrase', () => {
  for (const phrase of HUMAN_GATE_PHRASES) {
    const r = deterministicReadiness(`- [ ] ship the thing, ${phrase}, then push`, OPTS);
    assert.equal(r.state, 'needs-me', `phrase "${phrase}" must gate`);
    assert.equal(r.final, true);
    assert.equal(r.reason, `human-gate: ${phrase}`);
  }
});

test('phrases match case-insensitively', () => {
  const r = deterministicReadiness('- [ ] DECIDE with the team', OPTS);
  assert.equal(r.state, 'needs-me');
  assert.equal(r.final, true);
});

test('longer phrase wins the reason over its embedded shorter one', () => {
  const r = deterministicReadiness("- [ ] ship it with arnaldo's go", OPTS);
  assert.equal(r.reason, "human-gate: with arnaldo's go", 'reason must name the MOST specific hit');
});

test('"decidedly" must NOT trip "decide" (word boundary)', () => {
  const r = deterministicReadiness('- [ ] this is decidedly better, ship it', OPTS);
  assert.equal(r.state, 'ambiguous');
  assert.equal(r.final, false);
});

test('"decision" alone (no "decision needed") must NOT trip anything', () => {
  const r = deterministicReadiness('- [ ] write up the decision rationale', OPTS);
  assert.equal(r.state, 'ambiguous');
});

test('"asktool" embedded in a longer word must NOT trip', () => {
  const r = deterministicReadiness('- [ ] refactor the masktools helper', OPTS);
  assert.equal(r.state, 'ambiguous');
});

test('unresolved decision pointer → final needs-me naming the pointer', () => {
  const r = deterministicReadiness('- [ ] build the feed → decisions/never-written.md', OPTS);
  assert.equal(r.state, 'needs-me');
  assert.equal(r.final, true);
  assert.match(r.reason, /unresolved decision pointer: decisions\/never-written\.md/);
});

test('resolved pointer → ambiguous + evidence, never a deterministic verdict', async () => {
  await mkdir(DEC_DIR, { recursive: true });
  await writeFile(resolve(DEC_DIR, 'settled-topic.md'), '# settled\n', 'utf8');
  const r = deterministicReadiness('- [ ] build the feed → decisions/settled-topic.md', OPTS);
  assert.equal(r.state, 'ambiguous');
  assert.equal(r.final, false);
  assert.deepEqual(r.evidence, [{ pointer: 'decisions/settled-topic.md', resolved: true }]);
});

test('one unresolved pointer among resolved ones still gates', async () => {
  await mkdir(DEC_DIR, { recursive: true });
  await writeFile(resolve(DEC_DIR, 'settled-topic.md'), '# settled\n', 'utf8');
  const r = deterministicReadiness(
    '- [ ] wire it → decisions/settled-topic.md then → decisions/ghost.md', OPTS);
  assert.equal(r.state, 'needs-me');
  assert.equal(r.final, true);
  assert.match(r.reason, /decisions\/ghost\.md/);
});

test('no signal at all → ambiguous, non-final, no evidence key', () => {
  const r = deterministicReadiness('- [ ] tighten the comparator tiebreak', OPTS);
  assert.deepEqual(r, { state: 'ambiguous', final: false });
});

test('PROPERTY: deterministicReadiness NEVER outputs agent-ready over varied inputs', async () => {
  await mkdir(DEC_DIR, { recursive: true });
  await writeFile(resolve(DEC_DIR, 'settled-topic.md'), '# settled\n', 'utf8');
  const inputs = [
    '', '   ', '- [ ] plain mechanical chore', '- [x] already done item',
    'agent-ready', 'this is fully agent ready, just run it', 'ready for the agent',
    '- [ ] decide with arnaldo', '- [ ] ship → decisions/settled-topic.md',
    '- [ ] ship → decisions/missing.md', 'asktool', 'no gates here at all',
    '- [ ] multi\n  line item continuation', '→ decisions/', 'decide',
    '- [ ] DECISION NEEDED on the palette', String(null), '0', 'x'.repeat(500),
  ];
  for (const raw of inputs) {
    const r = deterministicReadiness(raw, OPTS);
    assert.notEqual(r.state, 'agent-ready', `agent-ready leaked for input: ${JSON.stringify(raw)}`);
    assert.ok(['needs-me', 'ambiguous'].includes(r.state), `unexpected state ${r.state}`);
    if (r.state === 'needs-me') assert.equal(r.final, true, 'a deterministic needs-me is FINAL');
  }
});

// GUARD (machine-independence). Every assertion above is written against a PINNED owner, so
// none of them can notice if the phrase builder stops tracking the owner at all: hardcode
// "arnaldo" into attention.mjs and this whole file still passes. This guard closes that hole by
// exercising the builder with an owner nobody's git identity would produce, in a child process
// (HUMAN_GATE_PHRASES is import-time state, so a fresh process is the only way to vary it).
// Chosen over a scanner that greps the suite for the author's name because that kind of check
// cannot be discriminated: no mutation of the source makes it fail.
test('GUARD: owner-named phrases are built from the RUNTIME owner, not a hardcoded name', async () => {
  const probe = `
    const { HUMAN_GATE_PHRASES, deterministicReadiness } =
      await import(${JSON.stringify(resolve(import.meta.dirname, '..', 'attention.mjs'))});
    process.stdout.write(JSON.stringify({
      phrases: HUMAN_GATE_PHRASES,
      reason: deterministicReadiness("- [ ] ship it with zephyr's go", { decisionsDirs: [] }).reason,
    }));
  `;
  const { stdout } = await execFileP(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, COCKPIT_OWNER: 'zephyr' },
  });
  const out = JSON.parse(stdout);
  assert.deepEqual(
    out.phrases.filter((p) => p.includes('zephyr')),
    ['decide with zephyr', "with zephyr's go", 'zephyr decides', "zephyr's go"],
    'the owner-named phrases must name the runtime owner',
  );
  assert.ok(!out.phrases.some((p) => p.includes('arnaldo')),
    'no owner name may be baked into the phrase list');
  assert.equal(out.reason, "human-gate: with zephyr's go");
});
