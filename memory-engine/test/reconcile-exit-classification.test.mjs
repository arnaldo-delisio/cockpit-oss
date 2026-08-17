// reconcile-exit-classification.test.mjs — a quiet run and a failed run must not share an exit code.
//
// reconcile.mjs used to answer "did anything get minted" when a wrapper script asked "did this run
// work". Those are different questions: a night of small talk mints nothing and worked perfectly,
// while a night with an unreachable adapter also mints nothing and did not work at all.
//
// The rule under test, one case per test:
//   1. nothing new to read            -> exit 0, and silent (no warning to ignore every night).
//   2. real input, "nothing durable"  -> exit 0, with a plain notice. Every call answered.
//   3. a distill call failed          -> exit 1. The material is still unconsumed.
//   4. one unit failed, another minted -> exit 1. Partial success must not hide the failure.
//   5. a normal successful run        -> exit 0.
//
// Everything drives the REAL reconcile.mjs as a child process (that is where the exit code lives),
// with judge.mjs and retrieval.mjs swapped for the deterministic offline mocks via
// --import test/mem40-judge-register.mjs. An unreachable adapter is simulated with the mock's
// '__THROW__' sentinel: the real judge() surfaces a transport failure as a rejection, which is
// exactly what the reconciler sees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'exitclass-home');

const TS = '2026-08-14T09:00:00.000Z';
const NODE = { title: 'A durable probe rule', type: 'feedback', prose: 'Probe runs always state their rule.', centrality: 0.5, cluster: 'probe' };
const MINT = [{ action: 'new', backing: [0], centrality: 0.5, cluster: 'probe' }];

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
  await writeFile(resolve(TEST_MEMORY_ROOT, '.gitignore'), 'exitclass-home/\n.cache/\n', 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '-A']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'seed']);
}

// One staging file, two real turns. `mark` rides in the digest so the mock can route per work-unit.
async function writeStaging(scope, anchor, mark) {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging'), { recursive: true });
  const text = `---\ntype: staging\nscope: ${scope}\nbrain: claude\nsession_anchor: ${anchor}\n---\n\n`
    + `#### user · ${TS}  [decision]\nStanding rule ${mark}: probe runs always state their rule.\n\n`
    + `#### assistant · ${TS}  [#good]\nRecorded as a durable standing rule ${mark}.\n`;
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging', `${anchor}.md`), text, 'utf8');
}

// Runs the real CLI and returns its exit code plus its streams (never throws on non-zero).
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

// ================================================================ 1: nothing new is quiet AND silent

test('a run with no new staging or sources exits 0 and says nothing about yield', async () => {
  await gitInitOnce();
  const scope = 'exit1';
  await addScope(scope);

  const r = await run(scope, {});
  assert.equal(r.code, 0, 'an empty queue is a legitimate no-op, never a failure');
  assert.doesNotMatch(r.stderr, /FAILED/, 'nothing failed, so nothing may claim it did');
  assert.doesNotMatch(r.stderr, /produced NO node changes/,
    'a run with nothing to do must not warn about producing nothing — that is every quiet night');
});

// ================================================================ 2: "nothing durable" is a judgment

test('real input the model finds nothing durable in exits 0, with a notice instead of a failure', async () => {
  await gitInitOnce();
  const scope = 'exit2';
  await addScope(scope);
  await writeStaging(scope, 'nothing-durable', 'E2');

  const r = await run(scope, { distill: [] });
  assert.equal(r.code, 0, 'a model that answered "nothing here is durable" did its job');
  assert.match(r.stderr, /produced NO node changes/, 'the zero yield is still reported');
  assert.doesNotMatch(r.stderr, /FAILED/, 'a legitimate empty answer must not be labelled a failure');
});

// ================================================================ 3: an unusable answer is a failure

test('a distill call that throws exits non-zero and names the failed unit', async () => {
  await gitInitOnce();
  const scope = 'exit3';
  await addScope(scope);
  await writeStaging(scope, 'adapter-down', 'E3');

  const r = await run(scope, { distill: '__THROW__' });
  assert.equal(r.code, 1, 'a model call that produced no usable answer must exit non-zero');
  assert.match(r.stderr, /FAILED — 1 model call\(s\) produced no usable answer/);
  assert.match(r.stderr, /distill adapter-down\.md/, 'the failing work unit must be named');
});

// ================================================================ 4: mixed is failed

test('a run where one unit fails and another mints nodes still exits non-zero', async () => {
  await gitInitOnce();
  const scope = 'exit4';
  await addScope(scope);
  await writeStaging(scope, 'mixed-bad', 'E4BAD');
  await writeStaging(scope, 'mixed-good', 'E4GOOD');

  const r = await run(scope, {
    distillByMatch: { E4BAD: '__THROW__', E4GOOD: [NODE] },
    consolidate: MINT,
  });
  assert.match(r.stdout, /A durable probe rule/, 'control: the healthy unit must really have minted a node');
  assert.equal(r.code, 1, 'partial success must not hide a failed unit behind a green exit code');
  assert.match(r.stderr, /FAILED — 1 model call\(s\) produced no usable answer/);
});

// ================================================================ 5: a normal run is green

test('a run where every call answers and nodes are minted exits 0', async () => {
  await gitInitOnce();
  const scope = 'exit5';
  await addScope(scope);
  await writeStaging(scope, 'healthy', 'E5');

  const r = await run(scope, { distill: [NODE], consolidate: MINT });
  assert.match(r.stdout, /A durable probe rule/, 'control: the run must really have minted a node');
  assert.equal(r.code, 0, 'a successful run must be green');
  assert.doesNotMatch(r.stderr, /FAILED/);
});
