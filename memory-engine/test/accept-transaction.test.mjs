// accept-transaction.test.mjs — MEM-38 step 6: the ATT-3 execution contract (accept.mjs
// transaction, locks.mjs tryAcquireLock, sidecar-tasks lift, writeNode atomicity, serializer
// carry-through of the four accept fields).
//
// AUTHORED AS THE INDEPENDENT TEST PASS: the implementation came from a different pass; every
// test here was verified to FAIL against a deliberately broken copy of the production behavior
// it targets and to pass against the shipped code (discrimination table in the pass report).
//
// Accept scenarios run the REAL CLI as a child process, each against its own scenario root
// (a subdir of the preload-minted temp root, so teardown stays owned by setup.mjs). Child
// processes get COCKPIT_MEMORY_ROOT pointed at the scenario root; the engine resolves the
// root at import time in the child, so no in-process MEMORY_ROOT gymnastics are needed and
// process.exit(75) / lock lifecycles are observed exactly as the dashboard middleware will
// observe them. Happy paths git-init the scenario root (the foreign-repo guard demands the
// memory root be its own toplevel); the guard scenarios use a bare dir and a nested-in-another-
// repo dir. PATH is pinned to /usr/bin:/bin and HOME inside the root so nothing a child spawns
// (detached projection refresh) can reach a real toolchain or a warm HF cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dump as yamlDump } from 'js-yaml';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';
import { parseNode, writeNode, NODES_DIR } from '../nodes.mjs';
import { writeInsightFile, INSIGHTS_DIR } from '../mechanical-insights.mjs';
import { tryAcquireLock, releaseLock, LOCK_FILE } from '../locks.mjs';
import { writeSidecarTask } from '../sidecar-tasks.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const ACCEPT = resolve(ENGINE_DIR, 'accept.mjs');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

// ---------- scenario-root plumbing ----------

let seq = 0;
async function makeRoot(name, { git = true } = {}) {
  const root = resolve(TEST_MEMORY_ROOT, 'accept-roots', `${String(++seq).padStart(2, '0')}-${name}`);
  await mkdir(resolve(root, 'insights'), { recursive: true });
  await mkdir(resolve(root, 'knowledge', 'nodes'), { recursive: true });
  await mkdir(resolve(root, '.reconciler'), { recursive: true });
  if (git) {
    await execFileP('git', ['-C', root, 'init', '--quiet']);
    await execFileP('git', ['-C', root, 'config', 'user.name', 'Test']);
    await execFileP('git', ['-C', root, 'config', 'user.email', 'test@test.invalid']);
  }
  return root;
}

function fmText(fm, body = 'Card body.') {
  const dumped = yamlDump(fm, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd();
  return `---\n${dumped}\n---\n\n${body}\n`;
}
async function writeCard(root, id, fm, { raw } = {}) {
  const path = resolve(root, 'insights', `${id}.md`);
  await writeFile(path, raw ?? fmText({ id, status: 'new', ...fm }), 'utf8');
  return path;
}
// a committed behavioral node the on_accept can ratify (uncommitted knowledge/ would trip the
// dirty-tree refusal first, by design).
async function writeTargetNode(root, id, extraFm = {}) {
  const path = resolve(root, 'knowledge', 'nodes', `${id}.md`);
  await writeFile(path, fmText({ id, title: id, type: 'identity', claim: 'principle', scope: 'cockpit', ...extraFm }, `Prose for ${id}.`), 'utf8');
  await execFileP('git', ['-C', root, 'add', '--', `knowledge/nodes/${id}.md`]);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', `seed ${id}`]);
  return path;
}

function runAccept(root, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ACCEPT, ...args], {
      env: {
        ...process.env,
        COCKPIT_MEMORY_ROOT: root,
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

const readCard = async (root, id) => parseNode(await readFile(resolve(root, 'insights', `${id}.md`), 'utf8'), id);
const cardBytes = (root, id) => readFile(resolve(root, 'insights', `${id}.md`), 'utf8');
const lockGone = async (root) => {
  try { await readFile(resolve(root, '.reconciler', 'lock')); return false; } catch { return true; }
};
async function gitLog(root) {
  const { stdout } = await execFileP('git', ['-C', root, 'log', '--format=%s', '--name-only']).catch(() => ({ stdout: '' }));
  return stdout;
}
// subject + touched paths of the HEAD commit only
async function gitHead(root) {
  const { stdout } = await execFileP('git', ['-C', root, 'show', '--name-only', '--format=%s', 'HEAD']);
  return stdout;
}
async function commitCount(root) {
  try { const { stdout } = await execFileP('git', ['-C', root, 'rev-list', '--all', '--count']); return Number(stdout.trim()); }
  catch { return 0; }
}

// ---------- accept CLI: fence, refusals, idempotency ----------

test('accept: live-holder lock → "busy" on stderr, exit 75, card untouched, holder lock not stolen', async () => {
  const root = await makeRoot('busy');
  await writeCard(root, 'card-busy', {});
  const before = await cardBytes(root, 'card-busy');
  // this test process is the live holder
  await writeFile(resolve(root, '.reconciler', 'lock'), JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  const r = await runAccept(root, ['accept', 'card-busy']);
  assert.equal(r.code, 75);
  assert.match(r.stderr, /busy/);
  assert.equal(await cardBytes(root, 'card-busy'), before, 'busy path must not write the card');
  const held = JSON.parse(await readFile(resolve(root, '.reconciler', 'lock'), 'utf8'));
  assert.equal(held.pid, process.pid, 'live holder lock must not be stolen or released');
});

test('accept: --dry-run is still honest about busy (exit 75, nothing written)', async () => {
  const root = await makeRoot('busy-dry');
  await writeCard(root, 'card-busy-dry', {});
  await writeFile(resolve(root, '.reconciler', 'lock'), JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  const r = await runAccept(root, ['accept', 'card-busy-dry', '--dry-run']);
  assert.equal(r.code, 75);
  assert.match(r.stderr, /busy/);
});

test('accept: dirty knowledge/ tree → refusal exit 1, card untouched, lock released', async () => {
  const root = await makeRoot('dirty');
  await writeTargetNode(root, 'node-clean');
  await writeCard(root, 'card-dirty', {});
  const before = await cardBytes(root, 'card-dirty');
  // an UNCOMMITTED knowledge write = the half-written canonical tree the fence protects
  await writeFile(resolve(root, 'knowledge', 'nodes', 'half-written.md'), 'oops', 'utf8');
  const r = await runAccept(root, ['accept', 'card-dirty']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(await cardBytes(root, 'card-dirty'), before);
  assert.ok(await lockGone(root), 'lock file must be gone after a refusal exit');
});

test('accept: status !== new is a no-op SUCCESS (exit 0), file byte-identical', async () => {
  const root = await makeRoot('idempotent');
  await writeCard(root, 'card-done', { status: 'applied', resolved: '2026-07-20T00:00:00.000Z' });
  const before = await cardBytes(root, 'card-done');
  const r = await runAccept(root, ['accept', 'card-done']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /already applied, nothing to do/);
  assert.equal(await cardBytes(root, 'card-done'), before);
  assert.ok(await lockGone(root));
});

test('accept: missing card → error exit 1; hostile card id never joins a path', async () => {
  const root = await makeRoot('missing');
  const r = await runAccept(root, ['accept', 'no-such-card']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /card not found/);
  const evil = await runAccept(root, ['accept', '../evil']);
  assert.equal(evil.code, 1);
  assert.doesNotMatch(evil.stderr, /card not found/, 'a non-slug id must be rejected before any path join');
});

// ---------- on_accept validation ----------

test('accept: unknown on_accept kind → refusal, card untouched, no commit', async () => {
  const root = await makeRoot('badkind');
  await writeTargetNode(root, 'node-a');
  const commits = await commitCount(root);
  await writeCard(root, 'card-badkind', { on_accept: { kind: 'frobnicate', node: 'node-a' } });
  const before = await cardBytes(root, 'card-badkind');
  const r = await runAccept(root, ['accept', 'card-badkind']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown on_accept kind/);
  assert.equal(await cardBytes(root, 'card-badkind'), before);
  assert.equal(await commitCount(root), commits);
});

test('accept: on_accept as a YAML array → refusal, card untouched', async () => {
  const root = await makeRoot('badshape');
  await writeCard(root, 'card-array', { on_accept: [{ kind: 'ratify', node: 'node-a' }] });
  const before = await cardBytes(root, 'card-array');
  const r = await runAccept(root, ['accept', 'card-array']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /on_accept is not an object/, 'the SHAPE check must refuse it, not a downstream accident');
  assert.equal(await cardBytes(root, 'card-array'), before);
});

test('accept: on_accept.kind reachable only through __proto__ must NOT execute', async () => {
  const root = await makeRoot('proto');
  await writeTargetNode(root, 'node-proto');
  // hand-written YAML: kind/node live only under a __proto__ key. If the parser turns that into
  // the prototype, onAccept.kind reads 'ratify' through the chain and a hostile card executes.
  const raw = [
    '---', 'id: card-proto', 'status: new', 'on_accept:', '  __proto__:',
    '    kind: ratify', '    node: node-proto', '---', '', 'Hostile card.', '',
  ].join('\n');
  await writeCard(root, 'card-proto', {}, { raw });
  const r = await runAccept(root, ['accept', 'card-proto']);
  assert.equal(r.code, 1, 'a card with no OWN kind must refuse');
  const node = parseNode(await readFile(resolve(root, 'knowledge', 'nodes', 'node-proto.md'), 'utf8'), 'node-proto');
  assert.equal(node.frontmatter.ratified, undefined, 'the target node must not have been ratified');
});

test('accept: on_accept.node that is not a slug → refusal (no path join)', async () => {
  const root = await makeRoot('badnode');
  await writeCard(root, 'card-badnode', { on_accept: { kind: 'ratify', node: '../escape' } });
  const r = await runAccept(root, ['accept', 'card-badnode']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a valid node id/);
});

// ---------- ratify happy path, execute-before-flip, commit scoping ----------

test('accept: ratify happy path — node ratified via dashboard, card applied, scoped commit', async () => {
  const root = await makeRoot('happy');
  await writeTargetNode(root, 'node-happy');
  await writeCard(root, 'card-happy', { on_accept: { kind: 'ratify', node: 'node-happy' } });
  const r = await runAccept(root, ['accept', 'card-happy']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /accepted card-happy/);
  assert.doesNotMatch(r.stdout, /projection refresh/, 'no project flag → no projection spawn line');

  const node = parseNode(await readFile(resolve(root, 'knowledge', 'nodes', 'node-happy.md'), 'utf8'), 'node-happy');
  assert.equal(node.frontmatter.ratified?.via, 'dashboard');
  assert.equal(node.frontmatter.ratified?.turn, 'dashboard:card-happy', 'turn defaults to dashboard:<card-id>');

  const card = await readCard(root, 'card-happy');
  assert.equal(card.frontmatter.status, 'applied');
  assert.ok(card.frontmatter.resolved, 'resolved stamped');

  // per-boundary commits (crash-retry safety): HEAD is the card commit, scoped to the card
  // alone; the node landed in its own earlier scoped commit.
  const head = await gitHead(root);
  assert.match(head, /accept: card-happy applied/);
  assert.match(head, /insights\/card-happy\.md/);
  assert.doesNotMatch(head, /knowledge\/nodes/, 'card commit is pathspec-scoped to the card alone');
  const log = await gitLog(root);
  assert.match(log, /accept: card-happy ratified \[\[node-happy\]\]/);
  assert.match(log, /knowledge\/nodes\/node-happy\.md/);
  assert.doesNotMatch(head, /half-written|node-clean/, 'commit is pathspec-scoped to the touched files');
  // the transaction left nothing of its own uncommitted
  const { stdout: dirty } = await execFileP('git', ['-C', root, 'status', '--porcelain', '--', 'insights/', 'knowledge/']);
  assert.equal(dirty.trim(), '');
  assert.ok(await lockGone(root));
});

test('accept: execute runs BEFORE the flip — missing target node leaves the card still new', async () => {
  const root = await makeRoot('order');
  await writeCard(root, 'card-order', { on_accept: { kind: 'ratify', node: 'node-absent' } });
  const r = await runAccept(root, ['accept', 'card-order']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /node not found/);
  const card = await readCard(root, 'card-order');
  assert.equal(card.frontmatter.status, 'new', 'a failed execute must never strand the card as applied');
  assert.ok(await lockGone(root));
});

test('accept: no-on_accept card → pure status flip + commit, no execute, no projection', async () => {
  const root = await makeRoot('pureflip');
  await writeTargetNode(root, 'node-untouched');
  await writeCard(root, 'card-flip', {});
  const r = await runAccept(root, ['accept', 'card-flip']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /projection refresh/);
  const card = await readCard(root, 'card-flip');
  assert.equal(card.frontmatter.status, 'applied');
  assert.ok(card.frontmatter.resolved);
  const node = parseNode(await readFile(resolve(root, 'knowledge', 'nodes', 'node-untouched.md'), 'utf8'), 'node-untouched');
  assert.equal(node.frontmatter.ratified, undefined);
  const head = await gitHead(root);
  assert.match(head, /insights\/card-flip\.md/);
  assert.doesNotMatch(head, /node-untouched/, 'flip-only commit must not sweep in node files');
});

// ---------- preconditions: fresh hash/status, refuse + re-mint ----------

test('accept: matching fresh preconditions pass and the accept applies', async () => {
  const root = await makeRoot('precond-ok');
  const nodePath = await writeTargetNode(root, 'node-pc');
  const liveHash = sha256(await readFile(nodePath));
  await writeCard(root, 'card-pc', {
    on_accept: { kind: 'ratify', node: 'node-pc' },
    expected_node_hash: liveHash,
    expected_status: 'principle',
  });
  const r = await runAccept(root, ['accept', 'card-pc']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await readCard(root, 'card-pc')).frontmatter.status, 'applied');
});

test('accept: stale expected_node_hash → refusal exit 1 + re-mint with FRESH live hash', async () => {
  const root = await makeRoot('precond-hash');
  const nodePath = await writeTargetNode(root, 'node-stale');
  const liveHash = sha256(await readFile(nodePath));
  await writeCard(root, 'card-stale', {
    on_accept: { kind: 'ratify', node: 'node-stale' },
    expected_node_hash: 'f'.repeat(64),
  });
  const r = await runAccept(root, ['accept', 'card-stale']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /preconditions stale/);
  const m = r.stderr.match(/re-minted as ([a-z0-9_-]+)/);
  assert.ok(m, `refusal must name the new card id (stderr: ${r.stderr})`);
  const newId = m[1];
  assert.ok(newId.startsWith(today()), 'new card id is minted off today');

  const fresh = await readCard(root, newId);
  assert.equal(fresh.frontmatter.status, 'new');
  assert.equal(fresh.frontmatter.expected_node_hash, liveHash, 're-mint must carry the FRESH live hash, never the stale one');
  const old = await readCard(root, 'card-stale');
  assert.equal(old.frontmatter.status, 'dismissed');
  assert.equal(old.frontmatter.superseded_by, newId);
  assert.ok(old.frontmatter.resolved);
  // the target node was NOT executed against stale expectations
  const node = parseNode(await readFile(nodePath, 'utf8'), 'node-stale');
  assert.equal(node.frontmatter.ratified, undefined);
  // both cards committed
  const { stdout: dirty } = await execFileP('git', ['-C', root, 'status', '--porcelain', '--', `insights/card-stale.md`, `insights/${newId}.md`]);
  assert.equal(dirty.trim(), '', 're-mint + dismissal must be committed');
  assert.match(await gitLog(root), /preconditions stale, re-minted/);
});

test('accept: stale expected_status → refusal + re-mint with the LIVE status', async () => {
  const root = await makeRoot('precond-status');
  await writeTargetNode(root, 'node-status');
  await writeCard(root, 'card-status', {
    on_accept: { kind: 'ratify', node: 'node-status' },
    expected_status: 'ratified',   // live is claim tier 'principle'
  });
  const r = await runAccept(root, ['accept', 'card-status']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /status is principle, expected ratified/);
  const newId = r.stderr.match(/re-minted as ([a-z0-9_-]+)/)?.[1];
  assert.ok(newId);
  const fresh = await readCard(root, newId);
  assert.equal(fresh.frontmatter.status, 'new');
  assert.equal(fresh.frontmatter.expected_status, 'principle');
  assert.equal(fresh.frontmatter.expected_node_hash, undefined, 'a card that never wanted a hash gate must not grow one');
});

test('accept: expected fields absent → no precondition check even when the node moved', async () => {
  const root = await makeRoot('precond-absent');
  await writeTargetNode(root, 'node-moved');
  await writeCard(root, 'card-nopc', { on_accept: { kind: 'ratify', node: 'node-moved' } });
  const r = await runAccept(root, ['accept', 'card-nopc']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await readCard(root, 'card-nopc')).frontmatter.status, 'applied');
});

// ---------- projection spawn + dry-run ----------

test('accept: project === true and on_accept ran → the detached-refresh log path is printed', async () => {
  const root = await makeRoot('project');
  await writeTargetNode(root, 'node-proj');
  await writeCard(root, 'card-proj', { on_accept: { kind: 'ratify', node: 'node-proj' }, project: true });
  const r = await runAccept(root, ['accept', 'card-proj']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /projection refresh started \(detached; log: .*projection-refresh\.log\)/);
});

test('accept: project true WITHOUT on_accept → pure flip, no projection spawn', async () => {
  const root = await makeRoot('project-noop');
  await writeCard(root, 'card-proj-flip', { project: true });
  const r = await runAccept(root, ['accept', 'card-proj-flip']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /projection refresh/, 'projection is gated on on_accept having run');
});

test('accept: --dry-run previews the ratify path and writes nothing', async () => {
  const root = await makeRoot('dryrun');
  const nodePath = await writeTargetNode(root, 'node-dry');
  await writeCard(root, 'card-dry', { on_accept: { kind: 'ratify', node: 'node-dry' }, project: true });
  const cardBefore = await cardBytes(root, 'card-dry');
  const nodeBefore = await readFile(nodePath, 'utf8');
  const commits = await commitCount(root);
  const r = await runAccept(root, ['accept', 'card-dry', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /would ratify \[\[node-dry\]\]/);
  assert.match(r.stdout, /projection refresh/, 'the preview names the projection step it would take');
  assert.equal(await cardBytes(root, 'card-dry'), cardBefore, 'dry-run must not touch the card');
  assert.equal(await readFile(nodePath, 'utf8'), nodeBefore, 'dry-run must not touch the node');
  assert.equal(await commitCount(root), commits, 'dry-run must not commit');
  assert.ok(await lockGone(root));
});

test('accept: --dry-run on a stale card previews the re-mint without writing it', async () => {
  const root = await makeRoot('dryrun-stale');
  await writeTargetNode(root, 'node-dry-stale');
  await writeCard(root, 'card-dry-stale', {
    on_accept: { kind: 'ratify', node: 'node-dry-stale' },
    expected_node_hash: 'f'.repeat(64),
  });
  const before = await cardBytes(root, 'card-dry-stale');
  const r = await runAccept(root, ['accept', 'card-dry-stale', '--dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /would refuse: preconditions stale/);
  assert.equal(await cardBytes(root, 'card-dry-stale'), before);
  const files = await readdir(resolve(root, 'insights'));
  assert.deepEqual(files, ['card-dry-stale.md'], 'dry-run must not mint the replacement card');
});

// ---------- foreign-repo guard ----------

test('accept: memory root that is not a git repo → refusal, no commit anywhere', async () => {
  const root = await makeRoot('norepo', { git: false });
  await writeCard(root, 'card-norepo', {});
  const r = await runAccept(root, ['accept', 'card-norepo']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /memory root is not a git repo/);
});

test('accept: memory root nested inside ANOTHER repo → refusal, parent repo untouched', async () => {
  const outer = resolve(TEST_MEMORY_ROOT, 'accept-roots', `${String(++seq).padStart(2, '0')}-outer`);
  await mkdir(outer, { recursive: true });
  await execFileP('git', ['-C', outer, 'init', '--quiet']);
  await execFileP('git', ['-C', outer, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', outer, 'config', 'user.email', 'test@test.invalid']);
  const root = resolve(outer, 'memory');
  await mkdir(resolve(root, 'insights'), { recursive: true });
  await mkdir(resolve(root, 'knowledge', 'nodes'), { recursive: true });
  await writeCard(root, 'card-nested', {});
  // commit everything in the OUTER repo so the knowledge/ dirty check (which git resolves
  // against the parent) does not fire first — the guard itself must be what refuses.
  await execFileP('git', ['-C', outer, 'add', '-A']);
  await execFileP('git', ['-C', outer, 'commit', '--quiet', '-m', 'seed']);
  const commits = await commitCount(outer);
  const r = await runAccept(root, ['accept', 'card-nested']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not its own git repo/);
  assert.equal(await commitCount(outer), commits, 'the PARENT repo must never receive the commit');
});

// ---------- crash boundaries (per-boundary commits: every window has a deterministic retry) ----------

test('crash boundary: node committed, flip lost → retry succeeds with NO duplicate node commit', async () => {
  const root = await makeRoot('crash-node-committed');
  await writeTargetNode(root, 'node-cb1');
  await writeCard(root, 'card-cb1', { on_accept: { kind: 'ratify', node: 'node-cb1' } });
  // simulate the crash window by hand: the prior run ratified and committed the node, then died
  // before the flip. Ratify through the real write path, commit like the prior run would have.
  // ratifyNode writes via the in-process MEMORY_ROOT, so drive the child CLI instead
  const rat = await new Promise((done) => {
    const child = spawn(process.execPath, [resolve(ENGINE_DIR, 'ratify.mjs'), 'node-cb1', '--via', 'dashboard', '--turn', 'dashboard:card-cb1'], {
      env: { ...process.env, COCKPIT_MEMORY_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stderr }));
  });
  assert.equal(rat.code, 0, rat.stderr);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'accept: card-cb1 ratified [[node-cb1]]', '--', 'knowledge/nodes/node-cb1.md']);
  const nodeBytes = await readFile(resolve(root, 'knowledge', 'nodes', 'node-cb1.md'), 'utf8');
  const commits = await commitCount(root);

  const r = await runAccept(root, ['accept', 'card-cb1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await commitCount(root), commits + 1, 'retry adds exactly the card commit, never a second node commit');
  const head = await gitHead(root);
  assert.match(head, /accept: card-cb1 applied/);
  assert.doesNotMatch(head, /knowledge\/nodes/);
  assert.equal(await readFile(resolve(root, 'knowledge', 'nodes', 'node-cb1.md'), 'utf8'), nodeBytes, 'idempotent re-execute must not rewrite the already-ratified node');
  assert.equal((await readCard(root, 'card-cb1')).frontmatter.status, 'applied');
  const { stdout: dirty } = await execFileP('git', ['-C', root, 'status', '--porcelain', '--', 'insights/', 'knowledge/']);
  assert.equal(dirty.trim(), '');
});

test('crash boundary: flip landed, card commit lost → no-op path HEALS the commit', async () => {
  const root = await makeRoot('crash-flip-uncommitted');
  await writeCard(root, 'card-cb2', { status: 'applied', resolved: '2026-07-25T00:00:00.000Z' });
  // seed a commit so the repo has a HEAD, leaving the flipped card uncommitted
  await writeTargetNode(root, 'node-cb2');
  const commits = await commitCount(root);
  const r = await runAccept(root, ['accept', 'card-cb2']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already applied, nothing to do/);
  assert.equal(await commitCount(root), commits + 1, 'the heal commit must land');
  assert.match(await gitHead(root), /commit heal after crash/);
  const { stdout: dirty } = await execFileP('git', ['-C', root, 'status', '--porcelain', '--', 'insights/card-cb2.md']);
  assert.equal(dirty.trim(), '', 'card file committed, tree clean');
});

test('crash boundary: re-mint retry finds the existing replacement, no third card', async () => {
  const root = await makeRoot('crash-remint-retry');
  const nodePath = await writeTargetNode(root, 'node-cb3');
  const liveHash = sha256(await readFile(nodePath));
  await writeCard(root, 'card-cb3-old', {
    on_accept: { kind: 'ratify', node: 'node-cb3' },
    expected_node_hash: 'f'.repeat(64),
  });
  // the crashed prior run already minted + committed the replacement (fresh live expectations,
  // lineage stamped: adoption requires reminted_from naming the old card)
  await writeCard(root, 'replacement-cb3', {
    on_accept: { kind: 'ratify', node: 'node-cb3' },
    expected_node_hash: liveHash,
    reminted_from: 'card-cb3-old',
  });
  await execFileP('git', ['-C', root, 'add', '--', 'insights/replacement-cb3.md']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'accept: card-cb3-old preconditions stale, re-minted as replacement-cb3']);

  const r = await runAccept(root, ['accept', 'card-cb3-old']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /re-minted as replacement-cb3/, 'retry must reuse the EXISTING replacement');
  const files = (await readdir(resolve(root, 'insights'))).sort();
  assert.deepEqual(files, ['card-cb3-old.md', 'replacement-cb3.md'], 'no third card minted');
  const old = await readCard(root, 'card-cb3-old');
  assert.equal(old.frontmatter.status, 'dismissed');
  assert.equal(old.frontmatter.superseded_by, 'replacement-cb3');
  const { stdout: dirty } = await execFileP('git', ['-C', root, 'status', '--porcelain', '--', 'insights/']);
  assert.equal(dirty.trim(), '', 'dismissal committed');
});

test('crash boundary: node moved AGAIN after the crash → fresh replacement, orphan stays new', async () => {
  const root = await makeRoot('crash-remint-moved');
  const nodePath = await writeTargetNode(root, 'node-cb4');
  const hashAtCrash = sha256(await readFile(nodePath));
  await writeCard(root, 'card-cb4-old', {
    on_accept: { kind: 'ratify', node: 'node-cb4' },
    expected_node_hash: 'f'.repeat(64),
  });
  await writeCard(root, 'replacement-cb4', {
    on_accept: { kind: 'ratify', node: 'node-cb4' },
    expected_node_hash: hashAtCrash,
    reminted_from: 'card-cb4-old',
  });
  await execFileP('git', ['-C', root, 'add', '--', 'insights/replacement-cb4.md']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'crashed re-mint']);
  // the node moves once more before the retry: the orphan's expectations are stale too
  await writeFile(nodePath, fmText({ id: 'node-cb4', title: 'moved', type: 'identity', claim: 'principle', scope: 'cockpit' }, 'Moved prose.'), 'utf8');
  await execFileP('git', ['-C', root, 'add', '--', 'knowledge/nodes/node-cb4.md']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'node moved again']);
  const liveHash = sha256(await readFile(nodePath));

  const r = await runAccept(root, ['accept', 'card-cb4-old']);
  assert.equal(r.code, 1);
  const newId = r.stderr.match(/re-minted as ([a-z0-9_-]+)/)?.[1];
  assert.ok(newId && newId !== 'replacement-cb4', 'a stale orphan must NOT be reused');
  const files = (await readdir(resolve(root, 'insights'))).sort();
  assert.equal(files.length, 3, 'exactly one new twin minted');
  const twin = await readCard(root, newId);
  assert.equal(twin.frontmatter.expected_node_hash, liveHash);
  assert.equal(twin.frontmatter.reminted_from, 'card-cb4-old', 'the fresh twin carries lineage too');
  assert.equal((await readCard(root, 'card-cb4-old')).frontmatter.superseded_by, newId, 'old card points at the NEWEST replacement');
  assert.equal((await readCard(root, 'replacement-cb4')).frontmatter.status, 'new', 'the orphan is documented residue, left new');
});

test('re-mint adoption requires lineage: an unrelated look-alike card is never adopted', async () => {
  const root = await makeRoot('remint-lineage');
  const nodePath = await writeTargetNode(root, 'node-cb6');
  const liveHash = sha256(await readFile(nodePath));
  await writeCard(root, 'card-cb6-old', {
    on_accept: { kind: 'ratify', node: 'node-cb6' },
    expected_node_hash: 'f'.repeat(64),
  });
  // an UNRELATED card: same ratify target, expectations equal to the CURRENT live state, but no
  // reminted_from lineage and its own claim text. Without the lineage check it is a perfect
  // adoption decoy.
  await writeCard(root, 'lookalike-cb6', {
    claim: 'a different concern entirely',
    on_accept: { kind: 'ratify', node: 'node-cb6' },
    expected_node_hash: liveHash,
  });
  await execFileP('git', ['-C', root, 'add', '--', 'insights/lookalike-cb6.md']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'unrelated card']);
  const lookalikeBefore = await cardBytes(root, 'lookalike-cb6');

  const r = await runAccept(root, ['accept', 'card-cb6-old']);
  assert.equal(r.code, 1);
  const newId = r.stderr.match(/re-minted as ([a-z0-9_-]+)/)?.[1];
  assert.ok(newId && newId !== 'lookalike-cb6', 'the look-alike must NOT be adopted as the replacement');
  const fresh = await readCard(root, newId);
  assert.equal(fresh.frontmatter.reminted_from, 'card-cb6-old', 'the fresh replacement carries lineage to the old card');
  assert.equal(fresh.frontmatter.status, 'new');
  assert.equal(fresh.frontmatter.expected_node_hash, liveHash);
  assert.equal((await readCard(root, 'card-cb6-old')).frontmatter.superseded_by, newId, 'supersession points at the fresh replacement, not the look-alike');
  assert.equal(await cardBytes(root, 'lookalike-cb6'), lookalikeBefore, 'the unrelated card is untouched byte-identical');
});

test('crash boundary: crash before the node commit surfaces as the dirty-tree refusal', async () => {
  const root = await makeRoot('crash-pre-commit');
  const nodePath = await writeTargetNode(root, 'node-cb5');
  await writeCard(root, 'card-cb5', { on_accept: { kind: 'ratify', node: 'node-cb5' } });
  // a MODIFIED tracked node left uncommitted (the ratify write landed, the commit did not)
  await writeFile(nodePath, (await readFile(nodePath, 'utf8')) + '\nMid-write residue.\n', 'utf8');
  const before = await cardBytes(root, 'card-cb5');
  const r = await runAccept(root, ['accept', 'card-cb5']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(await cardBytes(root, 'card-cb5'), before, 'card untouched: this window surfaces loudly by design');
});

// ---------- projection.mjs direct entry (lock) + --refresh-projection wrapper ----------

function runChild(script, args, root, extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(ENGINE_DIR, script), ...args], {
      env: {
        ...process.env, COCKPIT_MEMORY_ROOT: root, PATH: '/usr/bin:/bin', HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('projection direct entry: live-held lock → busy exit 75, lock not stolen', async () => {
  const root = await makeRoot('proj-busy');
  await writeFile(resolve(root, '.reconciler', 'lock'), JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  const r = await runChild('projection.mjs', [], root);
  assert.equal(r.code, 75);
  assert.match(r.stderr, /busy/);
  assert.equal(JSON.parse(await readFile(resolve(root, '.reconciler', 'lock'), 'utf8')).pid, process.pid, 'live lock survives');
});

test('projection direct entry: free lock → runs and releases (lock gone after)', async () => {
  const root = await makeRoot('proj-free');
  const r = await runChild('projection.mjs', [], root);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await lockGone(root), 'the direct entry must release the lock in a finally');
});

test('--refresh-projection wrapper: retries on busy, completes once the lock frees', async () => {
  const root = await makeRoot('refresh-wrapper');
  const lockPath = resolve(root, '.reconciler', 'lock');
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  const finished = runChild('accept.mjs', ['--refresh-projection'], root);
  // free the lock once the first busy retry is on record (poll the promise-shared buffers is not
  // possible here, so free it after a beat longer than one attempt; the 5s retry then succeeds)
  await new Promise((res) => setTimeout(res, 1500));
  await rm(lockPath, { force: true });
  const r = await finished;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /projection refresh: busy \(exit 75\), retrying in 5s/, 'at least one busy retry logged');
  assert.match(r.stdout, /projection refresh: done \(attempt \d+\)/, 'completion logged after the lock freed');
  assert.ok(await lockGone(root));
});

// ---------- locks.mjs tryAcquireLock (in-process, shared temp root) ----------

test('tryAcquireLock: live holder → false, lock not stolen; released cleanly after', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  await writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
  try {
    assert.equal(await tryAcquireLock(), false);
    assert.equal(JSON.parse(await readFile(LOCK_FILE, 'utf8')).pid, process.pid, 'live lock must survive the attempt');
  } finally { await rm(LOCK_FILE, { force: true }); }
});

test('tryAcquireLock: stale dead-pid lock → cleared and acquired', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  // spawn-and-reap a real child so the pid is guaranteed dead and was recently valid
  const child = spawn(process.execPath, ['-e', '']);
  const deadPid = child.pid;
  await new Promise((res) => child.on('exit', res));
  await writeFile(LOCK_FILE, JSON.stringify({ pid: deadPid, at: 'then' }), 'utf8');
  try {
    assert.equal(await tryAcquireLock(), true);
    assert.equal(JSON.parse(await readFile(LOCK_FILE, 'utf8')).pid, process.pid, 'acquired lock carries OUR pid');
  } finally { await releaseLock(); }
});

test('tryAcquireLock: garbled lock file → treated as stale, cleared and acquired', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  await writeFile(LOCK_FILE, 'not json at all', 'utf8');
  try {
    assert.equal(await tryAcquireLock(), true);
    assert.equal(JSON.parse(await readFile(LOCK_FILE, 'utf8')).pid, process.pid);
  } finally { await releaseLock(); }
});

// ---------- writeNode atomicity ----------

test('writeNode: tmp+rename — content lands whole, no tmp residue', async () => {
  await writeNode({ id: 'atomic-node', frontmatter: { id: 'atomic-node', title: 'Atomic', type: 'identity', claim: 'principle' }, body: 'Atomic body.' });
  const files = await readdir(NODES_DIR);
  assert.ok(files.includes('atomic-node.md'));
  assert.equal(files.filter((f) => f.includes('.tmp-')).length, 0, 'no tmp file left behind');
  const back = parseNode(await readFile(resolve(NODES_DIR, 'atomic-node.md'), 'utf8'), 'atomic-node');
  assert.equal(back.frontmatter.title, 'Atomic');
  assert.equal(back.body, 'Atomic body.');
  await rm(resolve(NODES_DIR, 'atomic-node.md'), { force: true });
});

// ---------- sidecar-tasks lift ----------

test('writeSidecarTask: writes under ## Next, dedupes on the inline marker, gates on missing heading/file', async () => {
  const dir = resolve(TEST_MEMORY_ROOT, 'sidecars');
  await mkdir(dir, { recursive: true });
  const sidecar = resolve(dir, 'proj.roadmap.md');
  await writeFile(sidecar, '# Roadmap\n\n## Now\n\n## Next\n\n- [ ] existing\n\n## Done\n', 'utf8');

  const first = await writeSidecarTask(sidecar, 'item-1', 'do the thing');
  assert.deepEqual(first, { ok: true, deduped: false });
  const text = await readFile(sidecar, 'utf8');
  assert.match(text, /## Next\n- \[ \] do the thing {2}<!-- inbox:item-1 -->/);

  const retry = await writeSidecarTask(sidecar, 'item-1', 'do the thing');
  assert.deepEqual(retry, { ok: true, deduped: true });
  assert.equal(await readFile(sidecar, 'utf8'), text, 'a deduped retry must not touch the file');

  const noHeading = resolve(dir, 'no-next.roadmap.md');
  await writeFile(noHeading, '# Roadmap\n\n## Now\n', 'utf8');
  assert.deepEqual(await writeSidecarTask(noHeading, 'item-2', 'x'), { ok: false, reason: 'no-next-heading' });

  assert.deepEqual(await writeSidecarTask(resolve(dir, 'absent.md'), 'item-3', 'x'), { ok: false, reason: 'no-sidecar' });
});

// ---------- serializer carry-through of the four accept fields ----------

test('mechanical-insights serializer: the accept fields survive and land in INSIGHT_FIELDS order', async () => {
  const path = resolve(INSIGHTS_DIR, 'field-order-probe.md');
  // scrambled insertion order on purpose: output order must come from INSIGHT_FIELDS, not the fm
  await writeInsightFile(path, {
    superseded_by: 'other-card',
    expected_status: 'principle',
    project: true,
    expected_node_hash: 'a'.repeat(64),
    on_accept: { kind: 'ratify', node: 'some-node' },
    status: 'new',
    id: 'field-order-probe',
    claim: 'probe',
  }, 'Probe body.', false);
  const text = await readFile(path, 'utf8');
  const back = parseNode(text, 'field-order-probe');
  assert.deepEqual(back.frontmatter.on_accept, { kind: 'ratify', node: 'some-node' });
  assert.equal(back.frontmatter.project, true);
  assert.equal(back.frontmatter.expected_node_hash, 'a'.repeat(64));
  assert.equal(back.frontmatter.expected_status, 'principle');
  const order = ['id', 'claim', 'status', 'on_accept', 'project', 'expected_node_hash', 'expected_status', 'superseded_by']
    .map((k) => text.indexOf(`\n${k}:`) >= 0 ? text.indexOf(`\n${k}:`) : text.indexOf(`${k}:`));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `field ${i} out of INSIGHT_FIELDS order (positions: ${order.join(',')})`);
  }
  await rm(path, { force: true });
});

test('doc-proposals serializer: on_accept/project/expected_* survive a real rewrite (strict FIELDS)', async () => {
  // doc-proposals' serialize() DROPS unlisted keys, so a status flip through its own CLI is the
  // load-bearing round trip: write a proposal carrying the four fields, dismiss it, re-read.
  const root = await makeRoot('docprop', { git: false });
  const dpDir = resolve(root, 'doc-proposals');
  await mkdir(dpDir, { recursive: true });
  const fm = {
    id: 'dp-1', claim: 'probe', status: 'new', detected: '2026-07-25T00:00:00.000Z',
    on_accept: { kind: 'ratify', node: 'some-node' },
    project: true,
    expected_node_hash: 'b'.repeat(64),
    expected_status: 'principle',
  };
  await writeFile(resolve(dpDir, 'dp-1.md'), fmText(fm, 'Draft body.'), 'utf8');
  const r = await new Promise((done) => {
    const child = spawn(process.execPath, [resolve(ENGINE_DIR, 'doc-proposals.mjs'), 'dismiss', 'dp-1'], {
      env: { ...process.env, COCKPIT_MEMORY_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  const back = parseNode(await readFile(resolve(dpDir, 'dp-1.md'), 'utf8'), 'dp-1');
  assert.equal(back.frontmatter.status, 'dismissed', 'the rewrite actually happened');
  assert.deepEqual(back.frontmatter.on_accept, { kind: 'ratify', node: 'some-node' }, 'strict serializer must LIST on_accept or it is silently dropped');
  assert.equal(back.frontmatter.project, true);
  assert.equal(back.frontmatter.expected_node_hash, 'b'.repeat(64));
  assert.equal(back.frontmatter.expected_status, 'principle');
});
