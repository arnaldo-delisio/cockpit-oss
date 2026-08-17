// accept-onaccept.test.mjs — MEM-38 step 7: the grown on_accept registry (task, retire, merge,
// doc-edit, unratify), per-kind preconditions (expected_target_hash included), crash-window
// idempotency for the destructive kinds, and the kind-agnostic re-mint adoption rule.
//
// AUTHORED AS THE INDEPENDENT TEST PASS: the implementation came from a different pass; every
// test group here was verified to FAIL against a deliberately broken copy of the production
// behavior it targets and to pass against the shipped code (discrimination table in the pass
// report, not in this file).
//
// Same harness posture as accept-transaction.test.mjs: every scenario runs the REAL accept.mjs
// CLI as a child process against its own git-inited scenario root under the preload-minted temp
// root (teardown stays owned by setup.mjs), COCKPIT_MEMORY_ROOT pointed at the scenario root,
// PATH pinned to /usr/bin:/bin and HOME inside the root so nothing a child spawns can reach a
// real toolchain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dump as yamlDump } from 'js-yaml';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';
import { parseNode } from '../nodes.mjs';
import { writeProposal } from '../doc-proposals.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const ACCEPT = resolve(ENGINE_DIR, 'accept.mjs');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

// ---------- scenario-root plumbing (accept-transaction.test.mjs's pattern, distinct subdir) ----------

let seq = 0;
async function makeRoot(name) {
  const root = resolve(TEST_MEMORY_ROOT, 'onaccept-roots', `${String(++seq).padStart(2, '0')}-${name}`);
  await mkdir(resolve(root, 'insights'), { recursive: true });
  await mkdir(resolve(root, 'knowledge', 'nodes'), { recursive: true });
  await mkdir(resolve(root, '.reconciler'), { recursive: true });
  await execFileP('git', ['-C', root, 'init', '--quiet']);
  await execFileP('git', ['-C', root, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', root, 'config', 'user.email', 'test@test.invalid']);
  return root;
}

function fmText(fm, body = 'Card body.') {
  const dumped = yamlDump(fm, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd();
  return `---\n${dumped}\n---\n\n${body}\n`;
}
async function writeCard(root, id, fm) {
  const path = resolve(root, 'insights', `${id}.md`);
  await writeFile(path, fmText({ id, status: 'new', ...fm }), 'utf8');
  return path;
}
// a COMMITTED node (uncommitted knowledge/ trips the dirty-tree refusal first, by design)
async function writeTargetNode(root, id, extraFm = {}, commit = true) {
  const path = resolve(root, 'knowledge', 'nodes', `${id}.md`);
  await writeFile(path, fmText({ id, title: id, type: 'identity', claim: 'principle', scope: 'cockpit', ...extraFm }, `Prose for ${id}.`), 'utf8');
  if (commit) {
    await execFileP('git', ['-C', root, 'add', '--', `knowledge/nodes/${id}.md`]);
    await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', `seed ${id}`]);
  }
  return path;
}
// a live Project object + roadmap sidecar in the convention listAllProjects/accept resolve
// (scopes/<scope>/projects/<id>.md beside <id>.roadmap.md)
// committed like the real repo's (the step 7 fix round added a pre-execute dirty-write-set guard:
// an UNCOMMITTED sidecar is now a refusal in its own right, tested separately below)
async function writeProject(root, scope, id, { state = 'active', sidecar = '# Roadmap\n\n## Now\n\n## Next\n\n## Done\n', commit = true } = {}) {
  const dir = resolve(root, 'scopes', scope, 'projects');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `${id}.md`), fmText({ id, scope, state }, `Project ${id}.`), 'utf8');
  if (sidecar !== null) await writeFile(resolve(dir, `${id}.roadmap.md`), sidecar, 'utf8');
  if (commit) {
    await execFileP('git', ['-C', root, 'add', '--', `scopes/${scope}/projects/`]);
    await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', `seed project ${id}`]);
  }
  return resolve(dir, `${id}.roadmap.md`);
}
// seeded THROUGH the store's own writer (round 2: the applied-heal path byte-compares the disk
// proposal against writeProposal's own serialization, so hand-rolled bytes would never heal)
async function writeDocProposal(root, id, { target, status = 'new', draft = 'New doc body.\n', resolved = null }) {
  const dir = resolve(root, 'doc-proposals');
  await mkdir(dir, { recursive: true });
  // mintDocProposal's wrapping: the draft rides inside a ```markdown fence
  const body = `\`\`\`markdown\n${draft.trim()}\n\`\`\`\n`;
  const fm = { id, claim: 'probe', target, scope: 'cockpit', status, detected: '2026-07-25T00:00:00.000Z', ...(resolved ? { resolved } : {}) };
  await writeProposal(resolve(dir, `${id}.md`), fm, body, false);
  return resolve(dir, `${id}.md`);
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
const nodeBytes = (root, id) => readFile(resolve(root, 'knowledge', 'nodes', `${id}.md`), 'utf8');
const readNodeFm = async (root, id) => parseNode(await nodeBytes(root, id), id).frontmatter;
async function gitHead(root) {
  const { stdout } = await execFileP('git', ['-C', root, 'show', '--name-only', '--format=%s', 'HEAD']);
  return stdout;
}
async function commitCount(root) {
  try { const { stdout } = await execFileP('git', ['-C', root, 'rev-list', '--all', '--count']); return Number(stdout.trim()); }
  catch { return 0; }
}
// seed files a test never committed (e.g. the Project OBJECT beside a routed sidecar) are the
// test's residue, not the transaction's, so the sweep takes explicit paths where needed.
async function assertClean(root, paths = ['insights/', 'knowledge/', 'doc-proposals/']) {
  const { stdout } = await execFileP('git', ['-C', root, 'status', '--porcelain', '--', ...paths]);
  assert.equal(stdout.trim(), '', 'transaction must leave nothing of its own uncommitted');
}
const remintedId = (stderr) => stderr.match(/re-minted as ([a-z0-9_-]+)/)?.[1];
// files touched by the first commit whose subject matches (boundary-commit scoping assertions)
async function commitFilesOf(root, subjectRe) {
  const { stdout } = await execFileP('git', ['-C', root, 'log', '--format=%H %s']);
  const line = stdout.split('\n').find((l) => subjectRe.test(l.slice(41)));
  assert.ok(line, `no commit matching ${subjectRe}`);
  const { stdout: files } = await execFileP('git', ['-C', root, 'show', '--name-only', '--format=', line.slice(0, 40)]);
  return files.split('\n').filter(Boolean).sort();
}

// ================================================================ kind: task

test('task: line lands under ## Next with the card-id marker, scoped commit, card applied', async () => {
  const root = await makeRoot('task-happy');
  const sidecar = await writeProject(root, 'cockpit', 'proj-a');
  await writeCard(root, 'card-task', { on_accept: { kind: 'task', project: 'proj-a', line: 'Do the thing' } });
  const r = await runAccept(root, ['accept', 'card-task']);
  assert.equal(r.code, 0, r.stderr);
  const text = await readFile(sidecar, 'utf8');
  assert.match(text, /## Next\n- \[ \] Do the thing {2}<!-- inbox:card-task -->/, 'the line is appended under ## Next keyed on the CARD id');
  assert.equal((await readCard(root, 'card-task')).frontmatter.status, 'applied');
  assert.deepEqual(await commitFilesOf(root, /^accept: card-task applied/), ['insights/card-task.md'],
    'card commit is pathspec-scoped to the card alone');
  assert.deepEqual(await commitFilesOf(root, /^accept: card-task task to proj-a roadmap$/),
    ['scopes/cockpit/projects/proj-a.roadmap.md'], 'the sidecar landed in its own boundary commit');
  await assertClean(root, ['insights/', 'scopes/cockpit/projects/proj-a.roadmap.md']);
});

test('task crash window: sidecar written+committed, flip lost → retry dedupes on the marker, no duplicate line', async () => {
  const root = await makeRoot('task-retry');
  const sidecar = await writeProject(root, 'cockpit', 'proj-b', {
    // the prior run's execute boundary already landed: line present with THIS card's marker
    sidecar: '# Roadmap\n\n## Now\n\n## Next\n- [ ] Do it  <!-- inbox:card-task-rt -->\n\n## Done\n',
  });
  await writeCard(root, 'card-task-rt', { on_accept: { kind: 'task', project: 'proj-b', line: 'Do it' } });
  const before = await readFile(sidecar, 'utf8');
  const r = await runAccept(root, ['accept', 'card-task-rt']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already present/, 'the retry reports the dedupe');
  assert.equal(await readFile(sidecar, 'utf8'), before, 'no duplicate checklist line');
  assert.equal((await readCard(root, 'card-task-rt')).frontmatter.status, 'applied');
  await assertClean(root);
});

test('task: empty project and no --project → machine-readable project-required refusal, card untouched', async () => {
  const root = await makeRoot('task-noproj');
  await writeCard(root, 'card-noproj', { on_accept: { kind: 'task', project: '', line: 'Orphan task' } });
  const before = await cardBytes(root, 'card-noproj');
  const r = await runAccept(root, ['accept', 'card-noproj']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /project-required/);
  assert.equal(await cardBytes(root, 'card-noproj'), before);
});

test('task: --project override routes an empty-project card into the chosen roadmap', async () => {
  const root = await makeRoot('task-override');
  const sidecar = await writeProject(root, 'cockpit', 'proj-c');
  await writeCard(root, 'card-override', { on_accept: { kind: 'task', project: '', line: 'Routed by hand' } });
  const r = await runAccept(root, ['accept', 'card-override', '--project', 'proj-c']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(await readFile(sidecar, 'utf8'), /- \[ \] Routed by hand {2}<!-- inbox:card-override -->/);
  assert.equal((await readCard(root, 'card-override')).frontmatter.status, 'applied');
});

test('task: unknown and archived projects both refuse with project-not-found', async () => {
  const root = await makeRoot('task-notfound');
  await writeProject(root, 'cockpit', 'proj-dead', { state: 'archived' });
  await writeCard(root, 'card-ghost', { on_accept: { kind: 'task', project: 'proj-ghost', line: 'x' } });
  await writeCard(root, 'card-dead', { on_accept: { kind: 'task', project: 'proj-dead', line: 'x' } });
  const g = await runAccept(root, ['accept', 'card-ghost']);
  assert.equal(g.code, 1);
  assert.match(g.stderr, /project-not-found: proj-ghost/);
  const d = await runAccept(root, ['accept', 'card-dead']);
  assert.equal(d.code, 1);
  assert.match(d.stderr, /project-not-found: proj-dead/, 'an archived project is not a live routing target');
  assert.equal((await readCard(root, 'card-ghost')).frontmatter.status, 'new');
});

test('task: missing sidecar and missing ## Next heading are refusals, card untouched', async () => {
  const root = await makeRoot('task-gates');
  await writeProject(root, 'cockpit', 'proj-nosc', { sidecar: null });
  await writeProject(root, 'cockpit', 'proj-nonext', { sidecar: '# Roadmap\n\n## Now\n' });
  await writeCard(root, 'card-nosc', { on_accept: { kind: 'task', project: 'proj-nosc', line: 'x' } });
  await writeCard(root, 'card-nonext', { on_accept: { kind: 'task', project: 'proj-nonext', line: 'x' } });
  const a = await runAccept(root, ['accept', 'card-nosc']);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /sidecar write failed \(no-sidecar\)/);
  const b = await runAccept(root, ['accept', 'card-nonext']);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /sidecar write failed \(no-next-heading\)/);
  assert.equal((await readCard(root, 'card-nosc')).frontmatter.status, 'new');
  assert.equal((await readCard(root, 'card-nonext')).frontmatter.status, 'new');
});

test('task: a task card carrying any expected_* precondition refuses (task carries none by design)', async () => {
  const root = await makeRoot('task-precond');
  await writeProject(root, 'cockpit', 'proj-d');
  await writeCard(root, 'card-task-pc', {
    on_accept: { kind: 'task', project: 'proj-d', line: 'x' },
    expected_node_hash: 'a'.repeat(64),
  });
  const r = await runAccept(root, ['accept', 'card-task-pc']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /task cards carry no preconditions/);
  assert.equal((await readCard(root, 'card-task-pc')).frontmatter.status, 'new');
});

test('task: a multi-line on_accept.line is refused at validation (roadmap rows are single-line)', async () => {
  const root = await makeRoot('task-newline');
  await writeProject(root, 'cockpit', 'proj-e');
  await writeCard(root, 'card-nl', { on_accept: { kind: 'task', project: 'proj-e', line: 'line one\nline two' } });
  const r = await runAccept(root, ['accept', 'card-nl']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /single-line/);
});

// ================================================================ kind: retire

test('retire: node superseded with the reconciler representation + accept trail, scoped commits, card applied', async () => {
  const root = await makeRoot('retire-happy');
  const nodePath = await writeTargetNode(root, 'node-ret');
  await writeCard(root, 'card-ret', {
    on_accept: { kind: 'retire', node: 'node-ret' },
    expected_node_hash: sha256(await readFile(nodePath)),
    expected_status: 'principle',
  });
  const r = await runAccept(root, ['accept', 'card-ret']);
  assert.equal(r.code, 0, r.stderr);
  const fm = await readNodeFm(root, 'node-ret');
  assert.equal(fm.superseded, true);
  assert.equal(fm.superseded_by, 'accept:card-ret', 'the trail names the accepting card');
  assert.ok(fm.updated, 'updated stamped');
  assert.equal((await readCard(root, 'card-ret')).frontmatter.status, 'applied');
  const { stdout: log } = await execFileP('git', ['-C', root, 'log', '--format=%s', '--name-only']);
  assert.match(log, /accept: card-ret superseded \[\[node-ret\]\]/);
  assert.match(log, /knowledge\/nodes\/node-ret\.md/);
  const head = await gitHead(root);
  assert.doesNotMatch(head, /knowledge\/nodes/, 'the card commit stays scoped to the card');
  await assertClean(root);
});

test('retire: an already-superseded node is a no-op success, node byte-identical', async () => {
  const root = await makeRoot('retire-noop');
  const nodePath = await writeTargetNode(root, 'node-corpse', { superseded: true, superseded_by: 'someone-else' });
  const before = await readFile(nodePath, 'utf8');
  await writeCard(root, 'card-corpse', {
    on_accept: { kind: 'retire', node: 'node-corpse' },
    expected_node_hash: sha256(Buffer.from(before)),
    expected_status: 'superseded',
  });
  const r = await runAccept(root, ['accept', 'card-corpse']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already superseded \(no-op\)/);
  assert.equal(await readFile(nodePath, 'utf8'), before, 'idempotent retire must not rewrite the corpse');
  assert.equal((await readCard(root, 'card-corpse')).frontmatter.status, 'applied');
});

test('retire: missing preconditions refuse before anything executes', async () => {
  const root = await makeRoot('retire-nopc');
  const nodePath = await writeTargetNode(root, 'node-nopc');
  const before = await readFile(nodePath, 'utf8');
  await writeCard(root, 'card-nopc-hash', { on_accept: { kind: 'retire', node: 'node-nopc' }, expected_status: 'principle' });
  await writeCard(root, 'card-nopc-status', { on_accept: { kind: 'retire', node: 'node-nopc' }, expected_node_hash: sha256(Buffer.from(before)) });
  const a = await runAccept(root, ['accept', 'card-nopc-hash']);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /retire requires expected_node_hash/);
  const b = await runAccept(root, ['accept', 'card-nopc-status']);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /retire requires expected_status/);
  assert.equal(await readFile(nodePath, 'utf8'), before, 'nothing executed');
});

// ================================================================ kind: merge

test('merge: src superseded_by target, target file untouched byte-identical, scoped commits', async () => {
  const root = await makeRoot('merge-happy');
  const srcPath = await writeTargetNode(root, 'node-src');
  const tgtPath = await writeTargetNode(root, 'node-tgt');
  const tgtBefore = await readFile(tgtPath, 'utf8');
  await writeCard(root, 'card-merge', {
    on_accept: { kind: 'merge', node: 'node-src', into: 'node-tgt' },
    expected_node_hash: sha256(await readFile(srcPath)),
    expected_target_hash: sha256(Buffer.from(tgtBefore)),
  });
  const r = await runAccept(root, ['accept', 'card-merge']);
  assert.equal(r.code, 0, r.stderr);
  const fm = await readNodeFm(root, 'node-src');
  assert.equal(fm.superseded, true);
  assert.equal(fm.superseded_by, 'node-tgt', 'mechanical supersede points at the TARGET node id');
  assert.equal(await readFile(tgtPath, 'utf8'), tgtBefore, 'the target node is never modified');
  assert.deepEqual(await commitFilesOf(root, /^accept: card-merge merged/), ['knowledge/nodes/node-src.md'],
    'the merge boundary commit touches the SRC node alone, never the target');
  assert.equal((await readCard(root, 'card-merge')).frontmatter.status, 'applied');
  await assertClean(root);
});

test('merge: self-merge refused at validation, card untouched', async () => {
  const root = await makeRoot('merge-self');
  const nodePath = await writeTargetNode(root, 'node-self');
  const hash = sha256(await readFile(nodePath));
  await writeCard(root, 'card-self', {
    on_accept: { kind: 'merge', node: 'node-self', into: 'node-self' },
    expected_node_hash: hash, expected_target_hash: hash,
  });
  const r = await runAccept(root, ['accept', 'card-self']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot fold a node into itself/);
  assert.equal((await readCard(root, 'card-self')).frontmatter.status, 'new');
  assert.equal((await readNodeFm(root, 'node-self')).superseded, undefined);
});

test('merge: missing expected_target_hash refuses (both hashes are REQUIRED for merge)', async () => {
  const root = await makeRoot('merge-nopc');
  const srcPath = await writeTargetNode(root, 'node-m-src');
  await writeTargetNode(root, 'node-m-tgt');
  await writeCard(root, 'card-m-nopc', {
    on_accept: { kind: 'merge', node: 'node-m-src', into: 'node-m-tgt' },
    expected_node_hash: sha256(await readFile(srcPath)),
  });
  const r = await runAccept(root, ['accept', 'card-m-nopc']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /merge requires expected_target_hash/);
  assert.equal((await readNodeFm(root, 'node-m-src')).superseded, undefined);
});

test('merge: stale expected_target_hash → refuse + re-mint with lineage and BOTH fresh hashes', async () => {
  const root = await makeRoot('merge-stale');
  const srcPath = await writeTargetNode(root, 'node-st-src');
  const tgtPath = await writeTargetNode(root, 'node-st-tgt');
  await writeCard(root, 'card-st-merge', {
    on_accept: { kind: 'merge', node: 'node-st-src', into: 'node-st-tgt' },
    expected_node_hash: sha256(await readFile(srcPath)),
    expected_target_hash: 'f'.repeat(64),   // the target moved since mint
  });
  const r = await runAccept(root, ['accept', 'card-st-merge']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /preconditions stale \(target hash moved\)/);
  const newId = remintedId(r.stderr);
  assert.ok(newId, `refusal must name the replacement (stderr: ${r.stderr})`);
  const fresh = await readCard(root, newId);
  assert.equal(fresh.frontmatter.status, 'new');
  assert.equal(fresh.frontmatter.reminted_from, 'card-st-merge', 'the replacement carries lineage');
  assert.deepEqual(fresh.frontmatter.on_accept, { kind: 'merge', node: 'node-st-src', into: 'node-st-tgt' });
  assert.equal(fresh.frontmatter.expected_node_hash, sha256(await readFile(srcPath)));
  assert.equal(fresh.frontmatter.expected_target_hash, sha256(await readFile(tgtPath)), 're-mint must carry the FRESH target hash');
  const old = await readCard(root, 'card-st-merge');
  assert.equal(old.frontmatter.status, 'dismissed');
  assert.equal(old.frontmatter.superseded_by, newId);
  assert.equal((await readNodeFm(root, 'node-st-src')).superseded, undefined, 'nothing executed against stale expectations');
});

test('merge crash window: execute committed, flip lost → stale re-mint, then the re-minted accept is a no-op', async () => {
  const root = await makeRoot('merge-crash');
  const srcPath = await writeTargetNode(root, 'node-cw-src');
  const tgtPath = await writeTargetNode(root, 'node-cw-tgt');
  const preHash = sha256(await readFile(srcPath));
  const tgtBefore = await readFile(tgtPath, 'utf8');
  await writeCard(root, 'card-cw-merge', {
    on_accept: { kind: 'merge', node: 'node-cw-src', into: 'node-cw-tgt' },
    expected_node_hash: preHash,
    expected_target_hash: sha256(Buffer.from(tgtBefore)),
  });
  // simulate the crash: the prior run's execute boundary landed (src superseded + committed),
  // the flip did not. The src file no longer matches the card's mint-time hash BY DESIGN, so the
  // documented recovery is refuse + re-mint, and the re-minted card's execute is the no-op.
  await writeTargetNode(root, 'node-cw-src', { superseded: true, superseded_by: 'node-cw-tgt', updated: '2026-07-26T00:00:00.000Z' });
  const srcAfterCrash = await readFile(srcPath, 'utf8');

  const first = await runAccept(root, ['accept', 'card-cw-merge']);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /preconditions stale/);
  const newId = remintedId(first.stderr);
  assert.ok(newId);
  const second = await runAccept(root, ['accept', newId]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already merged into \[\[node-cw-tgt\]\] \(no-op\)/);
  assert.equal(await readFile(srcPath, 'utf8'), srcAfterCrash, 'the no-op retry must not rewrite the src');
  assert.equal(await readFile(tgtPath, 'utf8'), tgtBefore, 'target still untouched');
  assert.equal((await readCard(root, newId)).frontmatter.status, 'applied');
  await assertClean(root);
});

// ================================================================ kind: doc-edit

test('doc-edit: draft written verbatim (fence unwrapped) to the target, proposal flipped applied, one boundary commit', async () => {
  const root = await makeRoot('docedit-happy');
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const target = resolve(root, 'docs', 'NOTES.md');
  await writeFile(target, 'Old body.\n', 'utf8');
  await writeDocProposal(root, 'dp-happy', { target: 'docs/NOTES.md', draft: 'New doc body.\nSecond line.' });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed docs']);
  await writeCard(root, 'card-de', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-happy' },
    expected_target_hash: sha256(await readFile(target)),
  });
  const r = await runAccept(root, ['accept', 'card-de']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await readFile(target, 'utf8'), 'New doc body.\nSecond line.\n', 'the draft lands verbatim, store fence unwrapped, newline-terminated');
  const prop = parseNode(await readFile(resolve(root, 'doc-proposals', 'dp-happy.md'), 'utf8'), 'dp-happy').frontmatter;
  assert.equal(prop.status, 'applied');
  assert.ok(prop.resolved, 'resolved stamped on the proposal');
  assert.deepEqual(await commitFilesOf(root, /^accept: card-de applied doc-proposal dp-happy to docs\/NOTES\.md$/),
    ['doc-proposals/dp-happy.md', 'docs/NOTES.md'], 'ONE scoped commit covers target + proposal as a boundary');
  assert.equal((await readCard(root, 'card-de')).frontmatter.status, 'applied');
  await assertClean(root);
});

test('doc-edit: stale expected_target_hash → refuse + re-mint carrying the FRESH target hash and lineage', async () => {
  const root = await makeRoot('docedit-stale');
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const target = resolve(root, 'docs', 'MOVED.md');
  await writeFile(target, 'Current bytes the mint never saw.\n', 'utf8');
  await writeDocProposal(root, 'dp-stale', { target: 'docs/MOVED.md' });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed docs']);
  await writeCard(root, 'card-de-stale', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-stale' },
    expected_target_hash: 'f'.repeat(64),
  });
  const r = await runAccept(root, ['accept', 'card-de-stale']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /preconditions stale \(target hash moved\)/);
  const newId = remintedId(r.stderr);
  assert.ok(newId);
  const fresh = await readCard(root, newId);
  assert.equal(fresh.frontmatter.reminted_from, 'card-de-stale');
  assert.equal(fresh.frontmatter.expected_target_hash, sha256(await readFile(target)));
  assert.deepEqual(fresh.frontmatter.on_accept, { kind: 'doc-edit', proposal: 'dp-stale' });
  assert.equal(await readFile(target, 'utf8'), 'Current bytes the mint never saw.\n', 'target never written');
  assert.equal(parseNode(await readFile(resolve(root, 'doc-proposals', 'dp-stale.md'), 'utf8'), 'dp-stale').frontmatter.status, 'new', 'proposal untouched');
});

test('doc-edit: a target that realpaths outside MEMORY_ROOT via a symlink is refused', async () => {
  const root = await makeRoot('docedit-symlink');
  // the escape target lives OUTSIDE the scenario root (still inside the preload temp root)
  const outside = resolve(TEST_MEMORY_ROOT, 'onaccept-roots', 'outside-secret.md');
  await writeFile(outside, 'Must never be reachable.\n', 'utf8');
  await symlink(outside, resolve(root, 'escape.md'));
  await writeDocProposal(root, 'dp-link', { target: 'escape.md' });
  await writeCard(root, 'card-de-link', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-link' },
    expected_target_hash: sha256(await readFile(outside)),
  });
  const r = await runAccept(root, ['accept', 'card-de-link']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /outside the memory root/);
  assert.equal(await readFile(outside, 'utf8'), 'Must never be reachable.\n', 'the outside file is untouched');
  assert.equal((await readCard(root, 'card-de-link')).frontmatter.status, 'new');
});

test('doc-edit: a ..-path target is refused by containment, not applied', async () => {
  const root = await makeRoot('docedit-dotdot');
  const outside = resolve(TEST_MEMORY_ROOT, 'onaccept-roots', 'dotdot-victim.md');
  await writeFile(outside, 'Sibling of the scenario root.\n', 'utf8');
  // ../dotdot-victim.md resolves to the sibling file OUTSIDE this scenario's memory root
  await writeDocProposal(root, 'dp-dots', { target: '../dotdot-victim.md' });
  await writeCard(root, 'card-de-dots', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-dots' },
    expected_target_hash: sha256(await readFile(outside)),
  });
  const r = await runAccept(root, ['accept', 'card-de-dots']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /outside the memory root/);
  assert.equal(await readFile(outside, 'utf8'), 'Sibling of the scenario root.\n');
});

test('doc-edit: an already-applied proposal is a no-op success even with a now-stale card hash', async () => {
  const root = await makeRoot('docedit-applied');
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const target = resolve(root, 'docs', 'DONE.md');
  await writeFile(target, 'Already the applied draft.\n', 'utf8');
  await writeDocProposal(root, 'dp-done', { target: 'docs/DONE.md', status: 'applied' });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'accept: prior run applied dp-done']);
  // the card's mint-time hash is stale precisely BECAUSE the edit applied — the crash window
  // between execute-commit and flip must land on the no-op path, never on a re-mint.
  await writeCard(root, 'card-de-done', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-done' },
    expected_target_hash: 'f'.repeat(64),
  });
  const targetBefore = await readFile(target, 'utf8');
  const r = await runAccept(root, ['accept', 'card-de-done']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already applied \(no-op\)/);
  assert.equal(await readFile(target, 'utf8'), targetBefore, 'no second write');
  assert.equal((await readCard(root, 'card-de-done')).frontmatter.status, 'applied');
  const files = await readdir(resolve(root, 'insights'));
  assert.deepEqual(files, ['card-de-done.md'], 'no re-mint on the crash-retry path');
  await assertClean(root);
});

// ================================================================ kind: unratify

test('unratify: ratified block moves to the ratified_retired trail with a retired stamp, key deleted, card applied', async () => {
  const root = await makeRoot('unratify-happy');
  const RAT = { at: '2026-07-20T00:00:00.000Z', via: 'in-session', turn: 'sess-1:4' };
  const nodePath = await writeTargetNode(root, 'node-unrat', { ratified: RAT });
  await writeCard(root, 'card-unrat', {
    on_accept: { kind: 'unratify', node: 'node-unrat' },
    expected_node_hash: sha256(await readFile(nodePath)),
    expected_status: 'ratified',
  });
  const r = await runAccept(root, ['accept', 'card-unrat']);
  assert.equal(r.code, 0, r.stderr);
  const fm = await readNodeFm(root, 'node-unrat');
  assert.ok(!Object.prototype.hasOwnProperty.call(fm, 'ratified'), 'the ratified key is removed (projection stops treating it as ratified)');
  assert.equal(fm.ratified_retired.length, 1, 'the block is RETIRED into the trail, never deleted (MEM-37)');
  assert.equal(fm.ratified_retired[0].via, RAT.via);
  assert.equal(fm.ratified_retired[0].turn, RAT.turn);
  assert.equal(fm.ratified_retired[0].at, RAT.at, 'the original block survives intact inside the trail');
  assert.equal(fm.ratified_retired[0].retired.via, 'dashboard');
  assert.equal(fm.ratified_retired[0].retired.turn, 'dashboard:card-unrat', 'the retired stamp names the accepting turn');
  assert.ok(fm.updated);
  assert.equal((await readCard(root, 'card-unrat')).frontmatter.status, 'applied');
  const { stdout: log } = await execFileP('git', ['-C', root, 'log', '--format=%s']);
  assert.match(log, /accept: card-unrat unratified \[\[node-unrat\]\]/);
  await assertClean(root);
});

test('unratify: expected_status ratified is enforced — an unratified node is a stale refusal, node untouched', async () => {
  const root = await makeRoot('unratify-status');
  const nodePath = await writeTargetNode(root, 'node-notrat');
  const before = await readFile(nodePath, 'utf8');
  await writeCard(root, 'card-notrat', {
    on_accept: { kind: 'unratify', node: 'node-notrat' },
    expected_node_hash: sha256(Buffer.from(before)),
    expected_status: 'ratified',
  });
  const r = await runAccept(root, ['accept', 'card-notrat']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /status is principle, expected ratified/);
  assert.equal(await readFile(nodePath, 'utf8'), before, 'nothing executed against the wrong status');
  assert.equal((await readCard(root, 'card-notrat')).frontmatter.status, 'dismissed', 'stale card dismissed toward the re-mint');
});

test('unratify crash window: execute committed, flip lost → re-mint, and the re-minted accept is an idempotent no-op', async () => {
  const root = await makeRoot('unratify-crash');
  const RAT = { at: '2026-07-20T00:00:00.000Z', via: 'dashboard', turn: 'sess-2:1' };
  // post-crash state: the prior run already retired the block and committed the node
  const nodePath = await writeTargetNode(root, 'node-unrat-cw', {
    ratified_retired: [{ ...RAT, retired: { at: '2026-07-26T00:00:00.000Z', via: 'dashboard', turn: 'dashboard:card-unrat-cw' } }],
  });
  const afterCrash = await readFile(nodePath, 'utf8');
  await writeCard(root, 'card-unrat-cw', {
    on_accept: { kind: 'unratify', node: 'node-unrat-cw' },
    expected_node_hash: 'f'.repeat(64),   // mint-time hash of the still-ratified node
    expected_status: 'ratified',
  });
  const first = await runAccept(root, ['accept', 'card-unrat-cw']);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /preconditions stale/);
  const newId = remintedId(first.stderr);
  assert.ok(newId);
  const fresh = await readCard(root, newId);
  assert.equal(fresh.frontmatter.expected_status, 'principle', 're-mint carries the LIVE post-unratify status');
  const second = await runAccept(root, ['accept', newId]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already unratified \(no-op\)/);
  const fm = await readNodeFm(root, 'node-unrat-cw');
  assert.equal(fm.ratified_retired.length, 1, 'the idempotent retry must not grow the trail');
  assert.equal(await readFile(nodePath, 'utf8'), afterCrash, 'no-op retry leaves the node byte-identical');
  await assertClean(root);
});

test('unratify: missing preconditions refuse (both are REQUIRED)', async () => {
  const root = await makeRoot('unratify-nopc');
  await writeTargetNode(root, 'node-unrat-nopc', { ratified: { at: 'x', via: 'dashboard', turn: 'a:1' } });
  await writeCard(root, 'card-unrat-nopc', { on_accept: { kind: 'unratify', node: 'node-unrat-nopc' } });
  const r = await runAccept(root, ['accept', 'card-unrat-nopc']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unratify requires expected_node_hash/);
  const fm = await readNodeFm(root, 'node-unrat-nopc');
  assert.ok(fm.ratified, 'the node is still ratified');
});

// ================================================================ re-mint adoption, kind-agnostic deep-equality

test('re-mint adoption: lineage + matching expectations but a DIFFERENT on_accept kind is never adopted', async () => {
  const root = await makeRoot('adopt-kind');
  const srcPath = await writeTargetNode(root, 'node-ad-src');
  const tgtPath = await writeTargetNode(root, 'node-ad-tgt');
  const liveSrc = sha256(await readFile(srcPath));
  const liveTgt = sha256(await readFile(tgtPath));
  await writeCard(root, 'card-ad-old', {
    on_accept: { kind: 'merge', node: 'node-ad-src', into: 'node-ad-tgt' },
    expected_node_hash: 'f'.repeat(64),
    expected_target_hash: liveTgt,
  });
  // decoy: correct lineage, correct live expectations, but a retire action — adopting it would
  // wire a supersession onto a card that does something ELSE than the old card promised
  await writeCard(root, 'decoy-kind', {
    on_accept: { kind: 'retire', node: 'node-ad-src' },
    expected_node_hash: liveSrc, expected_target_hash: liveTgt,
    reminted_from: 'card-ad-old',
  });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed decoy']);
  const decoyBefore = await cardBytes(root, 'decoy-kind');
  const r = await runAccept(root, ['accept', 'card-ad-old']);
  assert.equal(r.code, 1);
  const newId = remintedId(r.stderr);
  assert.ok(newId && newId !== 'decoy-kind', 'a different-kind decoy must NOT be adopted');
  assert.deepEqual((await readCard(root, newId)).frontmatter.on_accept, { kind: 'merge', node: 'node-ad-src', into: 'node-ad-tgt' });
  assert.equal((await readCard(root, 'card-ad-old')).frontmatter.superseded_by, newId);
  assert.equal(await cardBytes(root, 'decoy-kind'), decoyBefore, 'the decoy is untouched');
});

test('re-mint adoption: same kind but a different merge target is never adopted; the exact twin IS', async () => {
  const root = await makeRoot('adopt-target');
  const srcPath = await writeTargetNode(root, 'node-at-src');
  const tgtPath = await writeTargetNode(root, 'node-at-tgt');
  await writeTargetNode(root, 'node-at-other');
  const liveSrc = sha256(await readFile(srcPath));
  const liveTgt = sha256(await readFile(tgtPath));
  await writeCard(root, 'card-at-old', {
    on_accept: { kind: 'merge', node: 'node-at-src', into: 'node-at-tgt' },
    expected_node_hash: 'f'.repeat(64),
    expected_target_hash: liveTgt,
  });
  // wrong-target decoy sorts BEFORE the true twin (readdir scan is id-sorted), so if deep-equality
  // did not gate adoption this one would win
  await writeCard(root, 'a-decoy-target', {
    on_accept: { kind: 'merge', node: 'node-at-src', into: 'node-at-other' },
    expected_node_hash: liveSrc, expected_target_hash: liveTgt,
    reminted_from: 'card-at-old',
  });
  await writeCard(root, 'b-true-twin', {
    on_accept: { kind: 'merge', node: 'node-at-src', into: 'node-at-tgt' },
    expected_node_hash: liveSrc, expected_target_hash: liveTgt,
    reminted_from: 'card-at-old',
  });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed twins']);
  const r = await runAccept(root, ['accept', 'card-at-old']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /re-minted as b-true-twin/, 'adoption generalizes beyond ratify: the deep-equal twin is reused, the wrong-target decoy is not');
  const files = (await readdir(resolve(root, 'insights'))).sort();
  assert.deepEqual(files, ['a-decoy-target.md', 'b-true-twin.md', 'card-at-old.md'], 'no fresh card minted when the true twin exists');
  assert.equal((await readCard(root, 'card-at-old')).frontmatter.superseded_by, 'b-true-twin');
  assert.equal((await readCard(root, 'a-decoy-target')).frontmatter.status, 'new', 'decoy untouched');
});

// ================================================================ fix round 1 (Codex): dirty
// write-set guard (4a'), applied-heal branch, .git target exclusion, override precedence

test('dirty write set: an uncommitted sidecar refuses machine-readably before any write, card untouched', async () => {
  const root = await makeRoot('dirty-sidecar');
  const sidecar = await writeProject(root, 'cockpit', 'proj-dw');
  // someone else's uncommitted edit at the exact path the action would write
  await writeFile(sidecar, '# Roadmap\n\n## Now\n\n## Next\n- [ ] hand-edited, uncommitted\n\n## Done\n', 'utf8');
  const dirtyBytes = await readFile(sidecar, 'utf8');
  await writeCard(root, 'card-dw', { on_accept: { kind: 'task', project: 'proj-dw', line: 'x' } });
  const r = await runAccept(root, ['accept', 'card-dw']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uncommitted changes at scopes\/cockpit\/projects\/proj-dw\.roadmap\.md/,
    'the refusal names the dirty path (machine-readable, like the other refusal shapes)');
  assert.equal(await readFile(sidecar, 'utf8'), dirtyBytes, 'the foreign edit is neither absorbed nor overwritten');
  assert.equal((await readCard(root, 'card-dw')).frontmatter.status, 'new');
});

test('dirty write set: doc-edit with an uncommitted target and a NOT-applied proposal refuses', async () => {
  const root = await makeRoot('dirty-target');
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const target = resolve(root, 'docs', 'DIRTY.md');
  await writeFile(target, 'Committed body.\n', 'utf8');
  await writeDocProposal(root, 'dp-dirty', { target: 'docs/DIRTY.md' });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed']);
  await writeFile(target, 'Someone else edited this and never committed.\n', 'utf8');
  // the card's hash matches the LIVE dirty bytes, so only the dirty guard can be what refuses
  await writeCard(root, 'card-de-dirty', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-dirty' },
    expected_target_hash: sha256(await readFile(target)),
  });
  const r = await runAccept(root, ['accept', 'card-de-dirty']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uncommitted changes at docs\/DIRTY\.md/);
  assert.equal(await readFile(target, 'utf8'), 'Someone else edited this and never committed.\n');
  assert.equal((await readCard(root, 'card-de-dirty')).frontmatter.status, 'new');
});

// round 3 crash model: a crashed executor's proposal ALWAYS has a status-new baseline at HEAD
// (committed at mint); the heal verifies the disk delta against that baseline, so the seeds
// commit the new proposal + pristine target first, then rewrite the disk copies as the crash left
// them (target = applied draft, proposal = applied + resolved through the store writer).
async function seedCrashBaseline(root, id, { targetRel, targetBefore = 'Old body.\n', draft = 'New doc body.\n' } = {}) {
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const target = resolve(root, targetRel);
  await writeFile(target, targetBefore, 'utf8');
  const propPath = await writeDocProposal(root, id, { target: targetRel, draft });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', `mint ${id}`]);
  return { target, propPath };
}

test('applied-heal: both dirty but EXACT executor residue → heal commit fires, card flips, tree clean', async () => {
  const root = await makeRoot('applied-heal');
  const { target } = await seedCrashBaseline(root, 'dp-heal', { targetRel: 'docs/HEAL.md' });
  // the crash residue: target rewritten to the draft, disk proposal flipped applied + resolved
  await writeFile(target, 'New doc body.\n', 'utf8');
  await writeDocProposal(root, 'dp-heal', { target: 'docs/HEAL.md', status: 'applied', resolved: '2026-07-26T00:00:00.000Z' });
  await writeCard(root, 'card-heal', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-heal' },
    expected_target_hash: 'f'.repeat(64),   // stale by definition; the applied path must ignore it
  });
  const r = await runAccept(root, ['accept', 'card-heal']);
  assert.equal(r.code, 0, r.stderr);
  const { stdout: log } = await execFileP('git', ['-C', root, 'log', '--format=%s']);
  assert.match(log, /accept: card-heal doc-proposal dp-heal \(commit heal after crash\)/, 'the heal commit fired');
  assert.deepEqual(await commitFilesOf(root, /commit heal after crash/),
    ['doc-proposals/dp-heal.md', 'docs/HEAL.md'], 'the heal commit is scoped to the write set');
  assert.equal((await readCard(root, 'card-heal')).frontmatter.status, 'applied');
  assert.match(r.stdout, /already applied \(no-op\)/);
  await assertClean(root, ['insights/', 'docs/', 'doc-proposals/']);
});

test('doc-edit: a target inside .git is refused, directly and via symlink', async () => {
  const root = await makeRoot('docedit-git');
  await writeDocProposal(root, 'dp-git', { target: '.git/config' });
  await writeCard(root, 'card-de-git', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-git' },
    expected_target_hash: sha256(await readFile(resolve(root, '.git', 'config'))),
  });
  const direct = await runAccept(root, ['accept', 'card-de-git']);
  assert.equal(direct.code, 1);
  assert.match(direct.stderr, /repo metadata dir/);
  // symlink inside the root pointing INTO .git: passes root containment, must still refuse
  await symlink(resolve(root, '.git', 'config'), resolve(root, 'sneaky.md'));
  await writeDocProposal(root, 'dp-git-link', { target: 'sneaky.md' });
  await writeCard(root, 'card-de-git-link', {
    on_accept: { kind: 'doc-edit', proposal: 'dp-git-link' },
    expected_target_hash: sha256(await readFile(resolve(root, '.git', 'config'))),
  });
  const linked = await runAccept(root, ['accept', 'card-de-git-link']);
  assert.equal(linked.code, 1);
  assert.match(linked.stderr, /repo metadata dir/);
  const { stdout: cfg } = await execFileP('git', ['-C', root, 'config', 'user.name']);
  assert.equal(cfg.trim(), 'Test', 'the repo config survived both attempts');
});

// ================================================================ fix round 2 (Codex):
// provenance-sensitive healing (own crash residue heals, foreign dirt refuses)

test('task own residue: sidecar dirty with EXACTLY this card marker row → accept proceeds, dedups, heals', async () => {
  const root = await makeRoot('task-own-residue');
  const sidecar = await writeProject(root, 'cockpit', 'proj-own');
  // the executor's exact crash residue: writeSidecarTask landed (one added row, this card's own
  // marker), the scoped commit did not
  await writeFile(sidecar, '# Roadmap\n\n## Now\n\n## Next\n- [ ] Do it  <!-- inbox:card-own -->\n\n## Done\n', 'utf8');
  await writeCard(root, 'card-own', { on_accept: { kind: 'task', project: 'proj-own', line: 'Do it' } });
  const r = await runAccept(root, ['accept', 'card-own']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already present/, 'the marker dedupe absorbs the residue instead of duplicating the row');
  const text = await readFile(sidecar, 'utf8');
  assert.equal(text.match(/inbox:card-own/g).length, 1, 'exactly one marker row after the heal');
  assert.equal((await readCard(root, 'card-own')).frontmatter.status, 'applied');
  assert.deepEqual(await commitFilesOf(root, /^accept: card-own task to proj-own roadmap$/),
    ['scopes/cockpit/projects/proj-own.roadmap.md'], 'the scoped commit healed the residue');
  await assertClean(root, ['insights/', 'scopes/cockpit/projects/proj-own.roadmap.md']);
});

test('task foreign dirt: marker row PLUS an unrelated edit → refusal, both changes preserved', async () => {
  const root = await makeRoot('task-foreign-dirt');
  const sidecar = await writeProject(root, 'cockpit', 'proj-foreign');
  // own marker row AND a foreign edit in the same uncommitted sidecar: provenance is not provable
  // as ours alone, so nothing may be absorbed
  const dirtied = '# Roadmap\n\n## Now\n- [ ] someone else touched this\n\n## Next\n- [ ] Do it  <!-- inbox:card-foreign -->\n\n## Done\n';
  await writeFile(sidecar, dirtied, 'utf8');
  await writeCard(root, 'card-foreign', { on_accept: { kind: 'task', project: 'proj-foreign', line: 'Do it' } });
  const r = await runAccept(root, ['accept', 'card-foreign']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uncommitted changes at scopes\/cockpit\/projects\/proj-foreign\.roadmap\.md/);
  assert.equal(await readFile(sidecar, 'utf8'), dirtied, 'both the marker row and the foreign edit are preserved');
  assert.equal((await readCard(root, 'card-foreign')).frontmatter.status, 'new');
});

test('applied-heal foreign target: target bytes differ from the applied draft → refusal naming the target', async () => {
  const root = await makeRoot('heal-foreign-target');
  const { target } = await seedCrashBaseline(root, 'dp-ft', { targetRel: 'docs/FT.md' });
  // the proposal transition is the executor's own, but the target carries a FOREIGN edit
  await writeFile(target, 'Not the draft at all.\n', 'utf8');
  await writeDocProposal(root, 'dp-ft', { target: 'docs/FT.md', status: 'applied', resolved: '2026-07-26T00:00:00.000Z' });
  await writeCard(root, 'card-ft', { on_accept: { kind: 'doc-edit', proposal: 'dp-ft' }, expected_target_hash: 'f'.repeat(64) });
  const r = await runAccept(root, ['accept', 'card-ft']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /foreign changes at docs\/FT\.md/, 'the refusal names the target path');
  assert.equal(await readFile(target, 'utf8'), 'Not the draft at all.\n', 'the foreign edit is preserved, never committed over');
  assert.equal((await readCard(root, 'card-ft')).frontmatter.status, 'new');
});

test('applied-heal foreign proposal: proposal bytes differ from the store serialization → refusal naming the proposal', async () => {
  const root = await makeRoot('heal-foreign-proposal');
  const { target, propPath } = await seedCrashBaseline(root, 'dp-fp', { targetRel: 'docs/FP.md' });
  await writeFile(target, 'New doc body.\n', 'utf8');   // target IS the draft: only the proposal is foreign
  await writeDocProposal(root, 'dp-fp', { target: 'docs/FP.md', status: 'applied', resolved: '2026-07-26T00:00:00.000Z' });
  // a hand edit on top of the applied transition: an extra frontmatter field the HEAD baseline
  // never had (the field-by-field baseline comparison must catch ANY delta beyond the transition)
  const foreign = (await readFile(propPath, 'utf8')).replace('status: applied', 'status: applied\nnote: hand edit');
  await writeFile(propPath, foreign, 'utf8');
  await writeCard(root, 'card-fp', { on_accept: { kind: 'doc-edit', proposal: 'dp-fp' }, expected_target_hash: 'f'.repeat(64) });
  const r = await runAccept(root, ['accept', 'card-fp']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /foreign changes at doc-proposals\/dp-fp\.md/, 'the refusal names the proposal path');
  assert.equal(await readFile(propPath, 'utf8'), foreign, 'the foreign proposal bytes are preserved');
  assert.equal((await readCard(root, 'card-fp')).frontmatter.status, 'new');
});

test('applied-heal retarget regression: serializer-valid disk retarget to a byte-matching file → refusal, A/B/proposal preserved', async () => {
  const root = await makeRoot('heal-retarget');
  // baseline at HEAD: status-new proposal targeting A; B is committed with bytes ALREADY equal
  // to the draft, the perfect decoy for any check that trusts the DISK copy's target
  const { target: targetA, propPath } = await seedCrashBaseline(root, 'dp-rt', { targetRel: 'docs/A.md' });
  const targetB = resolve(root, 'docs', 'B.md');
  await writeFile(targetB, 'New doc body.\n', 'utf8');
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed B']);
  // the crash residue on A, then a serializer-valid FOREIGN edit retargeting the proposal to B
  await writeFile(targetA, 'New doc body.\n', 'utf8');
  await writeDocProposal(root, 'dp-rt', { target: 'docs/B.md', status: 'applied', resolved: '2026-07-26T00:00:00.000Z' });
  const diskProposal = await readFile(propPath, 'utf8');
  await writeCard(root, 'card-rt', { on_accept: { kind: 'doc-edit', proposal: 'dp-rt' }, expected_target_hash: 'f'.repeat(64) });
  const r = await runAccept(root, ['accept', 'card-rt']);
  assert.equal(r.code, 1, 'the target field delta vs the HEAD baseline must refuse, never heal against the decoy');
  assert.match(r.stderr, /foreign changes at doc-proposals\/dp-rt\.md/);
  assert.equal(await readFile(targetA, 'utf8'), 'New doc body.\n', 'A preserved as the crash left it');
  assert.equal(await readFile(targetB, 'utf8'), 'New doc body.\n', 'B untouched');
  assert.equal(await readFile(propPath, 'utf8'), diskProposal, 'the retargeted proposal bytes are preserved, never committed');
  assert.equal((await readCard(root, 'card-rt')).frontmatter.status, 'new');
});

test('applied-heal: an applied proposal with NO committed baseline at HEAD refuses naming the proposal', async () => {
  const root = await makeRoot('heal-no-baseline');
  await writeTargetNode(root, 'node-nb-seed');   // a HEAD must exist, just not one containing the proposal
  await mkdir(resolve(root, 'docs'), { recursive: true });
  await writeFile(resolve(root, 'docs', 'NB.md'), 'New doc body.\n', 'utf8');
  await writeDocProposal(root, 'dp-nb', { target: 'docs/NB.md', status: 'applied', resolved: '2026-07-26T00:00:00.000Z' });
  await writeCard(root, 'card-nb', { on_accept: { kind: 'doc-edit', proposal: 'dp-nb' }, expected_target_hash: 'f'.repeat(64) });
  const r = await runAccept(root, ['accept', 'card-nb']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no committed baseline for doc-proposals\/dp-nb\.md at HEAD/);
  assert.equal((await readCard(root, 'card-nb')).frontmatter.status, 'new');
});

test('applied-heal: dirty write set over a proposal ALREADY applied at HEAD is foreign dirt, refused', async () => {
  const root = await makeRoot('heal-applied-at-head');
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const target = resolve(root, 'docs', 'AH.md');
  await writeFile(target, 'New doc body.\n', 'utf8');
  // baseline applied WITHOUT a resolved stamp, disk copy applied WITH one: every per-field check
  // would wave this through, only the applied-at-HEAD gate can name it foreign
  await writeDocProposal(root, 'dp-ah', { target: 'docs/AH.md', status: 'applied' });
  await execFileP('git', ['-C', root, 'add', '-A']);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', 'seed applied at HEAD']);
  await writeDocProposal(root, 'dp-ah', { target: 'docs/AH.md', status: 'applied', resolved: '2026-07-26T00:00:00.000Z' });
  await writeCard(root, 'card-ah', { on_accept: { kind: 'doc-edit', proposal: 'dp-ah' }, expected_target_hash: 'f'.repeat(64) });
  const r = await runAccept(root, ['accept', 'card-ah']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already applied at HEAD, dirty write set is foreign/);
  assert.equal((await readCard(root, 'card-ah')).frontmatter.status, 'new');
});

test('--project override on a card with a producer-fixed project → override-not-allowed refusal', async () => {
  const root = await makeRoot('override-fixed');
  const sidecarA = await writeProject(root, 'cockpit', 'proj-fixed');
  await writeProject(root, 'cockpit', 'proj-other');
  await writeCard(root, 'card-fixed', { on_accept: { kind: 'task', project: 'proj-fixed', line: 'Stay put' } });
  const r = await runAccept(root, ['accept', 'card-fixed', '--project', 'proj-other']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /override-not-allowed/);
  assert.match(r.stderr, /proj-fixed/, 'the refusal names the project that would have won');
  assert.equal((await readCard(root, 'card-fixed')).frontmatter.status, 'new');
  assert.doesNotMatch(await readFile(sidecarA, 'utf8'), /Stay put/, 'nothing was written anywhere');
  // the override still exists for its ONLY purpose: cards minted with an empty project
  // (covered by the dedicated --project test above; asserted here as the same-root contrast)
  await writeCard(root, 'card-empty', { on_accept: { kind: 'task', project: '', line: 'Routed' } });
  const ok = await runAccept(root, ['accept', 'card-empty', '--project', 'proj-other']);
  assert.equal(ok.code, 0, ok.stderr);
});
