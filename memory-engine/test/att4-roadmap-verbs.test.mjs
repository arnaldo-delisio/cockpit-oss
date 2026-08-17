// att4-roadmap-verbs.test.mjs — ATT-4 step 1: roadmap.mjs add/check/move + the §8 transaction
// contract, driven as a REAL child-process CLI against per-scenario fixture memory roots
// (own git repo, scopes/<scope>/projects/*.md + .roadmap.md). Authored as the independent
// test pass.
//
// Exit-65 (stale snapshot) note: the snapshot is taken and re-checked inside one child run
// while the lock is held, so a test cannot interpose between parse and rename without racing
// or contorting the implementation. Covered here only indirectly (the precondition code path
// is shared with decisions.mjs); stated as partial in the pass report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const ROADMAP_CLI = resolve(ENGINE_DIR, 'roadmap.mjs');

const PROJECT_FM = `---
id: proj-a
title: Project A
type: project
state: active
scope: testscope
---

Project A body.
`;

const ROADMAP = `# proj-a roadmap

## Now

- [ ] First item alpha
- [x] Completed now item

## Next

- [ ] Second item beta gamma delta

## Done

- [x] Ancient finished thing
`;

let seq = 0;
async function makeRoot(name, { roadmap = ROADMAP } = {}) {
  const root = resolve(TEST_MEMORY_ROOT, 'roadmap-roots', `${String(++seq).padStart(2, '0')}-${name}`);
  const projDir = resolve(root, 'scopes', 'testscope', 'projects');
  await mkdir(projDir, { recursive: true });
  await mkdir(resolve(root, '.reconciler'), { recursive: true });
  await writeFile(resolve(projDir, 'proj-a.md'), PROJECT_FM, 'utf8');
  await writeFile(resolve(projDir, 'proj-a.roadmap.md'), roadmap, 'utf8');
  await execFileP('git', ['-C', root, 'init', '--quiet']);
  await execFileP('git', ['-C', root, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', root, 'config', 'user.email', 'test@test.invalid']);
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed']);
  return root;
}

function run(root, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ROADMAP_CLI, ...args], {
      env: {
        ...process.env, COCKPIT_MEMORY_ROOT: root, PATH: '/usr/bin:/bin', HOME: root,
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

const roadmapPath = (root) => resolve(root, 'scopes', 'testscope', 'projects', 'proj-a.roadmap.md');
const roadmapBytes = (root) => readFile(roadmapPath(root), 'utf8');
async function commitCount(root) {
  const { stdout } = await execFileP('git', ['-C', root, 'rev-list', '--all', '--count']);
  return Number(stdout.trim());
}
async function gitHead(root) {
  const { stdout } = await execFileP('git', ['-C', root, 'show', '--name-only', '--format=%s', 'HEAD']);
  return stdout;
}
function section(text, name) {
  const m = text.match(new RegExp(`^## ${name}[ \\t]*$`, 'm'));
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

// ---------- add ----------

test('add: default section is next, conventional line at body end, ONE path-scoped commit', async () => {
  const root = await makeRoot('add-default');
  await writeFile(resolve(root, 'scopes', 'testscope', 'bystander.md'), 'dirty\n', 'utf8');
  const commits = await commitCount(root);
  const r = await run(root, ['add', 'proj-a', 'Wire the comparator tiebreak']);
  assert.equal(r.code, 0, r.stderr);
  const text = await roadmapBytes(root);
  assert.match(section(text, 'Next'), /- \[ \] Wire the comparator tiebreak\n/);
  assert.doesNotMatch(section(text, 'Now'), /Wire the comparator/);
  assert.doesNotMatch(section(text, 'Done'), /Wire the comparator/);
  // the new line must sit at the section BODY END (after the existing next item)
  assert.ok(text.indexOf('Wire the comparator') > text.indexOf('Second item beta'), 'appended after existing items');
  assert.equal(await commitCount(root), commits + 1, 'exactly one commit');
  const head = await gitHead(root);
  assert.match(head, /roadmap: add proj-a/);
  assert.match(head, /scopes\/testscope\/projects\/proj-a\.roadmap\.md/);
  assert.doesNotMatch(head, /bystander/, 'commit is pathspec-scoped to the roadmap file alone');
});

test('add --section now lands in Now', async () => {
  const root = await makeRoot('add-now');
  const r = await run(root, ['add', 'proj-a', 'Urgent thing zulu', '--section', 'now']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(section(await roadmapBytes(root), 'Now'), /- \[ \] Urgent thing zulu/);
});

test('add: exact duplicate (case/whitespace differ) → no-op SUCCESS exit 0, file byte-identical, no commit', async () => {
  const root = await makeRoot('add-dup');
  const before = await roadmapBytes(root);
  const commits = await commitCount(root);
  const r = await run(root, ['add', 'proj-a', 'FIRST   item Alpha']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already present/);
  assert.equal(await roadmapBytes(root), before);
  assert.equal(await commitCount(root), commits, 'no-op must not commit');
});

test('add: near-duplicate (similarity ≥ 0.6 vs an open item) → refusal exit 1 naming the match, file unchanged', async () => {
  const root = await makeRoot('add-near');
  const before = await roadmapBytes(root);
  // {first,item,alpha,extra} vs {first,item,alpha} = 3/4 = 0.75
  const r = await run(root, ['add', 'proj-a', 'First item alpha extra']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /near-duplicate/);
  assert.match(r.stderr, /First item alpha/);
  assert.equal(await roadmapBytes(root), before);
});

test('add: similarity to a DONE-section item is not screened (open items only)', async () => {
  const root = await makeRoot('add-done-sim');
  const r = await run(root, ['add', 'proj-a', 'Ancient finished thing again']);
  assert.equal(r.code, 0, r.stderr);
});

test('add: > 280 chars → refusal exit 1, nothing written', async () => {
  const root = await makeRoot('add-long');
  const before = await roadmapBytes(root);
  const r = await run(root, ['add', 'proj-a', 'a'.repeat(300)]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /too long/);
  assert.equal(await roadmapBytes(root), before);
});

test('add: > 2 sentences → refusal exit 1', async () => {
  const root = await makeRoot('add-sentences');
  const r = await run(root, ['add', 'proj-a', 'One thing. Two things. Three things.']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /sentences/);
});

test('add: pointer strips one token only — prose after a mid-text pointer counts toward the cap', async () => {
  const root = await makeRoot('add-pointer-prose');
  const r = await run(root, ['add', 'proj-a', 'One thing. Two things. → decisions/x.md. Three things.']);
  assert.equal(r.code, 1, 'the third sentence after the pointer must still count');
  assert.match(r.stderr, /sentences/);
});

test('add: pointer-only tail is not counted — two sentences plus a trailing → pointer accepted', async () => {
  const root = await makeRoot('add-pointer-tail');
  const r = await run(root, ['add', 'proj-a', 'Ship the comparator. Verify twice. → decisions/x.md']);
  assert.equal(r.code, 0, r.stderr);
});

test('add --section done → refusal exit 1', async () => {
  const root = await makeRoot('add-to-done');
  const before = await roadmapBytes(root);
  const r = await run(root, ['add', 'proj-a', 'sneak into done', '--section', 'done']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /never done/);
  assert.equal(await roadmapBytes(root), before);
});

test('add: non-active project → refusal', async () => {
  const root = await makeRoot('add-parked');
  const projDir = resolve(root, 'scopes', 'testscope', 'projects');
  await writeFile(resolve(projDir, 'proj-a.md'), PROJECT_FM.replace('state: active', 'state: parked'), 'utf8');
  const r = await run(root, ['add', 'proj-a', 'should not land']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not active/);
});

test('add --dry-run: exit 0, nothing written, no commit, preview printed', async () => {
  const root = await makeRoot('add-dry');
  const before = await roadmapBytes(root);
  const commits = await commitCount(root);
  const r = await run(root, ['add', 'proj-a', 'Preview only item', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /--dry-run: nothing written/);
  assert.equal(await roadmapBytes(root), before);
  assert.equal(await commitCount(root), commits);
});

// ---------- check ----------

test('check: sets [x] by match text, one path-scoped commit; re-run is idempotent no-op (exit 0, NO new commit)', async () => {
  const root = await makeRoot('check-idem');
  const r1 = await run(root, ['check', 'proj-a', 'Second item beta']);
  assert.equal(r1.code, 0, r1.stderr);
  const after1 = await roadmapBytes(root);
  assert.match(section(after1, 'Next'), /- \[x\] Second item beta gamma delta/);
  const commits = await commitCount(root);
  assert.match(await gitHead(root), /roadmap: check proj-a/);

  const r2 = await run(root, ['check', 'proj-a', 'Second item beta']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /already checked/);
  assert.equal(await roadmapBytes(root), after1, 'idempotent set-done must not flip back (never a toggle)');
  assert.equal(await commitCount(root), commits, 'no-op must not commit');
});

test('check --undo: unchecks; already-unchecked --undo is a no-op success', async () => {
  const root = await makeRoot('check-undo');
  const r1 = await run(root, ['check', 'proj-a', 'Completed now item', '--undo']);
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(section(await roadmapBytes(root), 'Now'), /- \[ \] Completed now item/);
  const after = await roadmapBytes(root);
  const commits = await commitCount(root);
  const r2 = await run(root, ['check', 'proj-a', 'Completed now item', '--undo']);
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /already unchecked/);
  assert.equal(await roadmapBytes(root), after);
  assert.equal(await commitCount(root), commits);
});

test('check: ambiguous match text → refusal, numeric index without --section → refusal', async () => {
  const root = await makeRoot('check-ambig');
  const before = await roadmapBytes(root);
  const r = await run(root, ['check', 'proj-a', 'item']);   // matches several
  assert.equal(r.code, 1);
  assert.match(r.stderr, /matched \d+ items/);
  const rIdx = await run(root, ['check', 'proj-a', '0']);
  assert.equal(rIdx.code, 1);
  assert.match(rIdx.stderr, /needs an explicit --section/);
  assert.equal(await roadmapBytes(root), before);
});

test('check: no match → refusal exit 1', async () => {
  const root = await makeRoot('check-nomatch');
  const r = await run(root, ['check', 'proj-a', 'no such text anywhere']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no item matched/);
});

// ---------- move ----------

test('move: now → done relocates the block intact, no line fusion, one commit', async () => {
  const root = await makeRoot('move-basic');
  const r = await run(root, ['move', 'proj-a', 'First item alpha', '--to', 'done']);
  assert.equal(r.code, 0, r.stderr);
  const text = await roadmapBytes(root);
  assert.doesNotMatch(section(text, 'Now'), /First item alpha/);
  assert.match(section(text, 'Done'), /^- \[ \] First item alpha$/m, 'block lands on its own line, done state preserved');
  assert.doesNotMatch(text, /thing- \[/, 'no fused seam');
  assert.match(await gitHead(root), /roadmap: move proj-a/);
});

test('move: seam guard — target body without trailing newline gets one, no fusion', async () => {
  const noTrailing = ROADMAP.trimEnd();   // Done body now ends "...Ancient finished thing" with no \n
  const root = await makeRoot('move-seam', { roadmap: noTrailing });
  const r = await run(root, ['move', 'proj-a', 'First item alpha', '--to', 'done']);
  assert.equal(r.code, 0, r.stderr);
  const text = await roadmapBytes(root);
  assert.match(text, /- \[x\] Ancient finished thing\n- \[ \] First item alpha\n/, 'seam must be a real line break');
  assert.doesNotMatch(text, /Ancient finished thing- \[/);
});

test('move: no-op to the same section → exit 0, file byte-identical, no commit', async () => {
  const root = await makeRoot('move-noop');
  const before = await roadmapBytes(root);
  const commits = await commitCount(root);
  const r = await run(root, ['move', 'proj-a', 'Second item beta', '--to', 'next']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already in next, no-op/);
  assert.equal(await roadmapBytes(root), before);
  assert.equal(await commitCount(root), commits);
});

test('move no-op replay is identity when HEAD already has the item in the target section: an uncommitted human REORDER is not absorbed', async () => {
  const root = await makeRoot('move-reorder-foreign');
  // HEAD Now: [First item alpha, Completed now item]. Working: same items reordered so
  // 'First item alpha' sits at the section end — exactly what a cut-and-append replay of
  // `move --to now` from HEAD would produce, but the true interrupted verb was a no-op.
  const dirty = ROADMAP.replace(
    '- [ ] First item alpha\n- [x] Completed now item\n',
    '- [x] Completed now item\n- [ ] First item alpha\n',
  );
  await writeFile(roadmapPath(root), dirty, 'utf8');
  const commits = await commitCount(root);
  const r = await run(root, ['move', 'proj-a', 'First item alpha', '--to', 'now']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already in now, no-op/);
  assert.match(r.stderr, /did not produce; left untouched/);
  assert.equal(await commitCount(root), commits, 'a human reorder must not be committed as crash residue');
  assert.equal(await roadmapBytes(root), dirty, 'dirty state left byte-identical');
});

test('move: missing --to → usage exit 1', async () => {
  const root = await makeRoot('move-noto');
  const r = await run(root, ['move', 'proj-a', 'First item alpha']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /move needs --to/);
});

// ---------- heal-on-no-op (§8 rename-landed-commit-missed crash window) ----------

test('check: rename landed but commit missed → the no-op retry heals the tree with a heal commit', async () => {
  const root = await makeRoot('check-heal');
  const r1 = await run(root, ['check', 'proj-a', 'Second item beta']);
  assert.equal(r1.code, 0, r1.stderr);
  // simulate the crash window: undo the commit, keep the written file (modified-uncommitted)
  await execFileP('git', ['-C', root, 'reset', '--mixed', '--quiet', 'HEAD~1']);
  const r2 = await run(root, ['check', 'proj-a', 'Second item beta']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /already checked/);
  const { stdout: status } = await execFileP('git', ['-C', root, 'status', '--porcelain']);
  assert.equal(status.trim(), '', 'residue must be committed by the heal');
  assert.match(await gitHead(root), /roadmap: check proj-a \(commit heal\)/);
});

test('check no-op over FOREIGN residue: an unrelated uncommitted roadmap edit is NOT absorbed', async () => {
  const root = await makeRoot('check-foreign');
  // 'Completed now item' is already checked, so this check is a no-op; pre-dirty the roadmap
  // with an unrelated edit no interrupted identical verb could have produced from HEAD.
  const dirty = ROADMAP + '- [ ] Unrelated mid-session scribble\n';
  await writeFile(roadmapPath(root), dirty, 'utf8');
  const commits = await commitCount(root);
  const r = await run(root, ['check', 'proj-a', 'Completed now item']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already checked/);
  assert.match(r.stderr, /did not produce; left untouched/);
  assert.equal(await commitCount(root), commits, 'foreign residue must not be committed');
  assert.equal(await roadmapBytes(root), dirty, 'dirty state left byte-identical');
});

// ---------- transaction contract (§8) ----------

test('lock held by a LIVE pid → exit 75, file unchanged, lock not stolen', async () => {
  const root = await makeRoot('lock-live');
  const lockPath = resolve(root, '.reconciler', 'lock');
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  const before = await roadmapBytes(root);
  const r = await run(root, ['add', 'proj-a', 'blocked by the fence']);
  assert.equal(r.code, 75);
  assert.match(r.stderr, /busy/);
  assert.equal(await roadmapBytes(root), before, 'busy path must not write');
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid, 'live lock survives');
});

test('lock held by a DEAD pid → stale-steal, verb succeeds, lock released after', async () => {
  const root = await makeRoot('lock-dead');
  const child = spawn(process.execPath, ['-e', '']);
  const deadPid = child.pid;
  await new Promise((res) => child.on('exit', res));
  const lockPath = resolve(root, '.reconciler', 'lock');
  await writeFile(lockPath, JSON.stringify({ pid: deadPid, at: 'then' }), 'utf8');
  const r = await run(root, ['add', 'proj-a', 'lands past a stale lock']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(await roadmapBytes(root), /lands past a stale lock/);
  await assert.rejects(() => readFile(lockPath, 'utf8'), 'lock must be released in the finally');
});
