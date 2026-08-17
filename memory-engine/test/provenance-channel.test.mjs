// provenance-channel.test.mjs — MEM-38 step 2: the capture-time provenance channel.
//
// Step 2 emits a CHANNEL token only (`claude:typed` | `subagent` | `hermes:cli` | `hermes:telegram`)
// and carries it from staging to the mint path. It does NOT derive the `provenance` tier or any node
// frontmatter (step 3), so everything asserted here is about the WIRE: the staging turn header and
// `turnIndex`.
//
// The encoding is a third `·` segment in the header, never a tag: read-pass.mjs gates digest
// inclusion on `tags.length`, so a tag would mark every turn salient. The two properties that make
// that safe are asserted directly, because both are silent failures if broken:
//   1. a 2-segment (pre-MEM-38) header still parses exactly as before — staging is a MIXED-format
//      directory, old files are never rewritten;
//   2. `deriveCitation`'s sha8 input is still exactly the turn text — turnIndex changed shape, and
//      any drift there silently rewrites every `stg:` citation in the graph.
//
// Capture runs for real (the shared capture-core emission path, not a hand-written header) against
// the temp root minted by setup.mjs; COCKPIT_SCOPE opts the fake cwd into a scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const TS = '2026-07-25T10:22:00.000Z';

// run the real shared capture pipeline and return the staging file it wrote.
async function captureToStaging(sessionId, entries) {
  const { capture } = await import('../capture-core.mjs');
  process.env.COCKPIT_SCOPE = 'cockpit';
  const res = await capture({
    entries, cwd: '/nonexistent/unmapped', sessionId, event: 'Stop',
    provenance: 'test-transcript.jsonl', brain: 'claude',
  });
  delete process.env.COCKPIT_SCOPE;
  assert.equal(res.scope, 'cockpit', 'capture must have resolved a scope, not skipped');
  return readFile(resolve(TEST_MEMORY_ROOT, res.outFile), 'utf8');
}

test('round-trip: a stamped header emitted by capture parses back to the same role/ts/tags/via', async () => {
  const { parseStaging } = await import('../read-pass.mjs');
  const text = await captureToStaging('via-roundtrip', [
    { role: 'user', text: 'Remember this decision.', errored: false, ts: TS, via: 'claude:typed' },
    { role: 'user', text: 'A sidechain prompt.', errored: false, ts: TS, via: 'subagent' },
    { role: 'assistant', text: 'Assistant prose.', errored: false, ts: TS, via: null },
  ]);

  // the emitted shape: `#### role · ts · via  [tags]`, and NO third segment when there is no via.
  assert.match(text, /^#### user · 2026-07-25T10:22:00\.000Z · claude:typed {2}\[keep\]$/m);
  assert.match(text, /^#### assistant · 2026-07-25T10:22:00\.000Z$/m);

  const turns = parseStaging(text).turns;
  assert.deepEqual(turns.map((t) => [t.role, t.via, t.tags.join(','), t.ts]), [
    ['user', 'claude:typed', 'keep', Date.parse(TS)],
    ['user', 'subagent', '', Date.parse(TS)],
    ['assistant', null, '', Date.parse(TS)],
  ]);
  assert.equal(turns[0].text, 'Remember this decision.');
});

test('backward compatibility: a legacy 2-segment header parses identically, via null', async () => {
  const { parseStaging } = await import('../read-pass.mjs');
  // byte-for-byte the pre-MEM-38 emission (capture-core.mjs before step 2), incl. the two-space
  // gap before the tag bracket. A mixed-format staging directory is the normal case.
  const legacy = '---\nscope: cockpit\nsession_anchor: legacy\nbrain: claude\n---\n\n'
    + `#### user · ${TS}  [#bad, correction]\nThat's not what I meant.\n\n`
    + `#### assistant · ${TS}\nUnderstood.\n\n`;
  const turns = parseStaging(legacy).turns;
  assert.deepEqual(turns.map((t) => [t.role, t.via, t.tags.join(','), t.ts]), [
    ['user', null, '#bad,correction', Date.parse(TS)],
    ['assistant', null, '', Date.parse(TS)],
  ]);
  assert.equal(turns[0].text, "That's not what I meant.");
});

test('the sanitizer drops a token carrying ·, [, ] or a newline (a malformed token would corrupt every parse)', async () => {
  const { viaToken } = await import('../capture-core.mjs');
  for (const bad of ['claude·typed', 'claude:[typed]', 'a]b', 'two\nlines', '', ' ', null, undefined, 42, {}])
    assert.equal(viaToken(bad), null, `must reject ${JSON.stringify(bad)}`);
  for (const ok of ['claude:typed', 'subagent', 'hermes:cli', 'hermes:telegram'])
    assert.equal(viaToken(ok), ok);

  // and it is enforced at the emission site, not just exported: a poisoned token never reaches disk.
  const { parseStaging } = await import('../read-pass.mjs');
  const text = await captureToStaging('via-sanitize', [
    { role: 'user', text: 'A turn with a poisoned channel.', errored: false, ts: TS, via: 'claude·[typed]' },
  ]);
  assert.match(text, /^#### user · 2026-07-25T10:22:00\.000Z$/m);   // header identical to unstamped
  assert.equal(parseStaging(text).turns[0].via, null);
});

test('turnIndex carries via, and deriveCitation still hashes exactly the turn text', async () => {
  const { parseStaging, buildDigest } = await import('../read-pass.mjs');
  const { applyConsolidation } = await import('../reconcile.mjs');

  const text = await captureToStaging('via-turnindex', [
    { role: 'user', text: 'Decided: the channel rides the header.', errored: false, ts: TS, via: 'claude:typed' },
    { role: 'assistant', text: 'Acknowledged.', errored: false, ts: TS, via: null },
  ]);
  const turns = parseStaging(text).turns;
  const { turnIndex } = buildDigest(turns);

  assert.deepEqual(turnIndex[0], { text: 'Decided: the channel rides the header.', via: 'claude:typed' });
  assert.equal(turnIndex[1].via, null);                  // assistant neighbor, unstamped

  // the citation leg: the sha8 input must still be the turn TEXT, nothing more. Asserted through the
  // real mint path, since deriveCitation is internal to reconcile.mjs.
  const pool = [];
  const audit = { added: [], modified: [], superseded: [], held: [], autoApplied: [], unmentioned: [], reflectSkipped: [], clamped: [] };
  const props = [{
    idx: 0, title: 'Channel Rule', type: 'identity', prose: 'Proposed prose.', cluster: 'doctrine',
    centrality: 0.9, tags: [], entities: {}, source_turns: ['#0'],
    _wu: { isSource: false, anchor: 'sessions/2026-07-25', brain: 'claude', turnIndex },
  }];
  await applyConsolidation([{ action: 'new', backing: [0], centrality: 0.9, cluster: 'doctrine' }],
    props, [], 'cockpit', pool, new Set(), audit);
  assert.equal(pool.length, 1, 'the mint should have reached the pool');
  assert.equal(pool[0].frontmatter.citation,
    `stg:sessions/2026-07-25:${sha8('Decided: the channel rides the header.')}`);
});

test('claude reader: garbled/missing origin or promptSource yields no via and never throws', async () => {
  // the REAL derivation: capture.mjs only runs main() when executed directly, so importing it here
  // exercises viaOf without triggering a capture. FAIL-SAFE is the point: these transcript fields
  // drift across Claude Code versions and capture must never throw.
  const { viaToken } = await import('../capture-core.mjs');
  const { viaOf } = await import('../capture.mjs');
  const cases = [
    // real shapes observed in ~/.claude/projects (2026-07-25)
    [{ origin: { kind: 'human' }, promptSource: 'typed', isSidechain: false }, 'claude:typed'],
    [{ origin: { kind: 'task-notification' }, promptSource: 'system', isSidechain: false }, null],
    [{ origin: { kind: 'human' }, promptSource: 'suggestion_accepted' }, null],
    [{ isSidechain: true }, 'subagent'],
    [{}, null],                                          // tool_result record: neither field
    // drift / garbling
    [{ origin: 'human', promptSource: 'typed' }, null],   // origin no longer an object
    [{ origin: null, promptSource: 'typed' }, null],
    [{ origin: { kind: 'human' } }, null],                // promptSource renamed away
    [{ origin: { kind: 'human' }, promptSource: 'typed', isSidechain: 1 }, 'subagent'],
  ];
  for (const [e, want] of cases) {
    assert.equal(viaOf(e, 'user', 'some text'), want, `for ${JSON.stringify(e)}`);
    assert.equal(viaToken(viaOf(e, 'user', 'some text')), want);   // whatever it yields must survive the sanitizer
  }
  assert.equal(viaOf({ origin: { kind: 'human' }, promptSource: 'typed' }, 'assistant', 'text'), null);
  assert.equal(viaOf({ isSidechain: true }, 'user', ''), null);     // no text: a tool-error record, not an authored turn
});
