// att4-program-order.test.mjs — ATT-4 step 1: program-order.mjs, the standing cross-scope
// ranking reader (board-rethink-design §3). Authored as the independent test pass.
//
// loadProgramOrder resolves against the preload-minted temp MEMORY_ROOT, so the missing-file
// case runs FIRST, then the file is materialized for the loader round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import './fixtures.mjs';

import { parseProgramOrder, loadProgramOrder, programRank, PROGRAM_ORDER_PATH } from '../program-order.mjs';

// ---------- grammar ----------

test('parse: prose, headings, blanks and off-grammar lines are ignored', () => {
  const text = [
    '# Program order',
    '',
    'Ranked top to bottom; edit deliberately.',
    '- [first-push] cockpit/dashboard-port',
    '- not an entry (no id bracket)',
    '* [also-not] wrong bullet',
    '- [Bad-Caps] cockpit',
    '- [second] venture-a, personal/health',
    '',
  ].join('\n');
  const entries = parseProgramOrder(text);
  assert.deepEqual(entries, [
    { id: 'first-push', members: ['cockpit/dashboard-port'] },
    { id: 'second', members: ['venture-a', 'personal/health'] },
  ]);
});

test('parse: members split on comma and trim, empties dropped', () => {
  const [e] = parseProgramOrder('- [x1]  a ,  b/c ,, d ');
  assert.deepEqual(e.members, ['a', 'b/c', 'd']);
});

test('parse: an entry with only empty members is dropped entirely', () => {
  assert.deepEqual(parseProgramOrder('- [x1] ,, '), []);
});

// ---------- programRank ----------

const ENTRIES = parseProgramOrder([
  '- [top] cockpit/dashboard-port',
  '- [mid] venture-a',
  '- [dup] cockpit/dashboard-port, studio',   // duplicate membership for dashboard-port
].join('\n'));

test('rank: scope/project member matches exactly that project', () => {
  const r = programRank(ENTRIES, 'cockpit', 'dashboard-port');
  assert.equal(r.rank, 0);
  assert.equal(r.matchedEntry.id, 'top');
  assert.equal(r.projectId, 'dashboard-port');
});

test('rank: first-match-wins on duplicate membership (later [dup] entry never wins)', () => {
  const r = programRank(ENTRIES, 'cockpit', 'dashboard-port');
  assert.equal(r.matchedEntry.id, 'top', 'the FIRST matching entry governs, not the last');
});

test('rank: a scope-name member matches every project in that scope', () => {
  const a = programRank(ENTRIES, 'venture-a', 'anything');
  const b = programRank(ENTRIES, 'venture-a', 'else-entirely');
  assert.equal(a.rank, 1);
  assert.equal(b.rank, 1);
  assert.equal(a.matchedEntry.id, 'mid');
});

test('rank: scope member in a later entry ([dup] studio) still matches', () => {
  const r = programRank(ENTRIES, 'studio', 'some-proj');
  assert.equal(r.rank, 2);
  assert.equal(r.matchedEntry.id, 'dup');
});

test('rank: a scope-qualified member never matches a different project of that scope', () => {
  const r = programRank(ENTRIES, 'cockpit', 'memory-engine');
  assert.equal(r.matchedEntry, null, 'cockpit/dashboard-port must not match cockpit/memory-engine');
});

test('rank: unmatched fallback = entries.length + hierarchy index (personal<studio<cockpit)', () => {
  const entries = parseProgramOrder('- [only] cockpit/dashboard-port');
  const n = entries.length;
  assert.equal(programRank(entries, 'personal', 'p').rank, n + 0);
  assert.equal(programRank(entries, 'studio', 'p').rank, n + 1);
  assert.equal(programRank(entries, 'cockpit', 'other-proj').rank, n + 2);
});

test('rank: unknown scope ranks after all three known scopes', () => {
  const entries = parseProgramOrder('- [only] cockpit/dashboard-port');
  const unknown = programRank(entries, 'newscope', 'p').rank;
  assert.equal(unknown, entries.length + 3);
  assert.ok(unknown > programRank(entries, 'cockpit', 'other').rank);
});

test('rank: every matched rank sorts before every unmatched rank', () => {
  const matched = programRank(ENTRIES, 'studio', 'p').rank;
  const unmatched = programRank(ENTRIES, 'personal', 'p').rank;
  assert.ok(matched < unmatched);
});

test('rank: empty entries list → pure hierarchy fallback from 0', () => {
  assert.equal(programRank([], 'personal', 'p').rank, 0);
  assert.equal(programRank([], 'cockpit', 'p').rank, 2);
  assert.equal(programRank([], 'weird', 'p').rank, 3);
});

// ---------- loader ----------

test('loadProgramOrder: missing file → [] (must run before the file is written)', async () => {
  assert.deepEqual(await loadProgramOrder(), []);
});

test('loadProgramOrder: reads the file at memory/scopes/cockpit/program-order.md', async () => {
  await mkdir(dirname(PROGRAM_ORDER_PATH), { recursive: true });
  await writeFile(PROGRAM_ORDER_PATH, '# hdr\n- [alpha] cockpit\n', 'utf8');
  const entries = await loadProgramOrder();
  assert.deepEqual(entries, [{ id: 'alpha', members: ['cockpit'] }]);
});
