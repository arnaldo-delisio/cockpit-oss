// truth-clear.test.mjs — human adjudication of truth-pass quarantines (truth-pass.mjs --review /
// --clear) plus the re-quarantine guard in applyVerdict. The CLI verbs run as real child
// processes against the temp pool (COCKPIT_MEMORY_ROOT inherited from the setup preload); the
// guard runs through the REAL truthPass() in a child driver (truth-clear-driver.mjs) with
// deps.judge fed from TRUTH_CLEAR_VERDICTS and the staleness lane's judge.mjs swapped for the
// step7 deterministic mock (loader hook), so the whole file is offline by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT, writePool, makeNode } from './fixtures.mjs';
import { parseNode, NODES_DIR } from '../nodes.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const TRUTH_PASS = resolve(ENGINE_DIR, 'truth-pass.mjs');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'driver-home');

const readFm = async (id) => parseNode(await readFile(resolve(NODES_DIR, `${id}.md`), 'utf8'), id).frontmatter;

// the ledger the driver's roots point at (cockpit scope reads <cockpitRoot>/DECISIONS.md).
const LEDGER = `# Decisions

### MEM-1 · widget retirement
The frobnicator widget pipeline was retired and removed from the cockpit toolchain entirely.
Remaining widget pipeline references in the cockpit memory graph are historical records only.

### MEM-2 · gadget adoption
The gadget capture lane replaces the frobnicator widget lane for cockpit captures permanently.
`;

const EVIDENCE = {
  entry: 'MEM-1',
  quote: 'The frobnicator widget pipeline was retired and removed from the cockpit toolchain entirely.',
  summary: 'node claims the widget pipeline is current; MEM-1 retired it',
  t1_missing: [],
};

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TRUTH_PASS, ...args], { cwd: ENGINE_DIR });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function runGuardDriver(verdicts) {
  await mkdir(DRIVER_HOME, { recursive: true });
  const { stdout, stderr } = await execFileP(process.execPath, [
    '--import', resolve(ENGINE_DIR, 'test', 'step7-judge-register.mjs'),
    resolve(ENGINE_DIR, 'test', 'truth-clear-driver.mjs'),
  ], {
    cwd: ENGINE_DIR,
    env: {
      COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin',
      TRUTH_CLEAR_VERDICTS: JSON.stringify(verdicts),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('___REPORT___'));
  assert.ok(line, `driver printed no report; stdout: ${stdout}\nstderr: ${stderr}`);
  return { report: JSON.parse(line.slice('___REPORT___'.length)), stdout };
}

// one quarantined node (q1) and one plain node share the pool across the ordered scenarios below.
test('seed: quarantined pool + ledger', async () => {
  await writeFile(resolve(TEST_MEMORY_ROOT, 'DECISIONS.md'), LEDGER, 'utf8');
  await writePool([
    makeNode({
      id: 'q1',
      body: 'The frobnicator widget pipeline is the current cockpit toolchain for captures.',
      ledger_conflict: 'confirmed',
      ledger_conflict_first: '2026-08-01T00:00:00.000Z',
      ledger_conflict_disagreements: 2,
      ledger_conflict_evidence: EVIDENCE,
    }),
    makeNode({ id: 'plain-node', body: 'An unrelated note about gardening tools and soil.' }),
  ]);
});

test('--review lists the quarantined node with its evidence and count', async () => {
  const { code, stdout } = await runCli(['--review']);
  assert.equal(code, 0);
  assert.match(stdout, /1 quarantined node\(s\)/);
  assert.match(stdout, /\[\[q1\]\]/);
  assert.match(stdout, /disagreements: 2/);
  assert.match(stdout, /entry: MEM-1/);
  assert.match(stdout, /promoted: no/);
});

test('--clear refuses without --reason', async () => {
  const { code, stderr } = await runCli(['--clear', 'q1']);
  assert.equal(code, 1);
  assert.match(stderr, /--reason/);
  assert.equal((await readFm('q1')).ledger_conflict, 'confirmed');   // untouched
});

test('--clear --dry-run previews without writing', async () => {
  const { code, stdout } = await runCli(['--clear', 'q1', '--reason', 'false positive', '--dry-run']);
  assert.equal(code, 0);
  assert.match(stdout, /would dismiss \[\[q1\]\]/);
  assert.equal((await readFm('q1')).ledger_conflict, 'confirmed');   // untouched
});

test('--clear flips confirmed to dismissed and keeps the evidence trail', async () => {
  const { code, stdout } = await runCli(['--clear', 'q1', '--reason', 'the node records history, not a current claim']);
  assert.equal(code, 0, stdout);
  const fm = await readFm('q1');
  assert.equal(fm.ledger_conflict, 'dismissed');
  assert.equal(fm.ledger_conflict_dismissed_reason, 'the node records history, not a current claim');
  assert.ok(fm.ledger_conflict_dismissed);
  // trail retained
  assert.equal(fm.ledger_conflict_first, '2026-08-01T00:00:00.000Z');
  assert.equal(fm.ledger_conflict_disagreements, 2);
  assert.equal(fm.ledger_conflict_evidence.entry, 'MEM-1');
  assert.ok(fm.updated);
});

test('--clear is idempotent: a second clear reports and changes nothing', async () => {
  const { code, stdout } = await runCli(['--clear', 'q1', '--reason', 'a different reason that must not land']);
  assert.equal(code, 0);
  assert.match(stdout, /already dismissed/);
  assert.equal((await readFm('q1')).ledger_conflict_dismissed_reason, 'the node records history, not a current claim');
});

test('re-quarantine guard: a dismissed node is skipped for the same entry', async () => {
  const { report, stdout } = await runGuardDriver({
    q1: { id: 'q1', conflict: true, entry_id: 'MEM-1', quote: EVIDENCE.quote, summary: 'same conflict again' },
  });
  assert.equal(report.dismissedSkips, 1);
  assert.deepEqual(report.quarantined, []);
  assert.match(stdout, /\[\[q1\]\] conflict with MEM-1 was human-dismissed, not re-quarantining/);
  assert.equal((await readFm('q1')).ledger_conflict, 'dismissed');   // disk untouched
});

test('re-quarantine guard: the SAME entry with a DIFFERENT quote still quarantines normally', async () => {
  const { report } = await runGuardDriver({
    q1: {
      id: 'q1', conflict: true, entry_id: 'MEM-1',
      quote: 'Remaining widget pipeline references in the cockpit memory graph are historical records only.',
      summary: 'same entry, new evidence span',
    },
  });
  assert.equal(report.dismissedSkips, 0);
  assert.deepEqual(report.quarantined, [{ id: 'q1', entry: 'MEM-1' }]);
});

test('--clear refuses a traversal or absolute node id before touching any path', async () => {
  for (const bad of ['../../target', '/tmp/evil', 'UPPER..case']) {
    const { code, stderr } = await runCli(['--clear', bad, '--reason', 'nope']);
    assert.equal(code, 1, `expected refusal for ${bad}`);
    assert.match(stderr, /invalid node id/);
  }
  // nothing escaped NODES_DIR: the traversal target was never created.
  await assert.rejects(readFile(resolve(NODES_DIR, '..', '..', 'target.md')));
});

test('re-quarantine guard: a DIFFERENT entry still quarantines normally', async () => {
  const { report } = await runGuardDriver({
    q1: {
      id: 'q1', conflict: true, entry_id: 'MEM-2',
      quote: 'The gadget capture lane replaces the frobnicator widget lane for cockpit captures permanently.',
      summary: 'new evidence from a different entry',
    },
  });
  assert.equal(report.dismissedSkips, 0);
  assert.deepEqual(report.quarantined, [{ id: 'q1', entry: 'MEM-2' }]);
});

test('lock: an empty/garbled lock file reads as BUSY, never stolen', async () => {
  const lockFile = resolve(TEST_MEMORY_ROOT, '.reconciler', 'lock');
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  await writeFile(lockFile, '', 'utf8');   // the r2 attack shape: a lock with no payload
  try {
    const { code, stderr } = await runCli(['--clear', 'q1', '--reason', 'must not steal the lock']);
    assert.equal(code, 1);
    assert.match(stderr, /lock is held/);
    assert.equal(await readFile(lockFile, 'utf8'), '');   // still there, untouched
  } finally {
    await rm(lockFile, { force: true });
  }
});

test('lock: mid-hold the lock file always carries a parseable pid+token payload', async () => {
  const lockFile = resolve(TEST_MEMORY_ROOT, '.reconciler', 'lock');
  // acquire in a child through the real exported helper, hold until stdin closes.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { acquireReconcilerLock } = await import(${JSON.stringify('file://' + resolve(ENGINE_DIR, 'truth-pass.mjs'))});
    const { release } = await acquireReconcilerLock('truth-clear.test lock probe');
    console.log('HELD');
    await new Promise((r) => process.stdin.on('close', r).resume());
    await release();
  `], { cwd: ENGINE_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; if (out.includes('HELD')) res(); });
      child.on('exit', () => rej(new Error('child exited before holding the lock')));
    });
    const held = JSON.parse(await readFile(lockFile, 'utf8'));   // mid-hold read must parse
    assert.equal(held.pid, child.pid);
    assert.match(String(held.token), new RegExp(`^${child.pid}:[0-9a-f-]{36}$`));
    assert.ok(held.at && held.via);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
  }
  await assert.rejects(readFile(lockFile));   // release removed its own lock
});

test('--clear on a non-quarantined node refuses', async () => {
  const { code, stderr } = await runCli(['--clear', 'plain-node', '--reason', 'nothing to clear']);
  assert.equal(code, 1);
  assert.match(stderr, /not quarantined/);
});
