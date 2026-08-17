// step7-producers.test.mjs — MEM-38 step 7: producers DECLARE on_accept. Covers the two
// producer families whose mint paths are drivable offline through real entry points:
//
//   • truth-pass memory-staleness (runStalenessMinting via the exported truthPass, judge.mjs
//     swapped for a deterministic mock by loader hook — test/step7-judge-{mock,loader,register}):
//     archive → retire op, fold → merge op with the judge-picked on-list target, off-list
//     fold_into → refresh downgrade, refresh → task; precondition hash/status parity with
//     accept.mjs proven END TO END by running the real accept.mjs CLI on the minted cards.
//   • projection (real project() via the existing step5-driver + one-hot embed mock):
//     ratified-rule-retirement → unratify + project:true + expected_status 'ratified';
//     proposed-rule → ratify + claim-tier expected_status; both with file-bytes hash parity.
//
// semantic-insights.mjs (taskLine/docDebtOnAccept/familyOnAccept) and mechanical-insights.mjs
// (taskLine + per-family task declarations) are NOT covered here: their helpers are
// module-private and every mint path runs behind scan entry points that need seeded judge
// verdicts from judge-claude/judge-hermes adapters — reported as untestable without an export
// (or a second loader mock per adapter) in the pass report, per the task's no-new-exports rule.
//
// Scenario order matters: staleness mints (runs 1 and 2), projection mints, then ONE git-init of
// the shared temp root and the accept.mjs parity accepts, which supersede nodes and must come
// last.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT, writePool, makeNode } from './fixtures.mjs';
import { parseNode, NODES_DIR } from '../nodes.mjs';
import { contentHash, CACHE_FILE } from '../retrieval.mjs';
import { coverageText } from '../projection.mjs';
import { REPO_ROOT } from '../paths.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const INSIGHTS_DIR = resolve(TEST_MEMORY_ROOT, 'insights');
const STATE_FILE = resolve(TEST_MEMORY_ROOT, '.reconciler', 'projection-state.json');
const GLOBAL_SKELETON = resolve(REPO_ROOT, 'shells', 'CLAUDE.md');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'driver-home');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const today = () => new Date().toISOString().slice(0, 10);
const nodeFile = (id) => resolve(NODES_DIR, `${id}.md`);

// ---------- staleness driver (truthPass in a child, judge.mjs mocked by loader hook) ----------

async function runTruthDriver(verdicts) {
  await mkdir(DRIVER_HOME, { recursive: true });
  const { stdout, stderr } = await execFileP(process.execPath, [
    '--import', resolve(ENGINE_DIR, 'test', 'step7-judge-register.mjs'),
    resolve(ENGINE_DIR, 'test', 'step7-truth-driver.mjs'),
  ], {
    cwd: ENGINE_DIR,
    env: {
      COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin',
      STEP7_STALENESS_VERDICTS: JSON.stringify(verdicts),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('___REPORT___'));
  assert.ok(line, `driver printed no report; stdout: ${stdout}\nstderr: ${stderr}`);
  return JSON.parse(line.slice('___REPORT___'.length));
}

async function cardByPattern(pattern) {
  const files = (await readdir(INSIGHTS_DIR).catch(() => [])).filter((f) => f.endsWith('.md'));
  const hits = [];
  for (const f of files) {
    const { frontmatter } = parseNode(await readFile(resolve(INSIGHTS_DIR, f), 'utf8'), f.slice(0, -3));
    if (frontmatter.pattern === pattern) hits.push(frontmatter);
  }
  assert.equal(hits.length, 1, `expected exactly one card with pattern ${pattern}, found ${hits.length}`);
  return hits[0];
}

// the cache the fold-candidate lookup reads (cache-only by contract): {id: {hash, vec}}
async function writeEmbCache(entries) {
  await mkdir(resolve(TEST_MEMORY_ROOT, '.cache'), { recursive: true });
  const obj = {};
  for (const [id, prose, vec] of entries) obj[id] = { hash: contentHash(prose), vec };
  await writeFile(CACHE_FILE, JSON.stringify(obj), 'utf8');
}
const prose = (id) => `Fixture prose for ${id}.`;

// ================================================================ staleness run 1: archive + fold

test('truth-pass staleness: archive → retire op, fold → merge op with on-list target, accept-parity hashes', async () => {
  await writePool([
    makeNode({ id: 'stale-a', type: 'knowledge', scope: 'cockpit' }),
    makeNode({ id: 'stale-b', type: 'knowledge', scope: 'cockpit' }),
    makeNode({ id: 'stale-t', type: 'knowledge', scope: 'cockpit' }),
  ]);
  // one-hot-ish unit vectors: stale-t is stale-b's nearest live node, stale-a is distant
  await writeEmbCache([
    ['stale-a', prose('stale-a'), [0, 1, 0]],
    ['stale-b', prose('stale-b'), [1, 0, 0]],
    ['stale-t', prose('stale-t'), [1, 0, 0]],
  ]);
  const report = await runTruthDriver({
    'stale-a': { stale: true, action: 'archive', severity: 6, certainty: 0.9, rationale: 'narrow and cold' },
    'stale-b': { stale: true, action: 'fold', fold_into: 'stale-t', severity: 5, certainty: 0.8, rationale: 'covered by the target' },
    'stale-t': { stale: false },
  });
  assert.equal(report.staleness.minted, 2, 'archive + fold mint, the stale:false candidate does not');

  const archive = await cardByPattern('memory-staleness::stale-a');
  assert.deepEqual(archive.on_accept, { kind: 'retire', node: 'stale-a' });
  assert.equal(archive.expected_node_hash, sha256(await readFile(nodeFile('stale-a'))),
    'mint hash = sha256 of the node FILE bytes, accept.mjs parity');
  assert.equal(archive.expected_status, 'principle', 'mint status = accept.mjs liveNodeStatus (claim tier)');
  assert.equal(archive.expected_target_hash, undefined, 'retire carries no target hash');

  const fold = await cardByPattern('memory-staleness::stale-b');
  assert.deepEqual(fold.on_accept, { kind: 'merge', node: 'stale-b', into: 'stale-t' },
    'the merge target is picked at mint time from the offered list');
  assert.equal(fold.expected_node_hash, sha256(await readFile(nodeFile('stale-b'))));
  assert.equal(fold.expected_target_hash, sha256(await readFile(nodeFile('stale-t'))));
  assert.match(fold.claim, /fold \[\[stale-b\]\] into \[\[stale-t\]\]/, 'the card claim names BOTH nodes');
  assert.match(fold.suggested_fix, /Fold \[\[stale-b\]\] into \[\[stale-t\]\]/);
});

// ================================================================ staleness run 2: downgrades + refresh + unknown tier

test('truth-pass staleness: off-list fold_into downgrades to a refresh task; refresh mints a task; claim-less node mints expected_status unknown', async () => {
  await writePool([
    makeNode({ id: 'stale-c', type: 'knowledge', scope: 'cockpit' }),
    makeNode({ id: 'stale-d', type: 'knowledge', scope: 'cockpit' }),
  ]);
  // a node with NO claim key at all: liveNodeStatus (and the mint) must both read 'unknown'
  await writeFile(nodeFile('stale-s'), '---\nid: stale-s\ntitle: stale-s\ntype: knowledge\nscope: cockpit\n---\n\nProse for stale-s.\n', 'utf8');
  // stale-t was judged (stale:false) in run 1 without minting, so it would consume budget again:
  // park an open card on its pattern so openPrior skips it (the production dedupe rule).
  await mkdir(INSIGHTS_DIR, { recursive: true });   // run 2 must also stand alone (name-filtered runs)
  await writeFile(resolve(INSIGHTS_DIR, 'parked-stale-t.md'),
    '---\nid: parked-stale-t\npattern: memory-staleness::stale-t\nstatus: new\nscope: cockpit\n---\n\nparked\n', 'utf8');
  // stale-c HAS fold candidates on offer (stale-t's vector still cached), so the downgrade below
  // exercises the off-list REJECTION, not the empty-candidates fallback.
  await writeEmbCache([
    ['stale-c', prose('stale-c'), [1, 0, 0]],
    ['stale-t', prose('stale-t'), [1, 0, 0]],
  ]);
  const report = await runTruthDriver({
    // the off-list target is a REAL live node (just unoffered: no cached vector), so only the
    // list-membership check can reject it — the unreadable-node fallback never fires
    'stale-c': { stale: true, action: 'fold', fold_into: 'stale-d', severity: 5, certainty: 0.8, rationale: 'judge went off-list' },
    'stale-d': { stale: true, action: 'refresh', severity: 4, certainty: 0.7, rationale: 'still relevant, just old' },
    'stale-s': { stale: true, action: 'archive', severity: 6, certainty: 0.9, rationale: 'no claim tier' },
  });
  assert.equal(report.staleness.minted, 3, `run 2 mints all three (report: ${JSON.stringify(report.staleness)})`);

  const downgraded = await cardByPattern('memory-staleness::stale-c');
  assert.deepEqual(downgraded.on_accept,
    { kind: 'task', project: '', line: 'Refresh stale memory node [[stale-c]] (truth-pass staleness review)' },
    'an off-list fold target downgrades to the refresh task, never a merge against an unoffered node');
  assert.equal(downgraded.expected_node_hash, undefined, 'a task card carries no preconditions (accept.mjs refuses them)');
  assert.equal(downgraded.expected_status, undefined);
  assert.equal(downgraded.expected_target_hash, undefined);

  const refresh = await cardByPattern('memory-staleness::stale-d');
  assert.deepEqual(refresh.on_accept,
    { kind: 'task', project: '', line: 'Refresh stale memory node [[stale-d]] (truth-pass staleness review)' });
  assert.ok(!refresh.on_accept.line.includes('\n'), 'the task line is single-line by construction');

  const unknown = await cardByPattern('memory-staleness::stale-s');
  assert.deepEqual(unknown.on_accept, { kind: 'retire', node: 'stale-s' });
  assert.equal(unknown.expected_status, 'unknown', "no claim key → 'unknown', the same ?? fallback accept.mjs computes");
  assert.equal(unknown.expected_node_hash, sha256(await readFile(nodeFile('stale-s'))));
});

// ================================================================ projection producers (real project() via step5-driver)

async function setScopes(scopes) {
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(scopes), 'utf8');
  for (const s of scopes) await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', s), { recursive: true });
}
async function writeState(state) {
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
// replica of projection.mjs's gate signature (ratification.test.mjs's deliberate coupling: if the
// production formula changes, the proposed-rule scenario fails loudly instead of testing nothing)
async function gateSigFor(scope, { gateCandidates = [], graduatedRules = [], emerging = [] } = {}) {
  const FENCE_RE = /[ \t]*<!-- managed:reconciler:begin\b[^>]*-->[\s\S]*?<!-- managed:reconciler:end -->\n?/;
  const file = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');
  const shell = await readFile(GLOBAL_SKELETON, 'utf8').catch(() => '');
  const ancestor = await coverageText(shell, GLOBAL_SKELETON);
  const existing = await readFile(file, 'utf8').catch(() => '');
  const ownSkeleton = await coverageText(existing.replace(FENCE_RE, '').trim(), file);
  const durableText = graduatedRules.map((r) => `- ${r.rule}`).join('\n');
  const skeleton = [...(ancestor.trim() ? [ancestor] : []), ownSkeleton, durableText]
    .filter(Boolean).join('\n\n');
  return sha8(JSON.stringify([
    gateCandidates.map((n) => [n.id, contentHash(n.prose ?? n.body), n.frontmatter.centrality]),
    sha8(skeleton),
    emerging.map((r) => [r.rule, r.source]),
  ]));
}
async function runProjDriver({ mock = false } = {}) {
  await mkdir(DRIVER_HOME, { recursive: true });
  const args = [];
  if (mock) args.push('--import', resolve(ENGINE_DIR, 'test', 'step5-embed-register.mjs'));
  args.push(resolve(ENGINE_DIR, 'test', 'step5-driver.mjs'), JSON.stringify({ dryRun: false }));
  await execFileP(process.execPath, args, {
    cwd: ENGINE_DIR,
    env: { COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin' },
    maxBuffer: 16 * 1024 * 1024,
  });
}
async function insightByPrefix(prefix) {
  const files = (await readdir(INSIGHTS_DIR)).filter((f) => f.startsWith(prefix)).sort();
  assert.equal(files.length, 1, `expected exactly one ${prefix}* card, found: ${files.join(', ')}`);
  return parseNode(await readFile(resolve(INSIGHTS_DIR, files[0]), 'utf8'), files[0].slice(0, -3)).frontmatter;
}

const RAT = { at: '2026-07-25T00:00:00.000Z', via: 'in-session', turn: 'sess-1:4' };

test('projection: ratified-rule-retirement card declares unratify + project:true + ratified-status preconditions', async () => {
  const scope = 's7r';
  const COVER = 'always restate the covered doctrine sentence exactly here';
  await setScopes([scope]);
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md'), `# ${scope} skeleton\n\n${COVER}\n`, 'utf8');
  await writePool([makeNode({ id: 's7r-r', type: 'identity', scope, centrality: 0.2, ratified: RAT })]);
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: { 's7r-r': { rule: COVER, source: 's7r-r', sourceHash: contentHash(prose('s7r-r')) } },
  } });
  await runProjDriver({ mock: true });   // one-hot embed: identical texts cos 1.0 → over the suppression threshold
  const card = await insightByPrefix(`${today()}-ratified-rule-retirement-s7r-r`);
  assert.deepEqual(card.on_accept, { kind: 'unratify', node: 's7r-r' });
  assert.equal(card.project, true, 'accepting must fire the detached projection refresh (roster correction)');
  assert.equal(card.expected_status, 'ratified', 'ratified dominates the claim tier, accept.mjs parity');
  assert.equal(card.expected_node_hash, sha256(await readFile(nodeFile('s7r-r'))),
    'mint hash = sha256 of the node FILE bytes');
});

test('projection: proposed-rule card declares ratify + claim-tier preconditions', async () => {
  const scope = 's7p';
  await setScopes([scope]);
  await writePool([makeNode({ id: 's7p-p', title: 'A rule shaped candidate the gate ignores', type: 'identity', scope, centrality: 0.8 })]);
  const { loadPool } = await import('../nodes.mjs');
  const pNode = (await loadPool()).find((n) => n.id === 's7p-p');
  await writeState({ [scope]: {
    streaks: {}, emerging: [], graduated: {},
    gateSig: await gateSigFor(scope, { gateCandidates: [pNode] }),   // judge-free reuse path
  } });
  await runProjDriver();
  const card = await insightByPrefix(`${today()}-proposed-rule-s7p-p`);
  assert.deepEqual(card.on_accept, { kind: 'ratify', node: 's7p-p' });
  assert.equal(card.expected_status, 'principle', 'unratified node → the claim tier');
  assert.equal(card.expected_node_hash, sha256(await readFile(nodeFile('s7p-p'))));
  assert.notEqual(card.project, true, 'a proposed-rule accept does not force the detached refresh');
});

// ================================================================ end-to-end parity: accept.mjs accepts the minted cards

function runAccept(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(ENGINE_DIR, 'accept.mjs'), ...args], {
      env: {
        ...process.env, COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, PATH: '/usr/bin:/bin',
        HOME: TEST_MEMORY_ROOT, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
async function cardIdByPattern(pattern) {
  const files = (await readdir(INSIGHTS_DIR)).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const { frontmatter } = parseNode(await readFile(resolve(INSIGHTS_DIR, f), 'utf8'), f.slice(0, -3));
    if (frontmatter.pattern === pattern) return f.slice(0, -3);
  }
  assert.fail(`no card with pattern ${pattern}`);
}

test('end to end: accept.mjs executes the minted retire and merge cards against untouched nodes (hash/status parity proven)', async () => {
  // the shared temp root becomes its own repo ONCE, everything committed (accept's dirty-tree
  // fence and own-toplevel guard demand it); this test therefore runs after all mint scenarios.
  // driver-home holds a NESTED repo (judge-hermes' cache init) that would break `add -A`
  await writeFile(resolve(TEST_MEMORY_ROOT, '.gitignore'), 'driver-home/\n', 'utf8');
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'init', '--quiet']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'config', 'user.email', 'test@test.invalid']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '-A']);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'seed']);

  const tgtBefore = await readFile(nodeFile('stale-t'), 'utf8');

  // archive card (retire, claim tier 'principle')
  const retireId = await cardIdByPattern('memory-staleness::stale-a');
  const r1 = await runAccept(['accept', retireId]);
  assert.equal(r1.code, 0, `mint-time preconditions must pass accept's FRESH recompute byte for byte: ${r1.stderr}`);
  const aFm = parseNode(await readFile(nodeFile('stale-a'), 'utf8'), 'stale-a').frontmatter;
  assert.equal(aFm.superseded, true);
  assert.equal(aFm.superseded_by, `accept:${retireId}`);

  // fold card (merge into stale-t; target stays byte-identical)
  const mergeId = await cardIdByPattern('memory-staleness::stale-b');
  const r2 = await runAccept(['accept', mergeId]);
  assert.equal(r2.code, 0, r2.stderr);
  const bFm = parseNode(await readFile(nodeFile('stale-b'), 'utf8'), 'stale-b').frontmatter;
  assert.equal(bFm.superseded_by, 'stale-t');
  assert.equal(await readFile(nodeFile('stale-t'), 'utf8'), tgtBefore, 'merge never touches the target');

  // claim-less archive card ('unknown' tier parity end to end)
  const unknownId = await cardIdByPattern('memory-staleness::stale-s');
  const r3 = await runAccept(['accept', unknownId]);
  assert.equal(r3.code, 0, `the ?? 'unknown' fallback must agree on both sides: ${r3.stderr}`);
});

test('end to end: accept.mjs executes the projection-minted ratify card', async () => {
  const files = (await readdir(INSIGHTS_DIR)).filter((f) => f.startsWith(`${today()}-proposed-rule-s7p-p`));
  const cardId = files[0].slice(0, -3);
  await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'add', '-A']);
  const { stdout: staged } = await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'diff', '--cached', '--name-only']);
  if (staged.trim()) await execFileP('git', ['-C', TEST_MEMORY_ROOT, 'commit', '--quiet', '-m', 'post-accept residue']);
  const r = await runAccept(['accept', cardId]);
  assert.equal(r.code, 0, r.stderr);
  const fm = parseNode(await readFile(nodeFile('s7p-p'), 'utf8'), 's7p-p').frontmatter;
  assert.equal(fm.ratified?.via, 'dashboard', 'the proposed-rule accept ratifies the source node');
});
