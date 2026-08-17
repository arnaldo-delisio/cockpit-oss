// att4-pins.test.mjs — ATT-4 step 1: decisions.mjs pin family. CLI verbs run as REAL child
// processes against per-scenario fixture roots; reducePinEntries/effectivePinState are imported
// directly (they are the one shared author-aware reader, §5/§3). Authored as the independent
// test pass. Exit-65 stale-snapshot: same in-child window as roadmap.mjs, covered only
// partially (see pass report).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

import { reducePinEntries, effectivePinState } from '../decisions.mjs';
import { canonicalItemText, itemHash, compositeItemKey } from '../item-identity.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const DECISIONS_CLI = resolve(ENGINE_DIR, 'decisions.mjs');

const PROJECT_FM = `---
id: proj-p
title: Project P
type: project
state: active
scope: testscope
---

Body.
`;

const ROADMAP = `# roadmap

## Now

- [ ] Alpha task one
- [x] Finished now task

## Next

- [ ] Beta task two

## Done

- [x] Old thing
`;

let seq = 0;
async function makeRoot(name) {
  const root = resolve(TEST_MEMORY_ROOT, 'pin-roots', `${String(++seq).padStart(2, '0')}-${name}`);
  const projDir = resolve(root, 'scopes', 'testscope', 'projects');
  await mkdir(projDir, { recursive: true });
  await mkdir(resolve(root, '.reconciler'), { recursive: true });
  await writeFile(resolve(projDir, 'proj-p.md'), PROJECT_FM, 'utf8');
  await writeFile(resolve(projDir, 'proj-p.roadmap.md'), ROADMAP, 'utf8');
  await execFileP('git', ['-C', root, 'init', '--quiet']);
  await execFileP('git', ['-C', root, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', root, 'config', 'user.email', 'test@test.invalid']);
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed']);
  return root;
}

function run(root, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [DECISIONS_CLI, ...args], {
      env: {
        // COCKPIT_OWNER is pinned so the owner-gated `--by` values are the test's, not the
        // developer's: ownerName() otherwise falls back to whatever git identity this box
        // carries, and every `--by arnaldo` assertion below would be machine-dependent.
        ...process.env, COCKPIT_OWNER: 'arnaldo', COCKPIT_MEMORY_ROOT: root, PATH: '/usr/bin:/bin', HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

const logLines = async (root) => {
  try {
    return (await readFile(resolve(root, 'decision-log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
async function commitCount(root) {
  const { stdout } = await execFileP('git', ['-C', root, 'rev-list', '--all', '--count']);
  return Number(stdout.trim());
}
async function gitHead(root) {
  const { stdout } = await execFileP('git', ['-C', root, 'show', '--name-only', '--format=%s', 'HEAD']);
  return stdout;
}

// entry factory for the in-process reducer tests
let ts = 0;
const E = (kind, by, { item, project = 'proj-p', scope = 'testscope', reason } = {}) => ({
  kind, project, scope, by, ts: `2026-07-27T00:00:0${++ts % 10}.000Z`,
  ...(reason ? { reason } : {}), ...(item ? { item } : {}),
});
const ITEM = { hash: 'a'.repeat(16), canonical: 'alpha task one' };
const PKEY = 'testscope/proj-p';
const IKEY = compositeItemKey('testscope', 'proj-p', ITEM.hash);

// ---------- CLI ----------

test('pin: --by is required (and validated)', async () => {
  const root = await makeRoot('by-required');
  const r = await run(root, ['pin', 'proj-p']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--by arnaldo\|hermes/);
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'mallory']);
  assert.equal(r2.code, 1);
  assert.deepEqual(await logLines(root), [], 'nothing appended on refusal');
});

test('pin project: entry shape (kind/project/scope/ts/by/reason), one path-scoped commit', async () => {
  const root = await makeRoot('shape');
  await writeFile(resolve(root, 'bystander.txt'), 'dirty\n', 'utf8');
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--reason', 'push this']);
  assert.equal(r.code, 0, r.stderr);
  const lines = await logLines(root);
  assert.equal(lines.length, 1);
  const e = lines[0];
  assert.equal(e.kind, 'pin');
  assert.equal(e.project, 'proj-p');
  assert.equal(e.scope, 'testscope', 'scope derived from the project path');
  assert.equal(e.by, 'arnaldo');
  assert.equal(e.reason, 'push this');
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.item, undefined, 'no --item → project-level entry');
  const head = await gitHead(root);
  assert.match(head, /decisions: pin proj-p/);
  assert.match(head, /decision-log\.jsonl/);
  assert.doesNotMatch(head, /bystander/, 'commit pathspec-scoped to the log alone');
});

test('pin --item: resolves one open item, entry carries {hash, canonical} per item-identity', async () => {
  const root = await makeRoot('item');
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Alpha task']);
  assert.equal(r.code, 0, r.stderr);
  const [e] = await logLines(root);
  const canonical = canonicalItemText('- [ ] Alpha task one');
  assert.deepEqual(e.item, { hash: itemHash(canonical), canonical });
  assert.match(e.item.hash, /^[0-9a-f]{16}$/);
});

test('pin --item: no open match refuses (done and checked items are not targets)', async () => {
  const root = await makeRoot('item-nomatch');
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Old thing']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /matched no open/);
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Finished now task']);
  assert.equal(r2.code, 1, 'a checked now item is not open');
  const r3 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'task']);
  assert.equal(r3.code, 1);
  assert.match(r3.stderr, /matched 2 open items/);
  assert.deepEqual(await logLines(root), []);
});

test('idempotent re-pin: same author, same target → exit 0, NO new log line, NO new commit', async () => {
  const root = await makeRoot('idem');
  const r1 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r1.code, 0, r1.stderr);
  const commits = await commitCount(root);
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /no-op/);
  assert.equal((await logLines(root)).length, 1, 'no second line appended');
  assert.equal(await commitCount(root), commits, 'no-op must not commit');
});

test('unpin with nothing held for that author class → no-op, nothing appended', async () => {
  const root = await makeRoot('unpin-noop');
  const r = await run(root, ['unpin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no-op/);
  assert.deepEqual(await logLines(root), []);
});

test('pin --item refusal releases the lock: a subsequent verb succeeds', async () => {
  const root = await makeRoot('item-lock-release');
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'no such item text']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /matched no open/);
  await assert.rejects(() => readFile(resolve(root, '.reconciler', 'lock'), 'utf8'), 'refusal must release the lock');
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Alpha task']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal((await logLines(root)).length, 1);
});

test('pin --item resolves UNDER the lock: with the lock held, the busy exit wins over item resolution', async () => {
  const root = await makeRoot('item-under-lock');
  // remove the roadmap: resolution would refuse exit 1 — but the held lock must win (75),
  // proving the resolve happens inside the lock lifetime, not before it.
  const { unlink } = await import('node:fs/promises');
  await unlink(resolve(root, 'scopes', 'testscope', 'projects', 'proj-p.roadmap.md'));
  await writeFile(resolve(root, '.reconciler', 'lock'), JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Alpha task']);
  assert.equal(r.code, 75, `expected busy before resolution, got ${r.code}: ${r.stderr}`);
});

test('pin: rename landed but commit missed → the no-op retry heals with a heal commit', async () => {
  const root = await makeRoot('heal');
  const r1 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r1.code, 0, r1.stderr);
  // simulate the crash window: undo the commit, keep the appended log (modified-uncommitted)
  await execFileP('git', ['-C', root, 'reset', '--mixed', '--quiet', 'HEAD~1']);
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /no-op/);
  const { stdout: status } = await execFileP('git', ['-C', root, 'status', '--porcelain']);
  assert.equal(status.trim(), '', 'residue must be committed by the heal');
  assert.match(await gitHead(root), /decisions: pin proj-p \(commit heal\)/);
});

test('pin no-op over FOREIGN residue: an unrelated uncommitted log line is NOT absorbed', async () => {
  const root = await makeRoot('foreign-residue');
  const r1 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r1.code, 0, r1.stderr);
  // pre-dirty the log with an unrelated (triage) line no interrupted pin could have appended
  const logPath = resolve(root, 'decision-log.jsonl');
  const dirty = (await readFile(logPath, 'utf8')) +
    JSON.stringify({ project: 'proj-p', decision: 'defer', ts: 't', until: '2026-09-01' }) + '\n';
  await writeFile(logPath, dirty, 'utf8');
  const commits = await commitCount(root);
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /no-op/);
  assert.match(r2.stderr, /did not produce; left untouched/);
  assert.equal(await commitCount(root), commits, 'foreign residue must not be committed');
  assert.equal(await readFile(logPath, 'utf8'), dirty, 'dirty state left byte-identical');
});

test('re-pin with a CHANGED --reason appends a new entry (human live state); identical reason stays no-op', async () => {
  const root = await makeRoot('reason-change');
  const r1 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--reason', 'first take']);
  assert.equal(r1.code, 0, r1.stderr);
  const commits = await commitCount(root);
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--reason', 'sharper take']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.doesNotMatch(r2.stdout, /no-op/);
  const lines = await logLines(root);
  assert.equal(lines.length, 2, 'changed reason must append');
  assert.equal(lines[1].reason, 'sharper take');
  assert.equal(await commitCount(root), commits + 1, 'the append commits');
  const r3 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--reason', 'sharper take']);
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stdout, /no-op/);
  assert.equal((await logLines(root)).length, 2, 'identical reason stays a no-op');
});

test('hermes re-pin over its own suggestion: changed reason appends, identical reason no-ops', async () => {
  const root = await makeRoot('reason-suggestion');
  await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  const r1 = await run(root, ['pin', 'proj-p', '--by', 'hermes', '--reason', 'me too']);
  assert.equal(r1.code, 0, r1.stderr);
  const r2 = await run(root, ['pin', 'proj-p', '--by', 'hermes', '--reason', 'me too']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /no-op/);
  assert.equal((await logLines(root)).length, 2);
  const r3 = await run(root, ['pin', 'proj-p', '--by', 'hermes', '--reason', 'new evidence']);
  assert.equal(r3.code, 0, r3.stderr);
  const lines = await logLines(root);
  assert.equal(lines.length, 3, 'changed suggestion reason must append');
  assert.equal(lines[2].reason, 'new evidence');
});

test('pin: live lock → exit 75, log untouched, lock not stolen', async () => {
  const root = await makeRoot('lock');
  await writeFile(resolve(root, '.reconciler', 'lock'), JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo']);
  assert.equal(r.code, 75);
  assert.match(r.stderr, /busy/);
  assert.deepEqual(await logLines(root), []);
  assert.equal(JSON.parse(await readFile(resolve(root, '.reconciler', 'lock'), 'utf8')).pid, process.pid);
});

test('pin --dry-run: previews the line, appends nothing, commits nothing', async () => {
  const root = await makeRoot('dry');
  const commits = await commitCount(root);
  const r = await run(root, ['pin', 'proj-p', '--by', 'hermes', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /--dry-run: nothing written/);
  assert.deepEqual(await logLines(root), []);
  assert.equal(await commitCount(root), commits);
});

// ---------- --item-hash (§5 orphan dismiss/rebind path, resolution-free) ----------

test('pin --item-hash: resolution-free append (no roadmap sidecar needed), canonical null with no prior entry', async () => {
  const root = await makeRoot('itemhash-free');
  // remove the roadmap: --item resolution would refuse, --item-hash must not even look
  const { unlink } = await import('node:fs/promises');
  await unlink(resolve(root, 'scopes', 'testscope', 'projects', 'proj-p.roadmap.md'));
  const hash = 'b'.repeat(16);
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item-hash', hash]);
  assert.equal(r.code, 0, r.stderr);
  const [e] = await logLines(root);
  assert.deepEqual(e.item, { hash, canonical: null }, 'no prior entry with this hash → canonical null');
});

test('unpin --item-hash: canonical recovered from the latest log entry holding that hash', async () => {
  const root = await makeRoot('itemhash-recover');
  const r1 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Alpha task']);
  assert.equal(r1.code, 0, r1.stderr);
  const [first] = await logLines(root);
  const r2 = await run(root, ['unpin', 'proj-p', '--by', 'arnaldo', '--item-hash', first.item.hash]);
  assert.equal(r2.code, 0, r2.stderr);
  const lines = await logLines(root);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].kind, 'unpin');
  assert.deepEqual(lines[1].item, { hash: first.item.hash, canonical: first.item.canonical });
});

test('idempotent --item-hash repeat via effective state: second unpin no-ops, nothing appended, no new commit', async () => {
  const root = await makeRoot('itemhash-idem');
  const r1 = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Alpha task']);
  assert.equal(r1.code, 0, r1.stderr);
  const [first] = await logLines(root);
  const r2 = await run(root, ['unpin', 'proj-p', '--by', 'arnaldo', '--item-hash', first.item.hash]);
  assert.equal(r2.code, 0, r2.stderr);
  const commits = await commitCount(root);
  const r3 = await run(root, ['unpin', 'proj-p', '--by', 'arnaldo', '--item-hash', first.item.hash]);
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stdout, /no-op/);
  assert.equal((await logLines(root)).length, 2, 'no third line appended');
  assert.equal(await commitCount(root), commits, 'no-op must not commit');
});

test('--item and --item-hash together refuse, nothing appended', async () => {
  const root = await makeRoot('itemhash-exclusive');
  const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item', 'Alpha task', '--item-hash', 'a'.repeat(16)]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /at most one of --item or --item-hash/);
  assert.deepEqual(await logLines(root), []);
});

test('malformed --item-hash refuses (wrong length, wrong charset), nothing appended', async () => {
  const root = await makeRoot('itemhash-malformed');
  for (const bad of ['abcd', 'A'.repeat(16), 'g'.repeat(16), 'a'.repeat(17)]) {
    const r = await run(root, ['pin', 'proj-p', '--by', 'arnaldo', '--item-hash', bad]);
    assert.equal(r.code, 1, `expected refusal for ${JSON.stringify(bad)}`);
    assert.match(r.stderr, /16 lowercase hex/);
  }
  assert.deepEqual(await logLines(root), []);
});

// ---------- reducePinEntries (§5, the one shared author-aware reader) ----------

test('reduce: hermes pin over a live human pin → human state governs, hermes retained as suggestion', () => {
  const reduced = reducePinEntries([
    E('pin', 'arnaldo', { reason: 'mine' }),
    E('pin', 'hermes', { reason: 'me too' }),
  ]);
  const v = reduced.get(PKEY);
  assert.equal(v.state, 'pinned');
  assert.equal(v.by, 'arnaldo');
  assert.equal(v.reason, 'mine');
  assert.equal(v.hermesSuggestion.state, 'pinned');
  assert.equal(v.hermesSuggestion.reason, 'me too');
});

test('reduce: human unpin → neutral; SUBSEQUENT hermes entries stay inert (suggestion only) until a new human pin/park', () => {
  const reduced = reducePinEntries([
    E('pin', 'arnaldo'),
    E('unpin', 'arnaldo'),
    E('pin', 'hermes', { reason: 'still think so' }),
  ]);
  const v = reduced.get(PKEY);
  assert.equal(v.state, 'neutral', 'a human veto must not be overridable by hermes');
  assert.equal(v.by, null);
  assert.equal(v.hermesSuggestion.state, 'pinned', 'the inert hermes entry survives as a suggestion');
});

test('reduce: hermes pin with NO human history governs (state by hermes)', () => {
  const v = reducePinEntries([E('pin', 'hermes', { reason: 'proactive' })]).get(PKEY);
  assert.equal(v.state, 'pinned');
  assert.equal(v.by, 'hermes');
  assert.equal(v.reason, 'proactive');
});

test('reduce: hermes unpin clears ONLY the hermes layer (live human state untouched)', () => {
  const reduced = reducePinEntries([
    E('pin', 'arnaldo'),
    E('pin', 'hermes'),          // becomes suggestion
    E('unpin', 'hermes'),        // stands down: suggestion cleared, human intact
  ]);
  const v = reduced.get(PKEY);
  assert.equal(v.state, 'pinned');
  assert.equal(v.by, 'arnaldo');
  assert.equal(v.hermesSuggestion, undefined, 'hermes stand-down clears its own suggestion');
});

test('reduce: reversal clears regardless of held state (unpin over a park still clears)', () => {
  const v1 = reducePinEntries([E('park', 'hermes'), E('unpin', 'hermes')]).get(PKEY);
  assert.equal(v1.state, 'neutral', 'unpin is "stand down", not a state-matched toggle');
  const v2 = reducePinEntries([E('park', 'arnaldo'), E('unpin', 'arnaldo')]).get(PKEY);
  assert.equal(v2.state, 'neutral');
});

test('reduce: human pin after a human unpin re-opens the target (human state live again)', () => {
  const v = reducePinEntries([
    E('pin', 'arnaldo'), E('unpin', 'arnaldo'), E('park', 'arnaldo'),
  ]).get(PKEY);
  assert.equal(v.state, 'parked');
  assert.equal(v.by, 'arnaldo');
});

test('reduce: item-level and project-level entries land under DIFFERENT keys', () => {
  const reduced = reducePinEntries([
    E('pin', 'arnaldo'),
    E('park', 'arnaldo', { item: ITEM }),
  ]);
  assert.equal(reduced.get(PKEY).state, 'pinned');
  assert.equal(reduced.get(IKEY).state, 'parked');
});

test('reduce: triage/foreign entries pass through untouched', () => {
  const reduced = reducePinEntries([
    { project: 'proj-p', decision: 'defer', ts: 't', until: '2026-08-01' },
    E('pin', 'arnaldo'),
  ]);
  assert.equal(reduced.size, 1, 'only the pin target appears');
});

// ---------- effectivePinState (§3 author-first, item-over-project) ----------

test('effective: human project park + hermes item pin → parked governs, ordinal 3', () => {
  const reduced = reducePinEntries([
    E('park', 'arnaldo'),
    E('pin', 'hermes', { item: ITEM }),
  ]);
  const eff = effectivePinState(reduced, 'testscope', 'proj-p', ITEM.hash);
  assert.equal(eff.state, 'parked');
  assert.equal(eff.by, 'arnaldo');
  assert.equal(eff.level, 'project');
  assert.equal(eff.ordinal, 3);
});

test('effective: human project park + human item pin → the item pin governs, ordinal 0', () => {
  const reduced = reducePinEntries([
    E('park', 'arnaldo'),
    E('pin', 'arnaldo', { item: ITEM }),
  ]);
  const eff = effectivePinState(reduced, 'testscope', 'proj-p', ITEM.hash);
  assert.equal(eff.state, 'pinned');
  assert.equal(eff.level, 'item');
  assert.equal(eff.ordinal, 0);
});

test('effective: item beats project WITHIN the hermes author class too', () => {
  const reduced = reducePinEntries([
    E('park', 'hermes'),
    E('pin', 'hermes', { item: ITEM }),
  ]);
  const eff = effectivePinState(reduced, 'testscope', 'proj-p', ITEM.hash);
  assert.equal(eff.state, 'pinned');
  assert.equal(eff.by, 'hermes');
  assert.equal(eff.level, 'item');
  assert.equal(eff.ordinal, 1);
});

test('effective: ordinals — 0 human pin, 1 hermes pin, 2 neutral, 3 parked (any author)', () => {
  const o = (entries, hash) => effectivePinState(reducePinEntries(entries), 'testscope', 'proj-p', hash).ordinal;
  assert.equal(o([E('pin', 'arnaldo')]), 0);
  assert.equal(o([E('pin', 'hermes')]), 1);
  assert.equal(o([]), 2);
  assert.equal(o([E('park', 'arnaldo')]), 3);
  assert.equal(o([E('park', 'hermes')]), 3, 'parked ranks last regardless of author');
});

test('effective: no itemHashPrefix → project level only; neutral result shape', () => {
  const eff = effectivePinState(reducePinEntries([]), 'testscope', 'proj-p');
  assert.deepEqual(eff, { state: 'neutral', by: null, level: null, ordinal: 2, reason: null });
});
