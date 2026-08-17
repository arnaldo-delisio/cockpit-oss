// step7-helpers.test.mjs — MEM-38 step 7 residue: the producer mint helpers, exported after the
// build (zero behavior change) so their deterministic shaping is directly testable offline:
// semantic-insights taskLine/docDebtOnAccept/familyOnAccept, mechanical-insights taskLine plus
// the three extracted pure builders. In-process against the preload temp root (docDebtOnAccept
// resolves targets against MEMORY_ROOT, which the setup preload pins there).
//
// AUTHORED AS THE INDEPENDENT TEST PASS: discrimination-verified per group (cp backup → mutate
// helper → FAIL → byte-identical restore → PASS; table in the pass report).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';
import { taskLine as semTaskLine, docDebtOnAccept, familyOnAccept, findOpenCard } from '../semantic-insights.mjs';
import {
  taskLine as mechTaskLine, recurringFailureOnAccept, correctionOnAccept, underusedSkillOnAccept,
} from '../mechanical-insights.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ================================================================ taskLine (both producers)

test('taskLine: hostile whitespace collapses to one line in both producers', () => {
  const hostile = 'first line\nsecond\tline\r\n   third    line  ';
  for (const [name, fn] of [['semantic', (s) => semTaskLine(s)], ['mechanical', mechTaskLine]]) {
    const out = fn(hostile);
    assert.equal(out, 'first line second line third line', `${name} taskLine must collapse ALL whitespace runs`);
    assert.ok(!out.includes('\n'), `${name}: accept.mjs refuses any newline, so none may survive`);
  }
});

test('taskLine (semantic): claim wins, suggestedFix is the fallback, 200-char truncation', () => {
  assert.equal(semTaskLine('the claim', 'the fix'), 'the claim');
  assert.equal(semTaskLine('', 'the fix'), 'the fix', 'empty claim falls back to the fix');
  assert.equal(semTaskLine(null, null), '', 'nothing to say is an empty string, never a throw');
  const long = 'x'.repeat(400);
  const out = semTaskLine(long);
  // read-pass truncate(s, 200) = 200 chars + a one-char ellipsis marker
  assert.equal(out, `${'x'.repeat(200)}…`, 'truncation keeps the head and marks the cut');
});

// ================================================================ docDebtOnAccept

test('docDebtOnAccept: a node-id target (no slash, no .md) degrades to the task fallback', async () => {
  const r = await docDebtOnAccept('dp-x', 'some-node-id', 'proj-a');
  assert.deepEqual(r, {
    on_accept: { kind: 'task', project: 'proj-a', line: 'Apply doc-proposal dp-x to some-node-id' },
  }, 'a node id is not a path: task fallback carrying the audited project');
});

test('docDebtOnAccept: outside-root, .git-internal, and unreadable targets all degrade to the fallback', async () => {
  // the outside and .git probes are REAL readable files, so the containment/exclusion checks are
  // the only thing standing between them and a doc-edit mint (an unreadable path would degrade
  // via the readFile fallback and mask a dropped check — same lesson as the off-list fold probe)
  await writeFile(resolve(TEST_MEMORY_ROOT, '..', 'step7-outside-probe.md'), 'outside bytes\n', 'utf8');
  await mkdir(resolve(TEST_MEMORY_ROOT, '.git'), { recursive: true });
  await writeFile(resolve(TEST_MEMORY_ROOT, '.git', 'config.md'), 'git-internal bytes\n', 'utf8');
  for (const target of ['../step7-outside-probe.md', '.git/config.md', '.git', 'docs/does-not-exist.md']) {
    const r = await docDebtOnAccept('dp-y', target, '');
    assert.equal(r.on_accept.kind, 'task', `${target} must degrade to a task, never mint doc-edit`);
    assert.equal(r.expected_target_hash, undefined, `${target} must pin no hash`);
    assert.equal(r.on_accept.project, '', 'empty project passes through as empty');
  }
  await rm(resolve(TEST_MEMORY_ROOT, '..', 'step7-outside-probe.md'), { force: true });   // outside the teardown's root
});

test('docDebtOnAccept: a real file inside the root mints doc-edit with the accept-parity hash', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'docs'), { recursive: true });
  const path = resolve(TEST_MEMORY_ROOT, 'docs', 'real-target.md');
  await writeFile(path, 'Real target bytes.\n', 'utf8');
  const r = await docDebtOnAccept('dp-z', 'docs/real-target.md', 'proj-a');
  assert.deepEqual(r.on_accept, { kind: 'doc-edit', proposal: 'dp-z' });
  assert.equal(r.expected_target_hash, sha256(await readFile(path)),
    'hash = sha256 of the file bytes, the same recompute accept.mjs runs fresh');
});

test('docDebtOnAccept: an in-root symlink into .git still mints doc-edit (accept.mjs is the realpath authority)', async () => {
  // documented division of labor, asserted so it never silently changes: the mint-side check is
  // lexical (no realpath cost), so a symlink INSIDE the root whose target RESOLVES into .git
  // passes here; execution-time enforcement is accept.mjs's realpath .git exclusion, covered by
  // accept-onaccept.test.mjs "doc-edit: a target inside .git is refused, directly and via
  // symlink". The link points at the readable .git/config.md fixture the fallback test seeded.
  await mkdir(resolve(TEST_MEMORY_ROOT, '.git'), { recursive: true });
  await writeFile(resolve(TEST_MEMORY_ROOT, '.git', 'config.md'), 'git-internal bytes\n', 'utf8');
  const link = resolve(TEST_MEMORY_ROOT, 'sneaky-git-link.md');
  try { await symlink(resolve(TEST_MEMORY_ROOT, '.git', 'config.md'), link); } catch { /* exists from a prior run */ }
  const r = await docDebtOnAccept('dp-l', 'sneaky-git-link.md', '');
  assert.equal(r.on_accept.kind, 'doc-edit', 'lexical mint check; realpath enforcement lives in accept.mjs');
  assert.equal(r.expected_target_hash, sha256(Buffer.from('git-internal bytes\n')),
    'the hash pins the RESOLVED bytes, proving the read really followed the link into .git');
});

test('docDebtOnAccept: a root FILE merely named with a .git prefix is not the metadata dir, mints doc-edit', async () => {
  // the exclusion is on the `.git` PATH COMPONENT, not on names starting with ".git": a sibling
  // file like .gitignore-notes.md is a legitimate in-root target
  await writeFile(resolve(TEST_MEMORY_ROOT, '.git-decoy.md'), 'decoy\n', 'utf8');
  const r = await docDebtOnAccept('dp-d', '.git-decoy.md', '');
  assert.equal(r.on_accept.kind, 'doc-edit', 'name-prefix must not trip the path-component exclusion');
  assert.equal(r.expected_target_hash, sha256(Buffer.from('decoy\n')));
});

// ================================================================ familyOnAccept

const proj = (id) => ({ frontmatter: { id } });
const LIVE = [proj('proj-live'), proj('proj-other')];

test('familyOnAccept: research-gap and project-scheduling pin the audited project id', () => {
  for (const detector of ['research-gap', 'project-scheduling']) {
    const r = familyOnAccept(detector, { claim: 'do the thing' }, { project: proj('proj-live') }, LIVE);
    assert.deepEqual(r, { kind: 'task', project: 'proj-live', line: 'do the thing' });
  }
});

test('familyOnAccept: source-insight takes the judge-named project iff it is in the live list', () => {
  const c = {};
  const named = familyOnAccept('source-insight', { claim: 'c', project: 'proj-live' }, c, LIVE);
  assert.equal(named.project, 'proj-live');
  const hostile = familyOnAccept('source-insight', { claim: 'c', project: 'proj-i-made-up' }, c, LIVE);
  assert.equal(hostile.project, '', 'a judge-hallucinated project id must not route anywhere');
  const padded = familyOnAccept('source-insight', { claim: 'c', project: '  proj-live  ' }, c, LIVE);
  assert.equal(padded.project, 'proj-live', 'the judge string is trimmed before the membership check');
  const nonString = familyOnAccept('source-insight', { claim: 'c', project: { evil: true } }, c, LIVE);
  assert.equal(nonString.project, '', 'a non-string project reads as none');
  const noList = familyOnAccept('source-insight', { claim: 'c', project: 'proj-live' }, c, undefined);
  assert.equal(noList.project, '', 'no live list means nothing can validate');
});

test('familyOnAccept: unpromoted-breakthrough is always project-empty; doc-debt carries the audited project only when project-shaped', () => {
  assert.deepEqual(familyOnAccept('unpromoted-breakthrough', { claim: 'c' }, {}, LIVE),
    { kind: 'task', project: '', line: 'c' });
  assert.equal(familyOnAccept('doc-debt', { claim: 'c' }, { project: proj('proj-live') }, LIVE).project, 'proj-live');
  assert.equal(familyOnAccept('doc-debt', { claim: 'c' }, {}, LIVE).project, '', 'spine-doc candidates carry no project');
});

test('familyOnAccept: hostile multi-line verdict claims still produce a single-line task line', () => {
  const r = familyOnAccept('unpromoted-breakthrough', { claim: 'line one\nline two\n\tline three' }, {}, LIVE);
  assert.equal(r.line, 'line one line two line three');
});

// ================================================================ the three mechanical builders

test('recurringFailureOnAccept: exact shape, empty project, single line under hostile candidate fields', () => {
  const r = recurringFailureOnAccept({ shape: 'npm\nrun\tflaky', kind: 'bash', scope: 'cockpit' });
  assert.deepEqual(r, {
    kind: 'task', project: '',
    line: 'Investigate recurring failure: npm run flaky (bash) in scope "cockpit"',
  });
});

test('correctionOnAccept: exact shape, empty project, last snippet truncated to 120 and single-line', () => {
  const entry = { scope: 'cockpit', text: `earlier paragraph\n\n${'w'.repeat(200)}\nsecond line` };
  const r = correctionOnAccept(entry);
  assert.equal(r.kind, 'task');
  assert.equal(r.project, '');
  assert.ok(!r.line.includes('\n'), 'the snippet newline is collapsed');
  assert.match(r.line, /^Revisit standing correction in scope "cockpit": w+/);
  // truncate(…, 120) bounds the snippet before the collapse; the prefix adds the rest
  assert.ok(r.line.length <= 'Revisit standing correction in scope "cockpit": '.length + 121,
    `snippet must be truncated (got ${r.line.length} chars)`);
});

test('underusedSkillOnAccept: pinned to skills-work, single line under a hostile name', () => {
  const r = underusedSkillOnAccept({ name: 'weird\nskill' });
  assert.deepEqual(r, {
    kind: 'task', project: 'skills-work',
    line: 'Review underused skill "weird skill": revisit fit or retire',
  });
});

// ================================================================ findOpenCard (open-card gate)

test('findOpenCard: open card with same detector, scope, and project is a hit', () => {
  const open = [{ id: 'card-a', frontmatter: {
    detector: 'project-scheduling', scope: 'cockpit', status: 'new',
    on_accept: { kind: 'task', project: 'memory-engine', line: 'x' },
  } }];
  const hit = findOpenCard(open, 'project-scheduling', 'cockpit', 'memory-engine');
  assert.ok(hit, 'expected a hit');
  assert.equal(hit.id, 'card-a');
});

test('findOpenCard: different detector, scope, or project never matches', () => {
  const fm = (over) => ({ detector: 'doc-debt', scope: 'cockpit', status: 'new',
    on_accept: { kind: 'task', project: 'memory-engine', line: 'x' }, ...over });
  assert.equal(findOpenCard([{ id: 'c', frontmatter: fm({ detector: 'research-gap' }) }], 'doc-debt', 'cockpit', 'memory-engine'), null);
  assert.equal(findOpenCard([{ id: 'c', frontmatter: fm({ scope: 'studio' }) }], 'doc-debt', 'cockpit', 'memory-engine'), null);
  assert.equal(findOpenCard([{ id: 'c', frontmatter: fm({}) }], 'doc-debt', 'cockpit', 'other-project'), null);
});

test('findOpenCard: empty project is its own bucket, never a scope-wide wildcard', () => {
  const projectless = [{ id: 'card-b', frontmatter: {
    detector: 'doc-debt', scope: 'cockpit', status: 'new',
    on_accept: { kind: 'task', project: '', line: 'x' },
  } }];
  assert.equal(findOpenCard(projectless, 'doc-debt', 'cockpit', 'memory-engine'), null,
    'a projectless card must NOT gate a projected candidate');
  assert.ok(findOpenCard(projectless, 'doc-debt', 'cockpit', ''),
    'a projectless card still gates a projectless spine-doc candidate');
});

test('findOpenCard: doc-edit card with fm.project gates only its own project', () => {
  const open = [{ id: 'card-d', frontmatter: {
    detector: 'doc-debt', scope: 'cockpit', status: 'new', project: 'memory-engine',
    on_accept: { kind: 'doc-edit', proposal: 'dp-001' },   // no on_accept.project
  } }];
  assert.ok(findOpenCard(open, 'doc-debt', 'cockpit', 'memory-engine'), 'gates the audited project');
  assert.equal(findOpenCard(open, 'doc-debt', 'cockpit', 'other-project'), null,
    'must not gate a sibling project');
  assert.equal(findOpenCard(open, 'doc-debt', 'cockpit', ''), null,
    'must not gate projectless candidates');
});

test('findOpenCard: historical doc-edit card without fm.project reads as projectless, gates nothing projected', () => {
  const open = [{ id: 'card-e', frontmatter: {
    detector: 'doc-debt', scope: 'cockpit', status: 'new',
    on_accept: { kind: 'doc-edit', proposal: 'dp-002' },   // pre-stamp card: no fm.project either
  } }];
  assert.equal(findOpenCard(open, 'doc-debt', 'cockpit', 'memory-engine'), null,
    'historical projectless card must not suppress any projected candidate');
  assert.ok(findOpenCard(open, 'doc-debt', 'cockpit', ''),
    'it still gates the projectless bucket');
});

test('findOpenCard: a present fm.project (even empty) wins over on_accept.project', () => {
  const open = [{ id: 'card-f', frontmatter: {
    detector: 'doc-debt', scope: 'cockpit', status: 'new', project: '',
    on_accept: { kind: 'task', project: 'memory-engine', line: 'x' },
  } }];
  assert.equal(findOpenCard(open, 'doc-debt', 'cockpit', 'memory-engine'), null,
    'top-level frontmatter is authoritative: on_accept.project must not resurrect a project identity');
  assert.ok(findOpenCard(open, 'doc-debt', 'cockpit', ''),
    'the empty fm.project gates only the projectless bucket');
});
