// step9-drift.test.mjs — MEM-38 step 9 test lane (separate from the implementation pass per repo
// doctrine: an implementer writing its own tests tends to write tests that flatter its own bugs).
//
// Covers projection.mjs checkDurableDrift's new open-finding skip: a check BEFORE the judge() call
// that returns null when an insight card is already open on the exact rule (pattern === rule.source)
// AND the exact family (source/detector === 'durable-rule-drift'). Driven through the REAL project()
// (step5-driver.mjs, exactly as ratification.test.mjs already does).
//
// judge() is left UNMOCKED here deliberately: the drift path's mint-side judge() call fails offline
// (spawn ENOENT, trimmed PATH) and production code's own documented fallback kicks in
// (`catch { verdict = { stale: true, ... } }`), so the "no open card -> mints" control case is
// already offline-deterministic without any mock — only the skip itself needs a scenario at all,
// since it returns before judge() is ever called.
//
// Runs in its own file (own temp root, own process — test/setup.mjs mints one root per test FILE)
// deliberately separate from step9-fragmentation.test.mjs: sharing a root would mean this file's
// seeded nodes ride into that file's reconcile.mjs main() run and get swept into its unconditional,
// unguarded syncCache() call, whose real (unmocked) embed() then rejects uncaught — see the build
// note for the full trace; splitting the files is the fix, not weakening either mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT, writePool, makeNode } from './fixtures.mjs';
import { parseNode } from '../nodes.mjs';
import { contentHash } from '../retrieval.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const INSIGHTS_DIR = resolve(TEST_MEMORY_ROOT, 'insights');
const STATE_FILE = resolve(TEST_MEMORY_ROOT, '.reconciler', 'projection-state.json');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'driver-home');

async function insightsPoolFiles() {
  await mkdir(INSIGHTS_DIR, { recursive: true });
  return (await readdir(INSIGHTS_DIR)).filter((f) => f.endsWith('.md'));
}
async function writeParkedCard({ id, pattern, status, source, detector, scope }) {
  await mkdir(INSIGHTS_DIR, { recursive: true });
  const lines = [`id: ${id}`, `pattern: ${pattern}`, `status: ${status}`, `scope: ${scope}`];
  if (source) lines.push(`source: ${source}`);
  if (detector) lines.push(`detector: ${detector}`);
  await writeFile(resolve(INSIGHTS_DIR, `${id}.md`), `---\n${lines.join('\n')}\n---\n\nparked\n`, 'utf8');
}

async function setScopes(scopes) {
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(scopes), 'utf8');
  for (const s of scopes) await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', s), { recursive: true });
}
async function writeProjState(state) {
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
async function runProjDriver() {
  await mkdir(DRIVER_HOME, { recursive: true });
  await execFileP(process.execPath, [
    resolve(ENGINE_DIR, 'test', 'step5-driver.mjs'), JSON.stringify({ dryRun: false }),
  ], {
    cwd: ENGINE_DIR,
    env: { COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin' },
    maxBuffer: 16 * 1024 * 1024,
  });
}
async function seedDurableRule(scope, nodeId, { cachedProse }) {
  await setScopes([scope]);
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md'), `# ${scope} skeleton\n`, 'utf8');
  await writePool([makeNode({ id: nodeId, type: 'identity', scope, centrality: 0.7, body: 'Current live prose, changed since graduation.' })]);
  await writeProjState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: { [nodeId]: { rule: 'Cached one-liner rule text.', source: nodeId, sourceHash: contentHash(cachedProse) } },
  } });
}
async function driftCardsFor(nodeId) {
  return (await insightsPoolFiles()).filter((f) => f.includes(`durable-rule-drift-${nodeId}`));
}

test('drift: an open same-family card on the exact rule suppresses the mint (skip fires before judge())', async () => {
  const scope = 's9d1';
  const nodeId = 's9d1-r';
  await seedDurableRule(scope, nodeId, { cachedProse: 'Old cached prose, not the current body.' });
  await writeParkedCard({ id: 'parked-1', pattern: nodeId, status: 'new', source: 'projection:durable-rule-drift', scope });
  await runProjDriver();
  const files = await driftCardsFor(nodeId);
  assert.equal(files.length, 0, 'no NEW durable-rule-drift card should be minted while one is already open on this rule');
});

test('drift: a same-pattern card from a FOREIGN family does not suppress the mint', async () => {
  const scope = 's9d2';
  const nodeId = 's9d2-r';
  await seedDurableRule(scope, nodeId, { cachedProse: 'Old cached prose, not the current body.' });
  // same pattern (the node id), but a different family entirely (ratified-rule-retirement/proposed-rule
  // shape) — must NOT be read as an open durable-rule-drift finding.
  await writeParkedCard({ id: 'parked-2', pattern: nodeId, status: 'new', source: 'projection:proposed-rule', detector: 'proposed-rule', scope });
  await runProjDriver();
  const files = await driftCardsFor(nodeId);
  assert.equal(files.length, 1, 'a foreign-family card on the same pattern must not block the drift mint');
});

test('drift: a matching card that is no longer status:new does not suppress the mint', async () => {
  const scope = 's9d3';
  const nodeId = 's9d3-r';
  await seedDurableRule(scope, nodeId, { cachedProse: 'Old cached prose, not the current body.' });
  await writeParkedCard({ id: 'parked-3', pattern: nodeId, status: 'accepted', source: 'projection:durable-rule-drift', detector: 'durable-rule-drift', scope });
  await runProjDriver();
  const files = await driftCardsFor(nodeId);
  assert.equal(files.length, 1, 'a resolved (non-new) same-family card must not block the drift mint');
});

test('drift: with no open card at all, the control case mints (judge failing offline -> stale:true fallback)', async () => {
  const scope = 's9d4';
  const nodeId = 's9d4-r';
  await seedDurableRule(scope, nodeId, { cachedProse: 'Old cached prose, not the current body.' });
  await runProjDriver();
  const files = await driftCardsFor(nodeId);
  assert.equal(files.length, 1, 'no open card at all -> the drift check runs and mints on the offline judge-failure fallback');
  const { frontmatter } = parseNode(await readFile(resolve(INSIGHTS_DIR, files[0]), 'utf8'), files[0].slice(0, -3));
  assert.equal(frontmatter.pattern, nodeId);
  assert.equal(frontmatter.detector, 'durable-rule-drift');
});
