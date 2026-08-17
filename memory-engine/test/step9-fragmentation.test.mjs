// step9-fragmentation.test.mjs — MEM-38 step 9 test lane (separate from the implementation pass
// per repo doctrine: an implementer writing its own tests tends to write tests that flatter its
// own bugs).
//
// Covers reconcile.mjs writeFragmentationInsight's new shape: pattern/detector/on_accept(kind
// task)/evidence-array, the existence-by-id dedup (kept exactly) PLUS a new open-pattern dedup
// (a same-pattern card still `status: new` from a PRIOR day, whose deterministic id therefore
// differs, must still suppress), and --dry-run writing nothing. Driven through the REAL
// reconcile.mjs main() (step9-reconcile-driver.mjs), with judge.mjs swapped for a CONTENT-routed
// offline mock (step9-judge-mock.mjs) — content-routed, not call-order-indexed, because
// writeFragmentationInsight's own composeFields() judge() call fires as an unawaited background
// promise (`void writeFragmentationInsight(...).catch(...)` in mergeFragmentedCluster) and races
// the main thread's next judge() call (consolidatePrompt); an order-indexed mock would
// nondeterministically hand the wrong canned reply to whichever call landed first.
//
// Runs in its own file (own temp root, own process — test/setup.mjs mints one root per test FILE)
// deliberately separate from step9-drift.test.mjs: sharing a root put that file's seeded nodes into
// THIS file's reconcile.mjs main() run, which reaches them via its own unconditional, unguarded
// `await syncCache(pool, cache)` before the per-scope loop — unlike projection.mjs's embed() call
// sites (all explicitly try/caught, fail-open), reconcile.mjs's own syncCache call has no try/catch,
// so the real (unmocked) embed() rejecting (by design, offline) propagated uncaught and crashed the
// whole driver process. Noted as an implementation smell in the build report, not fixed here (out
// of this lane's remit — implementation files are not touched from the test-authoring lane).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';
import { parseNode } from '../nodes.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const INSIGHTS_DIR = resolve(TEST_MEMORY_ROOT, 'insights');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'driver-home');
const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

async function insightsPoolFiles() {
  await mkdir(INSIGHTS_DIR, { recursive: true });
  return (await readdir(INSIGHTS_DIR)).filter((f) => f.endsWith('.md'));
}
async function cardsByPattern(pattern) {
  const out = [];
  for (const f of await insightsPoolFiles()) {
    const { frontmatter } = parseNode(await readFile(resolve(INSIGHTS_DIR, f), 'utf8'), f.slice(0, -3));
    if (frontmatter.pattern === pattern) out.push({ file: f, fm: frontmatter });
  }
  return out;
}
async function writeParkedCard({ id, pattern, status, scope }) {
  await mkdir(INSIGHTS_DIR, { recursive: true });
  await writeFile(resolve(INSIGHTS_DIR, `${id}.md`),
    `---\nid: ${id}\npattern: ${pattern}\nstatus: ${status}\nscope: ${scope}\n---\n\nparked\n`, 'utf8');
}
async function setScopes(scopes) {
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(scopes), 'utf8');
  for (const s of scopes) await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', s), { recursive: true });
}

async function gitInitOnce() {
  if (gitInitOnce.done) return;
  gitInitOnce.done = true;
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'init', '--quiet']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.email', 'test@test.invalid']);
  await writeFile(resolve(TEST_MEMORY_ROOT, '.gitignore'), 'driver-home/\n', 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '-A']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'seed']);
}

async function writeStagingTurn(scope, anchor) {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging'), { recursive: true });
  const text = `---\ntype: staging\nscope: ${scope}\nbrain: claude\nsession_anchor: ${anchor}\n---\n\n`
    + `#### user · 2026-07-25T10:00:00.000Z · [decision]\n`
    + `A durable fact worth remembering about ${anchor}, spread across a fragmented cluster.\n`;
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'staging', `${anchor}.md`), text, 'utf8');
}

const dupProposals = (n = 2) => Array.from({ length: n }, (_, i) => ({
  title: `Fragment ${i}`, type: 'knowledge', prose: `Fragment prose ${i}, same topic.`,
  cluster: 'dupcluster', centrality: 0.5, tags: [], entities: {}, source_turns: ['#0'],
}));

async function runReconcileDriver(scope, { dryRun = false } = {}) {
  await mkdir(DRIVER_HOME, { recursive: true });
  const args = ['--import', resolve(ENGINE_DIR, 'test', 'step9-judge-register.mjs'),
    resolve(ENGINE_DIR, 'test', 'step9-reconcile-driver.mjs'), '--scope', scope];
  if (dryRun) args.push('--dry-run');
  const responses = { distill: dupProposals(2), merge: dupProposals(2), consolidate: [] };
  const { stdout, stderr } = await execFileP(process.execPath, args, {
    cwd: ENGINE_DIR,
    env: {
      COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin',
      STEP9_JUDGE_RESPONSES: JSON.stringify(responses),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.match(stdout, /___DONE___/, `driver did not complete; stdout: ${stdout}\nstderr: ${stderr}`);
  return { stdout, stderr };
}

// mirrors reconcile.mjs writeFragmentationInsight's own formula (deliberate coupling, same
// precedent as step7-producers.test.mjs's gateSigFor: if production's formula changes, this test
// fails loudly instead of silently testing nothing).
function expectedPattern(scope, title, cluster, group) {
  const contentKey = sha8(group.map((n) => `${n.title}|${n.prose}`).join('\n'));
  return `fragmentation::${sha8(scope + (title || '') + cluster)}::${contentKey}`;
}

test('fragmentation: a non-reducing merge retry mints an insight with the exact step 9 field shape', async () => {
  const scope = 's9f1';
  await gitInitOnce();
  await setScopes([scope]);
  await writeStagingTurn(scope, 'sess-s9f1');
  await runReconcileDriver(scope);

  const pattern = expectedPattern(scope, null, 'dupcluster', dupProposals(2));
  const cards = await cardsByPattern(pattern);
  assert.equal(cards.length, 1, 'exactly one fragmentation card should be minted');
  const fm = cards[0].fm;
  assert.match(fm.id, /^\d{4}-\d{2}-\d{2}-distill-fragmentation-[0-9a-f]{8}-[0-9a-f]{6}$/);
  assert.equal(fm.detector, 'distill-fragmentation');
  assert.equal(fm.source, 'conversation-distill');
  assert.equal(fm.status, 'new');
  assert.equal(fm.scope, scope);
  assert.equal(fm.on_accept.kind, 'task');
  assert.equal(fm.on_accept.project, '');
  assert.ok(!fm.on_accept.line.includes('\n'), 'on_accept.line must be single-line (taskLine)');
  assert.ok(Array.isArray(fm.evidence), 'evidence must be an array of titles, not a joined string');
  assert.deepEqual(fm.evidence, ['Fragment 0', 'Fragment 1']);
});

test('fragmentation: existence-by-id dedup is unchanged (same deterministic id already on disk -> no rewrite)', async () => {
  const scope = 's9f2';
  await gitInitOnce();
  await setScopes([scope]);
  await writeStagingTurn(scope, 'sess-s9f2-a');
  await runReconcileDriver(scope);
  const pattern = expectedPattern(scope, null, 'dupcluster', dupProposals(2));
  const before = await cardsByPattern(pattern);
  assert.equal(before.length, 1);
  const contentBefore = await readFile(resolve(INSIGHTS_DIR, before[0].file), 'utf8');

  // a second work-unit in the SAME scope that distills to the byte-identical group (same title|prose)
  // reproduces the exact same pattern AND id (same day) -> the pre-existing access() check must skip it.
  await writeStagingTurn(scope, 'sess-s9f2-b');
  await runReconcileDriver(scope);
  const after = await cardsByPattern(pattern);
  assert.equal(after.length, 1, 'a byte-identical recurrence on the same day must not add a second file');
  const contentAfter = await readFile(resolve(INSIGHTS_DIR, after[0].file), 'utf8');
  assert.equal(contentAfter, contentBefore, 'the existing card must not be rewritten');
});

test('fragmentation: an open card sharing the same pattern (different id/date) suppresses the mint', async () => {
  const scope = 's9f3';
  await gitInitOnce();
  await setScopes([scope]);
  const pattern = expectedPattern(scope, null, 'dupcluster', dupProposals(2));
  // simulate a card minted on a PRIOR day: same pattern, but a different (yesterday-dated) id, so
  // the id/path-keyed existence dedup would NOT catch it — only the new open-pattern check does.
  await writeParkedCard({ id: '2026-01-01-distill-fragmentation-parked-3f', pattern, status: 'new', scope });
  await writeStagingTurn(scope, 'sess-s9f3');
  await runReconcileDriver(scope);
  const cards = await cardsByPattern(pattern);
  assert.equal(cards.length, 1, 'only the parked card should exist; no new mint on top of an open same-pattern card');
  assert.equal(cards[0].fm.id, '2026-01-01-distill-fragmentation-parked-3f');
});

test('fragmentation: a RESOLVED card sharing the same pattern does not suppress the mint', async () => {
  const scope = 's9f3b';
  await gitInitOnce();
  await setScopes([scope]);
  const pattern = expectedPattern(scope, null, 'dupcluster', dupProposals(2));
  await writeParkedCard({ id: '2026-01-01-distill-fragmentation-parked-3g', pattern, status: 'accepted', scope });
  await writeStagingTurn(scope, 'sess-s9f3b');
  await runReconcileDriver(scope);
  const cards = await cardsByPattern(pattern);
  assert.equal(cards.length, 2, 'a resolved same-pattern card must not block a fresh mint');
  assert.ok(cards.some((c) => c.fm.status === 'new' && c.fm.id !== '2026-01-01-distill-fragmentation-parked-3g'));
});

test('fragmentation: --dry-run mints nothing (writeInsightFile never called for real)', async () => {
  const scope = 's9f4';
  await gitInitOnce();
  await setScopes([scope]);
  const pattern = expectedPattern(scope, null, 'dupcluster', dupProposals(2));
  await writeStagingTurn(scope, 'sess-s9f4');
  await runReconcileDriver(scope, { dryRun: true });
  const cards = await cardsByPattern(pattern);
  assert.equal(cards.length, 0, '--dry-run must never write a real insight file');
});
