// staging-consumption.test.mjs — OSS-2: consumption follows real distillation, never attendance.
//
// The bug: PHASE 2 advanced `state.consumed[file]` for every staging work-unit that entered the run,
// including units whose distill threw, timed out, or returned a non-array, and units whose scope-level
// consolidation failed. A first run that yielded nothing therefore ate the material anyway, and the
// second run reported "no new staging or sources to process": a user whose first run failed could not
// retry at all.
//
// The rule under test, stated as three cases:
//   1. distill FAILED (non-array reply) -> cursor untouched, the same turns are re-read next run.
//   2. distill returned [] (a real "nothing durable here") -> cursor advances; a genuinely empty
//      conversation is terminal, not reprocessed forever. This is the counterweight to case 1.
//   3. distill parsed but CONSOLIDATION failed -> cursor untouched (the candidates never landed).
// Plus the loud-failure half: a run that read input and produced nothing warns on stderr, and exits
// non-zero only under --require-yield.
//
// Everything drives the REAL reconcile.mjs main() in a child process (step9-reconcile-driver.mjs)
// with judge.mjs swapped for the deterministic offline mock (mem40-judge-register/loader/mock.mjs),
// because the consumed marker is written by unexported code deep inside main(). Assertions read
// `.reconciler/state.json` from disk, which is the artifact the next run actually consults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'consumption-home');
const PROMPT_LOG = resolve(DRIVER_HOME, 'consumption-prompts.jsonl');
const STATE_FILE = resolve(TEST_MEMORY_ROOT, '.reconciler', 'state.json');

const TS = '2026-08-05T09:00:00.000Z';
const NODE = { title: 'A durable probe rule', type: 'feedback', prose: 'Probe runs always state their rule.', centrality: 0.5, cluster: 'probe' };

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
  await writeFile(resolve(TEST_MEMORY_ROOT, '.gitignore'), 'consumption-home/\n.cache/\n', 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '-A']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'seed']);
}

function stagingPath(scope, anchor) {
  return resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging', `${anchor}.md`);
}

// One staging file, two real turns, digest-substantive (the [decision] marker keeps it out of
// buildDigest's noise filter).
async function writeStaging(scope, anchor) {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging'), { recursive: true });
  const text = `---\ntype: staging\nscope: ${scope}\nbrain: claude\nsession_anchor: ${anchor}\n---\n\n`
    + `#### user · ${TS}  [decision]\nStanding rule for ${anchor}: probe runs always state their rule.\n\n`
    + `#### assistant · ${TS}  [#good]\nRecorded as a durable standing rule for ${anchor}.\n`;
  await writeFile(stagingPath(scope, anchor), text, 'utf8');
  return stagingPath(scope, anchor);
}

async function consumedFor(file) {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')).consumed[file]; } catch { return undefined; }
}

// Runs main() in-process-per-child via the shared driver. `extraArgs` reaches main()'s own argv read.
async function runDriver(scope, responses = {}, extraArgs = []) {
  await mkdir(DRIVER_HOME, { recursive: true });
  await rm(PROMPT_LOG, { force: true });
  const args = ['--import', resolve(ENGINE_DIR, 'test', 'mem40-judge-register.mjs'),
    resolve(ENGINE_DIR, 'test', 'step9-reconcile-driver.mjs'), '--scope', scope, ...extraArgs];
  const { stdout, stderr } = await execFileP(process.execPath, args, {
    cwd: ENGINE_DIR,
    env: {
      COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin',
      MEM40_JUDGE_RESPONSES: JSON.stringify(responses), MEM40_PROMPT_LOG: PROMPT_LOG,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.match(stdout, /___DONE___/, `driver did not complete; stdout: ${stdout}\nstderr: ${stderr}`);
  let prompts = [];
  try {
    prompts = (await readFile(PROMPT_LOG, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).prompt);
  } catch { /* no judge call at all */ }
  return { prompts, stdout, stderr };
}

const distillPromptsFor = (prompts, scope) =>
  prompts.filter((p) => !p.includes('SOURCE DOCUMENT') && p.includes(`distiller for the "${scope}" scope`));

// ================================================================ 1: a FAILED distill consumes nothing

test('a non-array distill leaves the consumed cursor untouched, and the next run re-reads the same turns', async () => {
  await gitInitOnce();
  const scope = 'consume1';
  await addScope(scope);
  const file = await writeStaging(scope, 'failed-distill');

  const run1 = await runDriver(scope, { distill: 'not-json-at-all' });
  assert.equal(distillPromptsFor(run1.prompts, scope).length, 1, 'control: the file must have reached distill');
  // 0 (or absent), never 2: the scan itself records a clamped starting cursor for every file it
  // reads, so "untouched" means "not advanced past the turns it failed on".
  assert.notEqual(await consumedFor(file), 2, 'a run whose distill failed must NOT mark the file consumed');
  assert.equal(await consumedFor(file) || 0, 0, 'the cursor must still sit before the failed turns');

  // and the retry is real: the same turns come back as work on the next run.
  const run2 = await runDriver(scope, { distill: 'not-json-at-all' });
  assert.equal(distillPromptsFor(run2.prompts, scope).length, 1, 'the failed material must be re-read, not swallowed');
  assert.ok(distillPromptsFor(run2.prompts, scope)[0].includes('probe runs always state their rule'),
    'the retry must carry the SAME turns, not an empty digest');
});

// ================================================================ 2: an empty distill IS terminal

test('an empty-array distill advances the cursor, so a genuinely empty conversation is not reprocessed forever', async () => {
  await gitInitOnce();
  const scope = 'consume2';
  await addScope(scope);
  const file = await writeStaging(scope, 'empty-distill');

  const run1 = await runDriver(scope, { distill: [] });
  assert.equal(distillPromptsFor(run1.prompts, scope).length, 1, 'control: the file must have reached distill');
  assert.equal(await consumedFor(file), 2, 'a clean "nothing durable here" is terminal: cursor advances to the turn count');

  const run2 = await runDriver(scope, { distill: [] });
  assert.equal(distillPromptsFor(run2.prompts, scope).length, 0, 'the terminal file must never be re-distilled');
});

// ================================================================ 3: a failed consolidation consumes nothing

test('a parsed distill whose consolidation failed leaves the cursor untouched', async () => {
  await gitInitOnce();
  const scope = 'consume3';
  await addScope(scope);
  const file = await writeStaging(scope, 'failed-consolidate');

  const responses = { distill: [NODE], consolidate: 'not-an-array' };
  const run1 = await runDriver(scope, responses);
  assert.equal(distillPromptsFor(run1.prompts, scope).length, 1, 'control: the file must have reached distill');
  assert.notEqual(await consumedFor(file), 2,
    'candidates that never reached a settled consolidation must not consume the staging that produced them');
  assert.equal(await consumedFor(file) || 0, 0, 'the cursor must still sit before those turns');

  const run2 = await runDriver(scope, responses);
  assert.equal(distillPromptsFor(run2.prompts, scope).length, 1, 'the material must retry whole');
});

// ================================================================ the loud-failure half

test('a run that read input and produced nothing warns loudly, and exits non-zero only under --require-yield', async () => {
  await gitInitOnce();
  const scope = 'consume4';
  await addScope(scope);
  await writeStaging(scope, 'zero-yield');

  const run = await runDriver(scope, { distill: [] });
  assert.match(run.stderr, /read 1 staging\/source unit\(s\) and produced NO node changes/,
    'zero yield off real input must be reported on stderr, never a silent success');

  // exit code: the same zero-yield run, invoked the way a user invokes it.
  const invoke = (extra) => execFileP(process.execPath, [
    '--import', resolve(ENGINE_DIR, 'test', 'mem40-judge-register.mjs'),
    resolve(ENGINE_DIR, 'reconcile.mjs'), '--scope', 'consume5', ...extra,
  ], {
    cwd: ENGINE_DIR,
    env: {
      COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin',
      MEM40_JUDGE_RESPONSES: JSON.stringify({ distill: [] }),
    },
    maxBuffer: 16 * 1024 * 1024,
  });

  const scope5 = 'consume5';
  await addScope(scope5);
  await writeStaging(scope5, 'zero-yield-exit');
  const plain = await invoke([]).then(() => 0, (e) => e.code);
  assert.equal(plain, 0, 'a quiet run must stay exit 0 by default (dream.sh / update.sh depend on it)');

  await writeStaging(scope5, 'zero-yield-exit-2');
  const strict = await invoke(['--require-yield']).then(() => 0, (e) => e.code);
  assert.equal(strict, 1, '--require-yield must turn the same zero-yield run into a hard failure');
});
