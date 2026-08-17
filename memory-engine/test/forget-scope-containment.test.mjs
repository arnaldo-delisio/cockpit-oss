// forget-scope-containment.test.mjs — the two walls --forget-scope's stated contract needs.
//
// The contract (reconcile.mjs, the --forget-scope header): it forgets that material was READ. It
// never deletes a node, never touches knowledge/, and never reaches outside the named scope.
//
// Two ways it used to break that promise, pinned here:
//
//   1. CONTAINMENT. The scope gate used stat(), which follows symlinks, and the source loop
//      rewrote whatever filename it was handed. So a symlinked scope directory, a symlinked
//      sources/ directory, or a single symlinked sources/*.md pointing at knowledge/ (or at any
//      writable path outside the tree) was read and rewritten. The command now refuses each,
//      never follows one, and leaves the link target byte-identical.
//
//   2. ALL-OR-NOTHING. parseSource returns `frontmatter: null` for malformed YAML, and the loop
//      dereferenced it. A malformed source AFTER a valid one therefore crashed once the valid
//      ones had already been rewritten, with state.json neither saved nor committed: a dirty,
//      half-reset tree, which the reconciler then refuses to run over. Validation now happens
//      for every candidate before any write.
//
// Drives the REAL CLI as a child process: the exit codes and the bytes on disk are the subject.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');

const MARKED = (mark) => `---\ntitle: source ${mark}\ntype: source\ndistilled_into: node-${mark}\n---\n\nBody of ${mark}.\n`;
const MALFORMED = '---\ntitle: broken\n  bad: [unclosed\ndistilled_into: node-x\n---\n\nBody of the broken source.\n';

// One scope's worth of tree, in a memory root that is a real git repo (the commit step needs one).
async function seedScope(scope) {
  const root = TEST_MEMORY_ROOT;
  await mkdir(resolve(root, '.reconciler'), { recursive: true });
  await mkdir(resolve(root, 'knowledge', 'nodes'), { recursive: true });
  await mkdir(resolve(root, 'scopes', scope, 'sources'), { recursive: true });
  await writeFile(resolve(root, '.reconciler', 'state.json'), JSON.stringify({ consumed: {} }), 'utf8');
  if (!seedScope.git) {
    seedScope.git = true;
    await execFileP('git', ['-C', root, 'init', '--quiet']);
    await execFileP('git', ['-C', root, 'config', 'user.name', 'Test']);
    await execFileP('git', ['-C', root, 'config', 'user.email', 'test@test.invalid']);
  }
  return root;
}

async function commitAll(root) {
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed', '--allow-empty']);
}

async function forget(scope, extraArgs = []) {
  return execFileP(process.execPath, [resolve(ENGINE_DIR, 'reconcile.mjs'), '--forget-scope', scope, ...extraArgs], {
    cwd: ENGINE_DIR,
    env: { COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: resolve(TEST_MEMORY_ROOT, 'forget-home'), PATH: '/usr/bin:/bin' },
    maxBuffer: 16 * 1024 * 1024,
  }).then((r) => ({ code: 0, ...r })).catch((e) => ({ code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }));
}

const dirty = async (root) => (await execFileP('git', ['-C', root, 'status', '--porcelain'])).stdout.trim();

// ================================================================ 1: a symlinked source escapes nothing

test('a sources/*.md symlink pointing outside the scope is refused, and its target is untouched', async () => {
  const scope = 'esc1';
  const root = await seedScope(scope);
  const outside = resolve(root, 'knowledge', 'nodes', 'victim.md');
  const victim = MARKED('victim');
  await writeFile(outside, victim, 'utf8');
  await writeFile(resolve(root, 'scopes', scope, 'sources', 'real.md'), MARKED('real'), 'utf8');
  await commitAll(root);
  await symlink(outside, resolve(root, 'scopes', scope, 'sources', 'escape.md'));

  const r = await forget(scope);
  assert.equal(r.code, 1, `a symlinked source must be refused: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /escape\.md/, 'the refusal must name the offending file');
  assert.match(r.stderr, /symlink/i, 'and say why');

  assert.equal(await readFile(outside, 'utf8'), victim,
    'the link target outside the scope must be byte-identical: --forget-scope never touches knowledge/');
  assert.equal(await readFile(resolve(root, 'scopes', scope, 'sources', 'real.md'), 'utf8'), MARKED('real'),
    'a refusal writes nothing at all, including the valid sources it had already validated');

  await rm(resolve(root, 'scopes', scope, 'sources', 'escape.md'));
});

// ================================================================ 2: a symlinked scope dir is refused

test('a symlinked scope directory is refused, not followed', async () => {
  const root = await seedScope('esc2');
  const elsewhere = resolve(root, 'outside-tree', 'sources');
  await mkdir(elsewhere, { recursive: true });
  const victim = MARKED('outside');
  await writeFile(resolve(elsewhere, 'victim.md'), victim, 'utf8');
  await symlink(resolve(root, 'outside-tree'), resolve(root, 'scopes', 'esc2link'));

  const r = await forget('esc2link');
  assert.equal(r.code, 1, 'a symlinked scope directory must be refused');
  assert.match(r.stderr, /real \(non-symlink\)/, 'the refusal must say a real directory is required');
  assert.equal(await readFile(resolve(elsewhere, 'victim.md'), 'utf8'), victim, 'nothing beyond the link is touched');
});

// ================================================================ 3: a symlinked sources/ dir is refused

test('a symlinked sources/ directory is refused, not followed', async () => {
  const scope = 'esc3';
  const root = await seedScope(scope);
  await rm(resolve(root, 'scopes', scope, 'sources'), { recursive: true });
  const elsewhere = resolve(root, 'outside-sources');
  await mkdir(elsewhere, { recursive: true });
  const victim = MARKED('outside3');
  await writeFile(resolve(elsewhere, 'victim.md'), victim, 'utf8');
  await symlink(elsewhere, resolve(root, 'scopes', scope, 'sources'));

  const r = await forget(scope);
  assert.equal(r.code, 1, 'a symlinked sources/ directory must be refused');
  assert.match(r.stderr, /sources is not a real directory/);
  assert.equal(await readFile(resolve(elsewhere, 'victim.md'), 'utf8'), victim, 'nothing beyond the link is touched');
});

// ================================================================ 4: malformed source, no partial write

test('a malformed source after a valid one aborts the whole reset, writing nothing', async () => {
  const scope = 'partial';
  const root = await seedScope(scope);
  const dir = resolve(root, 'scopes', scope, 'sources');
  // 'a-' sorts before 'z-': the valid source is processed FIRST, so a per-file loop would have
  // rewritten it before reaching the malformed one.
  await writeFile(resolve(dir, 'a-valid.md'), MARKED('valid'), 'utf8');
  await writeFile(resolve(dir, 'z-broken.md'), MALFORMED, 'utf8');
  await writeFile(resolve(root, '.reconciler', 'state.json'),
    JSON.stringify({ consumed: { [`${resolve(root, 'scopes', scope, 'staging', 's.md')}`]: 'sha' } }), 'utf8');
  await commitAll(root);

  const r = await forget(scope);
  assert.equal(r.code, 1, 'an unclearable source must abort the reset, not half-do it');
  assert.match(r.stderr, /z-broken\.md/, 'the refusal must name the file to fix');
  assert.match(r.stderr, /malformed YAML/);
  assert.match(r.stderr, /Nothing was written/);

  assert.equal(await readFile(resolve(dir, 'a-valid.md'), 'utf8'), MARKED('valid'),
    'the valid source must keep its marker: the reset either happens completely or not at all');
  assert.match(await readFile(resolve(root, '.reconciler', 'state.json'), 'utf8'), /staging/,
    'the cursors must survive an aborted reset');
  assert.equal(await dirty(root), '', 'an aborted reset must leave the tree clean, never dirty and uncommitted');
});

// ================================================================ 4b: a lexically-in-scope cursor key that resolves out

test('a consumed key whose lexical prefix is in scope but which resolves outside it is left alone', async () => {
  const scope = 'lex';
  const root = await seedScope(scope);
  await mkdir(resolve(root, 'scopes', 'other', 'staging'), { recursive: true });
  const inside = resolve(root, 'scopes', scope, 'staging', 'mine.md');
  // Carries `<scopeDir>/` as a literal prefix, but normalizes to another scope's staging file.
  const escaping = `${resolve(root, 'scopes', scope)}/../other/staging/theirs.md`;
  await writeFile(resolve(root, '.reconciler', 'state.json'),
    JSON.stringify({ consumed: { [inside]: 'sha-a', [escaping]: 'sha-b' } }), 'utf8');
  await commitAll(root);

  const r = await forget(scope);
  assert.equal(r.code, 0, `the reset must still succeed: ${r.stderr}`);
  const state = JSON.parse(await readFile(resolve(root, '.reconciler', 'state.json'), 'utf8'));
  assert.equal(state.consumed[inside], undefined, 'the genuinely in-scope cursor must be forgotten');
  assert.equal(state.consumed[escaping], 'sha-b',
    'a key that normalizes outside the scope must survive: --forget-scope never reaches outside the named scope');
  assert.match(r.stdout, /forgot 1 staging cursor\(s\)/, 'and only the contained cursor may be counted');
});

// ================================================================ 5: the happy path still works

test('a clean scope still resets: markers cleared, cursors dropped, tree committed clean', async () => {
  const scope = 'clean';
  const root = await seedScope(scope);
  const dir = resolve(root, 'scopes', scope, 'sources');
  await writeFile(resolve(dir, 'one.md'), MARKED('one'), 'utf8');
  await writeFile(resolve(root, '.reconciler', 'state.json'),
    JSON.stringify({ consumed: { [`${resolve(root, 'scopes', scope, 'staging', 's.md')}`]: 'sha' } }), 'utf8');
  await commitAll(root);

  const r = await forget(scope);
  assert.equal(r.code, 0, `the happy path must still succeed: ${r.stderr}`);
  assert.match(r.stdout, /forgot 1 staging cursor\(s\), 1 source marker\(s\)/);
  const after = await readFile(resolve(dir, 'one.md'), 'utf8');
  assert.doesNotMatch(after, /distilled_into/, 'the terminal marker must be gone');
  assert.match(after, /Body of one\./, 'the body must survive');
  assert.equal(await dirty(root), '', 'the reset must commit its own writes');
});
