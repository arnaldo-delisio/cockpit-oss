// near-duplicate-wiring.test.mjs — the near-duplicate flag is actually WIRED into reconcile.mjs
// main(), and its offline failure is reported honestly.
//
// Written because near-duplicate-flag.test.mjs calls findNearDuplicates directly (Codex review
// 2026-08-15): every assertion there would still pass if main() never called the check at all. This
// file drives the REAL main() through the existing step9 driver + offline judge mock, mints one node,
// and reads what the run itself reported.
//
// What it can and cannot see: embed() is deliberately unreachable in this suite (test/setup.mjs
// forbids remote AND local models), and a freshly minted node is by definition not in the embedding
// cache, so the check's syncCache always rejects here. That makes this an assertion about the
// FAIL-SOFT half specifically — the mint lands, the check reports itself as not-run, nothing is
// escalated. The scoring half is covered in near-duplicate-flag.test.mjs. A regression that unwired
// the call from main() shows up here as a missing stderr line.
//
// PRE-EXISTING DEFECT this test has to route around, stated rather than papered over: an offline run
// that MINTS anything dies late with an UNCAUGHT embed() rejection raised outside any handler
// (transformers' getModelFile, reached through a later unawaited call in the same run — the same
// smell step9-fragmentation.test.mjs's header already recorded). Measured on this exact scenario with
// the near-duplicate change stashed: identical crash, identical stack, so it is neither caused by nor
// fixable inside this unit. Consequence: the process exits non-zero before the audit FILE is written,
// so the assertions read the run's stdout/stderr instead, and the exit code is deliberately not
// asserted. Fixing that rejection is its own unit; when it lands, tighten this test to the audit file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const PENDING_DIR = resolve(TEST_MEMORY_ROOT, '.reconciler', 'pending-review');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'driver-home');
const SCOPE = 'ndw';

async function seed() {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', SCOPE, 'staging'), { recursive: true });
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify([SCOPE]), 'utf8');
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', SCOPE, 'staging', 'sess-ndw.md'),
    `---\ntype: staging\nscope: ${SCOPE}\nbrain: claude\nsession_anchor: sess-ndw\n---\n\n`
    + `#### user · 2026-08-15T10:00:00.000Z · [decision]\n`
    + `A durable fact worth remembering, stated once.\n`, 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'init', '--quiet']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.email', 'test@test.invalid']);
  await writeFile(resolve(TEST_MEMORY_ROOT, '.gitignore'), 'driver-home/\n', 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '-A']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'seed']);
}

const proposal = {
  title: 'A durable fact', type: 'knowledge', prose: 'A durable fact worth remembering, stated once.',
  cluster: 'ndw-cluster', centrality: 0.5, tags: [], entities: {}, source_turns: ['#0'],
};

async function runReconcile() {
  await mkdir(DRIVER_HOME, { recursive: true });
  const responses = {
    distill: [proposal],
    merge: [proposal],
    consolidate: [{ action: 'new', backing: [0], centrality: 0.5, cluster: 'ndw-cluster' }],
  };
  // the run's own output is the evidence; its exit code belongs to the pre-existing crash above.
  try {
    return await execFileP(process.execPath, [
      '--import', resolve(ENGINE_DIR, 'test', 'step9-judge-register.mjs'),
      resolve(ENGINE_DIR, 'test', 'step9-reconcile-driver.mjs'), '--scope', SCOPE,
    ], {
      cwd: ENGINE_DIR,
      env: {
        COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin',
        STEP9_JUDGE_RESPONSES: JSON.stringify(responses),
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    // Only the known, measured crash is tolerated, matched on its full signature — the message AND the
    // transformers frame it is raised from AND the non-zero exit that goes with it. A broad substring
    // match would swallow an unrelated later failure that merely happened alongside it.
    const text = `${e.stdout || ''}\n${e.stderr || ''}`;
    const known = /both local and remote models are disabled/.test(text)
      && /at getModelFile \(.*transformers/.test(text)
      && e.code === 1;
    if (!known) throw e;
    return { stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('main() runs the near-duplicate check over its mints and reports the offline failure as unchecked', async () => {
  await seed();
  const { stdout, stderr } = await runReconcile();

  // the mint happened: without it there is nothing for the check to look at and the assertion below
  // would pass vacuously.
  assert.match(stdout, /^added: 1 /m, `expected exactly one mint; stdout:\n${stdout}`);

  // the check ran over that mint and could not score it — reported, not swallowed into a clean pass.
  assert.match(stderr, /reconcile: near-duplicate check did not run \(.+\); mints unchecked\./,
    `near-duplicate check appears unwired from main(); stderr:\n${stderr}`);

  // fail-soft, not fail-open: nothing was escalated by a check that never scored anything.
  const pending = (await readdir(PENDING_DIR).catch(() => [])).filter((f) => f.startsWith('duplicate-'));
  assert.deepEqual(pending, []);
});
