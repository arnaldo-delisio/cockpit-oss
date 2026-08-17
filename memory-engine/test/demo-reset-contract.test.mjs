// demo-reset-contract.test.mjs — the first-run contract INSTALL.md §9 documents.
//
// Two defects an engineer hit driving the export on a foreign machine, pinned here:
//
//   1. The documented demo reset produced a FALSE GREEN. Deleting the nodes without clearing the
//      consumed markers left every staging file marked read, so the re-run printed "no new staging
//      or sources to process" and exited 0 with --require-yield passed. Zero nodes, green smoke
//      test. That is worse than a crash: it teaches the reader to trust a meaningless pass.
//      The contract now has two halves, and both are tested:
//        • --require-yield fails a run that read nothing, not only one that read and yielded nothing;
//        • --forget-scope is the documented, executable second half of the reset, and a re-run
//          after it mints again.
//
//   2. Every fresh scope shipped a dangling `@`-import: the workspace CLAUDE.md imports
//      memory/scopes/<name>/CLAUDE.md, which nothing created until a reconcile happened to project
//      a rule into it. bootstrap now seeds it as an empty managed region, and a projection over
//      that region must be a byte-identical no-op rather than a spurious diff.
//
// Everything drives the REAL CLIs as child processes (that is where the exit codes and the bytes
// live), with judge.mjs and retrieval.mjs swapped for the deterministic offline mocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'reset-home');

const TS = '2026-08-14T09:00:00.000Z';
const NODE = { title: 'A durable reset probe rule', type: 'feedback', prose: 'Reset probes always state their rule.', centrality: 0.5, cluster: 'probe' };
const MINT = [{ action: 'new', backing: [0], centrality: 0.5, cluster: 'probe' }];

// projection.mjs renderFence(), the branch taken when neither layer holds a rule. Repeated here on
// purpose: this is the shape bootstrap.mjs seeds and publish/reset-managed-region.mjs ships, and a
// test that imported the constant from one of them could not catch the three drifting apart.
const EMPTY_FENCE = '<!-- managed:reconciler:begin schema=2 inputs=none -->\n'
  + '## Rules (projected from memory: do not edit; edit the source node)\n'
  + '_(no rules currently meet the always-load bar; see retrieval-gated memory)_\n'
  + '<!-- managed:reconciler:end -->\n';

const seenScopes = new Set();
async function addScope(scope) {
  seenScopes.add(scope);
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify([...seenScopes]), 'utf8');
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope), { recursive: true });
}

async function gitInitOnce() {
  if (gitInitOnce.done) return;
  gitInitOnce.done = true;
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'init', '--quiet']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.email', 'test@test.invalid']);
  await writeFile(resolve(TEST_MEMORY_ROOT, '.gitignore'), 'reset-home/\n.cache/\n', 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '-A']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'seed']);
}

async function writeStaging(scope, anchor, mark) {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging'), { recursive: true });
  const text = `---\ntype: staging\nscope: ${scope}\nbrain: claude\nsession_anchor: ${anchor}\n---\n\n`
    + `#### user · ${TS}  [decision]\nStanding rule ${mark}: reset probes always state their rule.\n\n`
    + `#### assistant · ${TS}  [#good]\nRecorded as a durable standing rule ${mark}.\n`;
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging', `${anchor}.md`), text, 'utf8');
}

// Runs the real reconcile CLI and returns its exit code plus its streams (never throws on non-zero).
async function run(scope, responses, extraArgs = []) {
  await mkdir(DRIVER_HOME, { recursive: true });
  const args = ['--import', resolve(ENGINE_DIR, 'test', 'mem40-judge-register.mjs'),
    resolve(ENGINE_DIR, 'reconcile.mjs'), '--scope', scope, ...extraArgs];
  const opts = {
    cwd: ENGINE_DIR,
    env: {
      COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin',
      MEM40_JUDGE_RESPONSES: JSON.stringify(responses),
    },
    maxBuffer: 16 * 1024 * 1024,
  };
  return execFileP(process.execPath, args, opts)
    .then((r) => ({ code: 0, ...r }))
    .catch((e) => ({ code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }));
}

// The nodes the last run minted, deleted and committed: the human half of the documented reset.
async function dropNodes() {
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'rm', '-r', '--quiet', '--ignore-unmatch', 'knowledge/nodes']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'demo: reset knowledge nodes']);
  await mkdir(resolve(TEST_MEMORY_ROOT, 'knowledge', 'nodes'), { recursive: true });
}

// ================================================================ 1: an empty queue is not a pass

test('--require-yield fails a run that had nothing left to read, instead of reporting a green no-op', async () => {
  await gitInitOnce();
  const scope = 'reset1';
  await addScope(scope);

  // Control: the same empty queue WITHOUT the flag is still a legitimate quiet no-op.
  const quiet = await run(scope, {});
  assert.equal(quiet.code, 0, 'the nightly pass must keep its tolerance for a night with nothing to read');

  const r = await run(scope, {}, ['--require-yield']);
  assert.equal(r.code, 1, 'under --require-yield, nothing to read is a failed assertion, not a pass');
  assert.match(r.stderr, /FAILED/, 'the failure must be stated, not left to the exit code alone');
  assert.match(r.stderr, /--forget-scope/, 'the message must name the command that fixes it');
});

// ================================================================ 2: a reset that clears nothing fails

test('deleting the nodes without clearing the consumed markers fails the smoke test', async () => {
  await gitInitOnce();
  const scope = 'reset2';
  await addScope(scope);
  await writeStaging(scope, 'reset-half', 'R2');

  const first = await run(scope, { distill: [NODE], consolidate: MINT }, ['--require-yield']);
  assert.equal(first.code, 0, 'control: the seeded material must really mint on the first run');
  assert.match(first.stdout, /A durable reset probe rule/);

  await dropNodes();

  const rerun = await run(scope, { distill: [NODE], consolidate: MINT }, ['--require-yield']);
  assert.equal(rerun.code, 1, 'a half-done reset must fail loudly, never hand back a green smoke test');
  assert.doesNotMatch(rerun.stdout, /A durable reset probe rule/, 'nothing was minted, and nothing may claim it was');
});

// ================================================================ 3: the documented reset works

test('--forget-scope completes the reset, and the same smoke test mints again', async () => {
  await gitInitOnce();
  const scope = 'reset3';
  await addScope(scope);
  await writeStaging(scope, 'reset-full', 'R3');

  const first = await run(scope, { distill: [NODE], consolidate: MINT }, ['--require-yield']);
  assert.equal(first.code, 0, 'control: the seeded material must really mint on the first run');

  await dropNodes();
  const forget = await run(scope, {}, ['--forget-scope', scope]);
  assert.equal(forget.code, 0, `--forget-scope must succeed: ${forget.stderr}`);
  assert.match(forget.stdout, /forgot 1 staging cursor/, 'the cursor it dropped must be reported, not silent');

  // The reset must leave memory/ clean: the reconciler refuses to run over an uncommitted tree.
  const status = (await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'status', '--porcelain', '--', '.reconciler', 'knowledge'])).stdout.trim();
  assert.equal(status, '', `--forget-scope left memory/ dirty: ${status}`);

  const rerun = await run(scope, { distill: [NODE], consolidate: MINT }, ['--require-yield']);
  assert.equal(rerun.code, 0, `the re-run after a complete reset must pass: ${rerun.stderr}`);
  assert.match(rerun.stdout, /A durable reset probe rule/, 'the re-run must mint the node again');
});

// ================================================================ 4: --forget-scope is narrow

test('--forget-scope refuses an unregistered scope and touches nothing', async () => {
  await gitInitOnce();
  const scope = 'reset4';
  await addScope(scope);
  await writeStaging(scope, 'reset-narrow', 'R4');
  await run(scope, { distill: [NODE], consolidate: MINT }, ['--require-yield']);

  const before = await readFile(resolve(TEST_MEMORY_ROOT, '.reconciler', 'state.json'), 'utf8');
  const r = await run(scope, {}, ['--forget-scope', 'no-such-scope']);
  assert.equal(r.code, 1, 'an unregistered scope must be refused');
  assert.equal(await readFile(resolve(TEST_MEMORY_ROOT, '.reconciler', 'state.json'), 'utf8'), before,
    'a refused --forget-scope must not have written state.json');
});

// A value-taking flag given no value used to reach path.resolve() as `undefined` and throw a raw
// TypeError, so malformed input got a Node stack trace instead of the refusal every other bad input
// gets. Same voice, same exit code, and nothing written.
test('--forget-scope with no value is refused cleanly, not with a stack trace', async () => {
  await gitInitOnce();
  const scope = 'reset4b';
  await addScope(scope);

  const before = await readFile(resolve(TEST_MEMORY_ROOT, '.reconciler', 'state.json'), 'utf8');
  const r = await run(scope, {}, ['--forget-scope']);
  assert.equal(r.code, 1, 'a missing option value must be refused with the usual refusal code');
  assert.match(r.stderr, /^reconcile: --forget-scope needs a value \(got nothing\)\.$/m,
    'the refusal must name the flag and what was wrong');
  assert.doesNotMatch(r.stderr, /TypeError|at Object|node:internal/, 'no raw stack trace may reach the user');
  assert.equal(await readFile(resolve(TEST_MEMORY_ROOT, '.reconciler', 'state.json'), 'utf8'), before,
    'a refused run must not have written state.json');
});

test('--scope with a flag-shaped value is refused instead of reconciling a scope named "--dry-run"', async () => {
  await gitInitOnce();
  // Run the CLI directly: the run() helper always supplies its own --scope.
  const direct = await execFileP(process.execPath, [resolve(ENGINE_DIR, 'reconcile.mjs'), '--scope', '--dry-run'],
    { cwd: ENGINE_DIR, env: { COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin' } })
    .then((x) => ({ code: 0, ...x }))
    .catch((e) => ({ code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }));
  assert.equal(direct.code, 1, 'a flag where a value belongs must be refused');
  assert.match(direct.stderr, /^reconcile: --scope needs a value \(got "--dry-run"\)\.$/m);
});

// ================================================================ 5: the scope import target exists

test('bootstrap seeds every data scope its projected CLAUDE.md, so the workspace @-import resolves', async () => {
  const root = resolve(TEST_MEMORY_ROOT, 'bootstrap-import-target');
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'scopes.json'), '["my-venture"]\n', 'utf8');

  await execFileP(process.execPath, [resolve(ENGINE_DIR, 'bootstrap.mjs')],
    { env: { ...process.env, COCKPIT_MEMORY_ROOT: root } });

  const shell = resolve(root, 'scopes', 'my-venture', 'CLAUDE.md');
  assert.equal(await readFile(shell, 'utf8'), EMPTY_FENCE,
    'the seeded shell must be the exact empty managed region the reconciler renders');
});

// ================================================================ 6: and projecting over it is a no-op

test('a reconcile over a freshly seeded scope shell leaves it byte-identical', async () => {
  await gitInitOnce();
  const scope = 'reset6';
  await addScope(scope);
  const shell = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');
  await writeFile(shell, EMPTY_FENCE, 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '--', `scopes/${scope}/CLAUDE.md`]);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'seed scope shell']);
  await writeStaging(scope, 'reset-projection', 'R6');

  const r = await run(scope, { distill: [NODE], consolidate: MINT });
  assert.equal(r.code, 0, `the run must succeed: ${r.stderr}`);
  assert.equal(await readFile(shell, 'utf8'), EMPTY_FENCE,
    'a projection with no rule to promote must not rewrite the seeded region');
});

// ================================================================ 7: bootstrap validates before writing

test('bootstrap refuses a missing scopes.json and leaves nothing behind', async () => {
  const root = resolve(TEST_MEMORY_ROOT, 'bootstrap-no-scopes');
  await mkdir(root, { recursive: true });

  const r = await execFileP(process.execPath, [resolve(ENGINE_DIR, 'bootstrap.mjs')],
    { env: { ...process.env, COCKPIT_MEMORY_ROOT: root } })
    .then(() => ({ code: 0 })).catch((e) => ({ code: e.code, stderr: e.stderr || '' }));
  assert.equal(r.code, 1, 'a missing scopes.json must still refuse');

  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(root), [],
    'a refused bootstrap must leave an empty root, not a half-built knowledge/ tree');
});
