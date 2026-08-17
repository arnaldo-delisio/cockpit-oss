// doc-debt-upgrade.test.mjs — MEM-38-family doc-debt detector upgrade (spec: roadmap git
// staleness, work-vs-roadmap gap signal, smart roadmap truncation, .md reference discovery,
// judge header lines, spine-list extension, budget/caps unchanged).
//
// AUTHORED AS THE INDEPENDENT TEST PASS, BEFORE the implementation exists — every test here
// is expected to FAIL against today's semantic-insights.mjs and PASS only once the spec
// functions below are added and exported. Do not weaken a test to make it pass early.
//
// API CONTRACT ASSUMED (semantic-insights.mjs does not export these today; this is the surface
// this suite requires the implementer to add — see the accompanying report for the full list):
//   • staleDaysFor(path)                                            — already exists, needs export
//   • gatherDocDebtCandidates(scope, project)                       — already exists, needs export;
//     each project-shaped candidate must additionally carry `roadmapStaleDays` (git-staleness of
//     the ROADMAP file itself, computed the same way as the project file's `staleDays`)
//   • workCommitsSince(projectId, sinceISODate, repoRoot)            — new; repoRoot is an explicit
//     parameter (defaults to the real engine repo in production) precisely so tests never have to
//     commit into the real cockpit repo to exercise the counting logic
//   • truncateRoadmap(text, budget)                                 — new; smart Now/Next/Done cut
//   • discoverReferences({ projectId, projectText, roadmapText, engineRoot, memoryRoot }) — new
//   • newestDateIn(text)                                            — new; max YYYY-MM-DD, else null
//   • docDebtHeaderLines({ roadmapStaleDays, workCommits, newestDate }) — new; pure formatter for
//     the judge-prompt header block
//   • spineDocPaths(scope)                                          — already exists, needs export
//   • cooldownKey(scope, project, detector)                         — already exists, needs export
//   • CANDIDATE_CAP                                                 — already exists, needs export
//
// Ambiguity resolutions (stated up front, not buried in comments):
//   1. "counts engine-repo commits ... whose message matches the project id" is untestable
//      hermetically against the REAL cockpit repo (tests must never mutate it). Resolved by
//      requiring workCommitsSince to take repoRoot as an explicit parameter, defaulting to the
//      real repo only in production call sites. Tests point it at a disposable fixture repo.
//   2. The judge-header field names (roadmapStaleDays / workCommits / newestDate) are this
//      author's choice, not specified verbatim. docDebtHeaderLines is asserted on its rendered
//      TEXT (the three required substrings/wordings), not on an exact object shape, so a
//      differently-named-but-equivalent internal contract still passes as long as the exported
//      formatter accepts these three inputs and renders the specified lines.
//   3. "ordering prefers larger staleness gaps first" is read as: when gatherDocDebtCandidates
//      produces more project candidates than CANDIDATE_CAP, the surviving ones are those with the
//      largest |roadmapStaleDays - staleDays| gap, front-loaded in the returned array.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile, writeFile, mkdir, rm, symlink, realpath,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import { TEST_MEMORY_ROOT, writePool } from './fixtures.mjs';
import { REPO_ROOT } from '../paths.mjs';
import {
  staleDaysFor, gatherDocDebtCandidates, workCommitsSince, truncateRoadmap,
  discoverReferences, newestDateIn, docDebtHeaderLines, spineDocPaths, cooldownKey,
  CANDIDATE_CAP,
} from '../semantic-insights.mjs';

const execFileP = promisify(execFile);

// ---------- git fixture helpers ----------

async function initGitRepo(root) {
  await execFileP('git', ['-C', root, 'init', '--quiet']);
  await execFileP('git', ['-C', root, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', root, 'config', 'user.email', 'test@test.invalid']);
}

// commits `relPath` with a specific author/committer date, so staleDays is exactly computable
// (git log --format=%aI is what staleDaysFor reads).
async function commitAt(root, relPath, dateISO, message = `commit ${relPath}`) {
  await execFileP('git', ['-C', root, 'add', '--', relPath]);
  await execFileP('git', ['-C', root, 'commit', '--quiet', '-m', message], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO,
    },
  });
}

const daysAgoISO = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

async function mkTmpRepo(prefix) {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  await initGitRepo(dir);
  return dir;
}

// ================================================================ 1. roadmap git staleness

test('gatherDocDebtCandidates: roadmap staleness is computed from the ROADMAP file\'s own git history, distinct from the project file\'s', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'sdd1', 'projects'), { recursive: true });
  const projPath = resolve(TEST_MEMORY_ROOT, 'scopes', 'sdd1', 'projects', 'proj-a.md');
  const roadPath = resolve(TEST_MEMORY_ROOT, 'scopes', 'sdd1', 'projects', 'proj-a.roadmap.md');
  await writeFile(projPath, '---\nid: proj-a\nscope: sdd1\nstate: active\n---\nbody\n', 'utf8');
  await writeFile(roadPath, '## Now\n- thing\n## Next\n- other\n## Done\n- done thing\n', 'utf8');

  // project file committed 30 days ago, roadmap committed 3 days ago — the two must diverge.
  await commitAt(TEST_MEMORY_ROOT, 'scopes/sdd1/projects/proj-a.md', daysAgoISO(30));
  await commitAt(TEST_MEMORY_ROOT, 'scopes/sdd1/projects/proj-a.roadmap.md', daysAgoISO(3));

  const candidates = await gatherDocDebtCandidates('sdd1', 'proj-a');
  const c = candidates.find((x) => x.project && x.project.frontmatter.id === 'proj-a');
  assert.ok(c, 'proj-a candidate must be present');
  assert.ok(Number.isFinite(c.staleDays), 'project-file staleDays must still be populated');
  assert.ok(Number.isFinite(c.roadmapStaleDays), 'roadmap-file staleness must be populated separately');
  assert.ok(Math.abs(c.staleDays - 30) < 1.5, `project staleDays should read ~30, got ${c.staleDays}`);
  assert.ok(Math.abs(c.roadmapStaleDays - 3) < 1.5, `roadmap staleDays should read ~3, got ${c.roadmapStaleDays}`);
  assert.notEqual(Math.round(c.staleDays), Math.round(c.roadmapStaleDays),
    'the two staleness numbers must come from two different git-log calls, not one shared value');
});

test('staleDaysFor: falls back to mtime, never throws, when a path is outside any git repo', async () => {
  const dir = await mkTmpRepo('doc-debt-no-git-');
  await rm(resolve(dir, '.git'), { recursive: true, force: true });   // no repo at all
  const file = resolve(dir, 'orphan.md');
  await writeFile(file, 'x', 'utf8');
  const days = await staleDaysFor(file);
  assert.ok(Number.isFinite(days) && days >= 0, 'mtime fallback must return a finite non-negative number');
  await rm(dir, { recursive: true, force: true });
});

// ================================================================ 2. work-vs-roadmap gap signal

test('workCommitsSince: counts fixture-repo commits since the given date whose message matches the project id, case-insensitively', async () => {
  const repo = await mkTmpRepo('doc-debt-workrepo-');
  try {
    await writeFile(resolve(repo, 'f.txt'), '1', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(10), 'unrelated change');
    await writeFile(resolve(repo, 'f.txt'), '2', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(5), 'PROJ-ALPHA: fix the thing');
    await writeFile(resolve(repo, 'f.txt'), '3', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(2), 'touched proj-alpha again');
    await writeFile(resolve(repo, 'f.txt'), '4', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(1), 'totally unrelated');

    const sinceDate = daysAgoISO(20).slice(0, 10);
    const count = await workCommitsSince('proj-alpha', sinceDate, repo);
    assert.equal(count, 2, 'exactly the two case-insensitively matching commits since the date must be counted');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('workCommitsSince: no roadmap date gives null (age-only fallback), never a throw', async () => {
  const repo = await mkTmpRepo('doc-debt-workrepo2-');
  try {
    const result = await workCommitsSince('proj-x', null, repo);
    assert.equal(result, null, 'a null since-date must degrade to null, not throw or count everything');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('workCommitsSince: no match capability (e.g. not a git repo at all) gives null, never a throw', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'doc-debt-notrepo-'));
  try {
    const result = await workCommitsSince('proj-x', daysAgoISO(10).slice(0, 10), dir);
    assert.equal(result, null, 'an unusable repo path must degrade to null, never throw');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ================================================================ 3. smart roadmap truncation

test('truncateRoadmap: Now+Next survive whole, Done is dropped first, when Now+Next alone fit the budget', () => {
  const now = '## Now\n' + '- now item\n'.repeat(5);
  const next = '## Next\n' + '- next item\n'.repeat(5);
  const done = '## Done\n' + '- done item\n'.repeat(400);   // deliberately huge, pushes total over 2000
  const full = `${now}\n${next}\n${done}`;
  assert.ok(full.length > 2000, 'fixture must actually exceed the old blind-cut boundary');

  const out = truncateRoadmap(full, 2000);
  assert.ok(out.includes(now.trim()), 'Now section must survive whole');
  assert.ok(out.includes(next.trim()), 'Next section must survive whole');
  assert.ok(!out.includes('done item'), 'Done content must be dropped first when over budget');
});

test('truncateRoadmap: content deep inside Next, past the OLD 2000-char cutoff, survives — the bug this replaces', () => {
  // Done comes FIRST in the source file this time, so the naive old "slice(0, 2000)" would have
  // cut into Done and never reached Next at all, let alone content deep inside it. This is exactly
  // the case the spec says motivated the rewrite ("the stale lines... sat deep in the file").
  const done = '## Done\n' + '- old done item\n'.repeat(150);   // >2000 chars on its own
  const now = '## Now\n- current work\n';
  const next = '## Next\n' + '- filler\n'.repeat(50) + '- THE-STALE-MARKER-DEEP-IN-NEXT\n';
  const full = `${done}\n${now}\n${next}`;
  assert.ok(done.length > 2000, 'Done alone must already exceed the old boundary');

  const out = truncateRoadmap(full, 2000);
  assert.ok(out.includes('THE-STALE-MARKER-DEEP-IN-NEXT'),
    'a line deep inside Next, past where the blind 2000-char cut would have landed, must survive');
});

test('truncateRoadmap: only cuts Now+Next (from the end) when they alone exceed the budget', () => {
  const now = '## Now\n' + '- now item\n'.repeat(300);   // huge on its own
  const next = '## Next\n' + '- next item\n'.repeat(300);
  const full = `${now}\n${next}`;
  const budget = 500;
  const out = truncateRoadmap(full, budget);
  assert.ok(out.length <= budget + 200, `output must respect the budget (~${budget}), got ${out.length}`);
  assert.ok(out.startsWith('## Now') || out.includes('now item'),
    'when forced to cut Now+Next, the cut comes from the END, so early Now content must still lead');
});

// NOTE (parallel-fix expected): truncateRoadmap currently returns '' when the input has no
// ## headings at all, since its section-splitting logic finds nothing to keep. This test is
// authored against the SPEC (a non-empty budget-sized prefix must always come back), not
// today's behavior, and is expected to FAIL until the implementer fixes the no-headings case.
test('truncateRoadmap: an oversized roadmap with NO ## headings at all still returns a non-empty budget-sized prefix, never empty', () => {
  const full = '- flat item with no heading at all\n'.repeat(200);
  const budget = 500;
  assert.ok(full.length > budget, 'fixture must actually exceed the budget');

  const out = truncateRoadmap(full, budget);
  assert.ok(out.length > 0, 'must never return an empty string for headingless input');
  assert.ok(out.length <= budget + 200, `output must respect the budget (~${budget}), got ${out.length}`);
  assert.ok(full.startsWith(out.slice(0, 50)),
    'the returned text must be an actual prefix of the original content, not fabricated');
});

// ================================================================ 4. reference discovery

test('discoverReferences: finds decisions/, artifacts/research/, and plain relative .md references, resolves against engine+memory roots, dedupes, skips nonexistent, rejects escapes', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-engine-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-memory-'));
  try {
    await mkdir(resolve(engineRoot, 'decisions'), { recursive: true });
    await writeFile(resolve(engineRoot, 'decisions', 'some-topic.md'), 'x', 'utf8');
    await mkdir(resolve(memoryRoot, 'artifacts', 'research'), { recursive: true });
    await writeFile(resolve(memoryRoot, 'artifacts', 'research', 'audit-1.md'), 'x', 'utf8');
    await mkdir(resolve(memoryRoot, 'scopes', 'sdd2', 'projects'), { recursive: true });
    await writeFile(resolve(memoryRoot, 'scopes', 'sdd2', 'projects', 'sibling.md'), 'x', 'utf8');

    const projectText = 'See decisions/some-topic.md for context, also decisions/some-topic.md again (dupe), '
      + 'and decisions/does-not-exist.md (missing, skip silently), and ../../../../etc/passwd.md (escape, reject).';
    const roadmapText = 'Ref: artifacts/research/audit-1.md and scopes/sdd2/projects/sibling.md and ../../outside.md (escape).';

    const refs = await discoverReferences({
      projectId: 'proj-b', projectText, roadmapText, engineRoot, memoryRoot,
    });

    const paths = refs.map((r) => r.path);
    assert.ok(paths.some((p) => p.endsWith('decisions/some-topic.md')), 'decisions/ reference must resolve');
    assert.ok(paths.some((p) => p.endsWith('artifacts/research/audit-1.md')), 'artifacts/research/ reference must resolve');
    assert.ok(paths.some((p) => p.endsWith('sdd2/projects/sibling.md')), 'plain relative .md reference must resolve');
    assert.ok(!paths.some((p) => p.includes('does-not-exist')), 'nonexistent reference must be silently skipped');
    assert.ok(!paths.some((p) => p.includes('passwd') || p.includes('outside.md')),
      'a ../ escape outside both roots must be rejected, not resolved');

    const dupeCount = paths.filter((p) => p.endsWith('decisions/some-topic.md')).length;
    assert.equal(dupeCount, 1, 'the doubly-mentioned reference must be deduplicated');

    for (const r of refs) assert.equal(r.project, 'proj-b', 'every discovered ref must carry the referencing project id');
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

test('discoverReferences: no text, no references, no throw', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-engine2-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-memory2-'));
  try {
    const refs = await discoverReferences({
      projectId: 'proj-c', projectText: '', roadmapText: '', engineRoot, memoryRoot,
    });
    assert.deepEqual(refs, []);
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

// ================================================================ 5. judge input header

test('newestDateIn: returns the max YYYY-MM-DD found in text, or null if none', () => {
  assert.equal(newestDateIn('seen on 2026-01-05 and again 2026-07-20, also 2025-12-31'), '2026-07-20');
  assert.equal(newestDateIn('no dates here at all'), null);
  assert.equal(newestDateIn(''), null);
  assert.equal(newestDateIn('2026-13-40 is not a valid date but 2026-03-02 is'), '2026-03-02');
});

test('docDebtHeaderLines: renders roadmap-unchanged days, work-commit count, and newest-date lines deterministically', () => {
  const out = docDebtHeaderLines({ roadmapStaleDays: 42, workCommits: 3, newestDate: '2026-06-01' });
  assert.match(out, /roadmap unchanged 42 day/i, 'must state the roadmap-unchanged day count');
  assert.match(out, /\b3\b.*work commit/i, 'must state the work-commit count since the roadmap date');
  assert.match(out, /2026-06-01/, 'must include the newest ISO date found in the roadmap text');
});

test('docDebtHeaderLines: age-only fallback wording appears when workCommits is null', () => {
  const out = docDebtHeaderLines({ roadmapStaleDays: 10, workCommits: null, newestDate: null });
  assert.match(out, /roadmap unchanged 10 day/i);
  assert.ok(!/\bnull\b/i.test(out), 'a null commit count must render as fallback wording, never the literal "null"');
  assert.ok(/no |unknown|unavailable|n\/a/i.test(out), 'fallback wording must actually say age-only-ish, not silently omit the line');
});

// ================================================================ 6. spine list extension

test('spineDocPaths: cockpit scope includes README.md, skills/README.md, and shells/doctrine.md alongside the existing spine set', async () => {
  const paths = (await spineDocPaths('cockpit')).map((p) => p.path);
  assert.ok(paths.some((p) => p.endsWith('/README.md') && !p.includes('/skills/')), 'repo-root README.md must be included');
  assert.ok(paths.some((p) => p.endsWith('skills/README.md')), 'skills/README.md must be included');
  assert.ok(paths.some((p) => p.endsWith('shells/doctrine.md')), 'shells/doctrine.md must be included');
  // and the existing spine entries must NOT have been dropped by the extension
  assert.ok(paths.some((p) => p.endsWith('DECISIONS.md')), 'existing DECISIONS.md entry must still be present');
  assert.ok(paths.some((p) => p.endsWith('CLAUDE.md') && !p.includes('shells')), 'existing scope CLAUDE.md entry must still be present');
});

test('spineDocPaths: the three new paths actually resolve to real files under REPO_ROOT', async () => {
  const paths = (await spineDocPaths('cockpit')).map((p) => p.path);
  for (const suffix of ['README.md', 'skills/README.md', 'shells/doctrine.md']) {
    const hit = paths.find((p) => p.endsWith(suffix));
    assert.ok(hit, `${suffix} must be present in the spine list`);
    assert.ok(hit.startsWith(REPO_ROOT), `${suffix} path must resolve under REPO_ROOT`);
    await assert.doesNotReject(readFile(hit, 'utf8'), `${hit} must be a real, readable file`);
  }
});

// ================================================================ 7. budget/caps unchanged

test('gatherDocDebtCandidates: with more project candidates than the cap, larger staleness-gap candidates are ordered first', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  const ids = ['gap-lo', 'gap-hi'];
  for (const id of ids) {
    await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'sdd3', 'projects'), { recursive: true });
    const projPath = resolve(TEST_MEMORY_ROOT, 'scopes', 'sdd3', 'projects', `${id}.md`);
    const roadPath = resolve(TEST_MEMORY_ROOT, 'scopes', 'sdd3', 'projects', `${id}.roadmap.md`);
    await writeFile(projPath, `---\nid: ${id}\nscope: sdd3\nstate: active\nlast_understanding_change: 2026-01-01\n---\nbody\n`, 'utf8');
    await writeFile(roadPath, '## Now\n- x\n', 'utf8');
    await commitAt(TEST_MEMORY_ROOT, `scopes/sdd3/projects/${id}.md`, daysAgoISO(10));
  }
  // gap-lo: roadmap committed close to the project file (small gap).
  await commitAt(TEST_MEMORY_ROOT, 'scopes/sdd3/projects/gap-lo.roadmap.md', daysAgoISO(9));
  // gap-hi: roadmap committed far from the project file (large gap).
  await commitAt(TEST_MEMORY_ROOT, 'scopes/sdd3/projects/gap-hi.roadmap.md', daysAgoISO(200));

  const candidates = await gatherDocDebtCandidates('sdd3', undefined);
  const projectCandidates = candidates.filter((c) => c.project);
  const hiIdx = projectCandidates.findIndex((c) => c.project.frontmatter.id === 'gap-hi');
  const loIdx = projectCandidates.findIndex((c) => c.project.frontmatter.id === 'gap-lo');
  assert.ok(hiIdx !== -1 && loIdx !== -1, 'both fixture projects must appear among the candidates');
  assert.ok(hiIdx < loIdx, 'the larger staleness-gap candidate (gap-hi) must be ordered before the smaller one (gap-lo)');
});

test('cooldownKey: format is unchanged — scope|project|detector, "-" for an empty project', async () => {
  assert.equal(cooldownKey('cockpit', 'proj-a', 'doc-debt'), 'cockpit|proj-a|doc-debt');
  assert.equal(cooldownKey('cockpit', undefined, 'doc-debt'), 'cockpit|-|doc-debt');
  assert.equal(cooldownKey('cockpit', '', 'doc-debt'), 'cockpit|-|doc-debt');
});

test('CANDIDATE_CAP: still a small positive sanity bound (the reference-discovery pool joins existing caps, it does not remove them)', () => {
  assert.ok(Number.isInteger(CANDIDATE_CAP) && CANDIDATE_CAP > 0 && CANDIDATE_CAP <= 50,
    `CANDIDATE_CAP must remain a small sanity bound, got ${CANDIDATE_CAP}`);
});

// ================================================================ 8. symlink containment

test('discoverReferences: a symlink inside a root pointing OUTSIDE both roots is rejected even though the lexical path looks in-root', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink-engine-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink-memory-'));
  const outsideRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink-outside-'));
  try {
    // the real target lives entirely outside both roots.
    const outsideTarget = resolve(outsideRoot, 'secret.md');
    await writeFile(outsideTarget, 'outside content', 'utf8');

    // a symlink SITS inside memoryRoot (lexically in-root) but resolves outside both roots.
    await mkdir(resolve(memoryRoot, 'scopes', 'sdd-sym', 'projects'), { recursive: true });
    const escapeLink = resolve(memoryRoot, 'scopes', 'sdd-sym', 'projects', 'escape-link.md');
    await symlink(outsideTarget, escapeLink);

    const refs = await discoverReferences({
      projectId: 'proj-sym',
      projectText: 'See scopes/sdd-sym/projects/escape-link.md for details.',
      roadmapText: '',
      engineRoot,
      memoryRoot,
    });
    const paths = refs.map((r) => r.path);
    assert.ok(!paths.some((p) => p === escapeLink),
      'a symlink inside a root whose RESOLVED target escapes both roots must be rejected, not trusted on lexical containment alone');
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('discoverReferences: a symlink inside a root pointing to ANOTHER in-root file is accepted (current containment policy: resolved target must remain under a root)', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink2-engine-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink2-memory-'));
  try {
    await mkdir(resolve(memoryRoot, 'scopes', 'sdd-sym2', 'projects'), { recursive: true });
    const realTarget = resolve(memoryRoot, 'scopes', 'sdd-sym2', 'projects', 'real.md');
    await writeFile(realTarget, 'real content', 'utf8');
    const inRootLink = resolve(memoryRoot, 'scopes', 'sdd-sym2', 'projects', 'link-to-real.md');
    await symlink(realTarget, inRootLink);

    const refs = await discoverReferences({
      projectId: 'proj-sym2',
      projectText: 'See scopes/sdd-sym2/projects/link-to-real.md for details.',
      roadmapText: '',
      engineRoot,
      memoryRoot,
    });
    const paths = refs.map((r) => r.path);
    assert.ok(paths.some((p) => p === realTarget),
      'a symlink whose resolved target stays inside a root must still be accepted');
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

test('discoverReferences: an in-root symlink to an in-root file returns the RESOLVED real path, not the lexical symlink path (safe to read later)', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink3-engine-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink3-memory-'));
  try {
    await mkdir(resolve(memoryRoot, 'scopes', 'sdd-sym3', 'projects'), { recursive: true });
    const realTarget = resolve(memoryRoot, 'scopes', 'sdd-sym3', 'projects', 'real3.md');
    await writeFile(realTarget, 'real content', 'utf8');
    const inRootLink = resolve(memoryRoot, 'scopes', 'sdd-sym3', 'projects', 'link-to-real3.md');
    await symlink(realTarget, inRootLink);
    const expectedRealPath = await realpath(realTarget);

    const refs = await discoverReferences({
      projectId: 'proj-sym3',
      projectText: 'See scopes/sdd-sym3/projects/link-to-real3.md for details.',
      roadmapText: '',
      engineRoot,
      memoryRoot,
    });
    const paths = refs.map((r) => r.path);
    assert.ok(paths.some((p) => p === expectedRealPath),
      'the returned path must equal the realpath of the symlink target, so a later symlink swap cannot redirect the read');
    assert.ok(!paths.some((p) => p === inRootLink),
      'the lexical symlink path itself must not be the returned candidate path once resolved');
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

test('discoverReferences: an in-root symlink AND its direct in-root target, both referenced, dedupe to ONE candidate keyed on the resolved realpath', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink4-engine-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink4-memory-'));
  try {
    await mkdir(resolve(memoryRoot, 'scopes', 'sdd-sym4', 'projects'), { recursive: true });
    const realTarget = resolve(memoryRoot, 'scopes', 'sdd-sym4', 'projects', 'real.md');
    await writeFile(realTarget, 'real content', 'utf8');
    const inRootLink = resolve(memoryRoot, 'scopes', 'sdd-sym4', 'projects', 'link.md');
    await symlink(realTarget, inRootLink);
    const expectedRealPath = await realpath(realTarget);

    const refs = await discoverReferences({
      projectId: 'proj-sym4',
      projectText: 'See scopes/sdd-sym4/projects/link.md and also scopes/sdd-sym4/projects/real.md for details.',
      roadmapText: '',
      engineRoot,
      memoryRoot,
    });

    assert.equal(refs.length, 1,
      'a symlink and its direct target, both referenced, must dedupe to exactly one candidate on the resolved realpath');
    assert.equal(refs[0].path, expectedRealPath,
      'the surviving candidate path must equal the realpath of the target, not the lexical symlink path');
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

test('discoverReferences: an engineRoot symlink aliasing an already-referenced target must not abandon the match — a DISTINCT real file at the same lexical path in memoryRoot must still surface (continue, not break, on the seen-realpath hit)', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink5-engine-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-symlink5-memory-'));
  try {
    await mkdir(resolve(engineRoot, 'decisions'), { recursive: true });
    await mkdir(resolve(memoryRoot, 'decisions'), { recursive: true });

    // T: the already-referenced target, real in engineRoot.
    const targetPath = resolve(engineRoot, 'decisions', 'target.md');
    await writeFile(targetPath, 'target content', 'utf8');
    const expectedTargetRealPath = await realpath(targetPath);

    // engineRoot alias at the SAME lexical relative path as the later memoryRoot reference,
    // resolving (via symlink) to the already-seen target T.
    const engineAliasPath = resolve(engineRoot, 'decisions', 'link.md');
    await symlink(targetPath, engineAliasPath);

    // memoryRoot: a DISTINCT real file at that same lexical relative path (decisions/link.md).
    const memoryDistinctPath = resolve(memoryRoot, 'decisions', 'link.md');
    await writeFile(memoryDistinctPath, 'distinct memoryRoot content', 'utf8');

    const refs = await discoverReferences({
      projectId: 'proj-sym5',
      // First match resolves and seeds `seen` with T; second match's lexical path collides via
      // an engineRoot alias, but must still fall through to memoryRoot's distinct real file.
      projectText: 'See decisions/target.md and also decisions/link.md for details.',
      roadmapText: '',
      engineRoot,
      memoryRoot,
    });
    const paths = refs.map((r) => r.path);

    assert.equal(paths.filter((p) => p === expectedTargetRealPath).length, 1,
      'the already-referenced target T must appear exactly once');
    assert.ok(paths.some((p) => p === memoryDistinctPath),
      'the distinct memoryRoot file at the same lexical path must still surface — a `break` on the seen-realpath hit would wrongly abandon this match before memoryRoot is ever tried');
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

// ================================================================ 9. workCommitsSince literal matching

test('workCommitsSince: a project id containing regex metacharacters (e.g. "auto.uno") matches ONLY the literal string, not the regex interpretation', async () => {
  const repo = await mkTmpRepo('doc-debt-literal1-');
  try {
    await writeFile(resolve(repo, 'f.txt'), '1', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(9), 'auto.uno: fix the literal thing');   // literal match
    await writeFile(resolve(repo, 'f.txt'), '2', 'utf8');
    // ONLY matches if "." is interpreted as regex-any-char, never under literal matching.
    await commitAt(repo, 'f.txt', daysAgoISO(8), 'autoXuno: unrelated, regex-only coincidence');
    await writeFile(resolve(repo, 'f.txt'), '3', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(7), 'totally unrelated commit');

    const sinceDate = daysAgoISO(20).slice(0, 10);
    const count = await workCommitsSince('auto.uno', sinceDate, repo);
    assert.equal(count, 1, 'only the literal "auto.uno" commit must count; the regex-only "autoXuno" coincidence must not');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('workCommitsSince: a project id containing regex-special brackets (e.g. "[core]") never turns the count into null via a git error, and does not match unrelated commits under regex char-class interpretation', async () => {
  const repo = await mkTmpRepo('doc-debt-literal2-');
  try {
    await writeFile(resolve(repo, 'f.txt'), '1', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(9), 'landed [core] refactor');   // literal match
    await writeFile(resolve(repo, 'f.txt'), '2', 'utf8');
    // "[core]" as a regex character class would match any single "c", "o", "r", or "e" character —
    // this commit message contains such characters but never the literal substring "[core]".
    await commitAt(repo, 'f.txt', daysAgoISO(8), 'a random c change with no brackets at all');
    await writeFile(resolve(repo, 'f.txt'), '3', 'utf8');
    await commitAt(repo, 'f.txt', daysAgoISO(7), 'totally unrelated commit');

    const sinceDate = daysAgoISO(20).slice(0, 10);
    const count = await workCommitsSince('[core]', sinceDate, repo);
    assert.notEqual(count, null, 'a regex-special project id must never turn the count into null via a git invalid-regex error');
    assert.equal(count, 1, 'only the literal "[core]" commit must count, never the char-class-coincidence commits');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ================================================================ 10. timestamp precision

test('workCommitsSince: exact time-of-day precision — a commit the same DAY but BEFORE the since-timestamp must not count, one AFTER must', async () => {
  const repo = await mkTmpRepo('doc-debt-precision-');
  try {
    const day = '2026-04-10';
    await writeFile(resolve(repo, 'f.txt'), '1', 'utf8');
    await commitAt(repo, 'f.txt', `${day}T09:00:00Z`, 'proj-mid: morning commit, before the roadmap change');
    await writeFile(resolve(repo, 'f.txt'), '2', 'utf8');
    await commitAt(repo, 'f.txt', `${day}T15:00:00Z`, 'proj-mid: afternoon commit, after the roadmap change');

    const roadmapChangedAt = `${day}T12:00:00Z`;   // midday — same calendar day as both commits
    const count = await workCommitsSince('proj-mid', roadmapChangedAt, repo);
    assert.equal(count, 1,
      'exactly one commit (the afternoon one) must count when the since-timestamp carries time-of-day precision, '
      + 'not the date-only day boundary that would have counted both or neither');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ================================================================ 11. truncateRoadmap: non-Done sections drop before Now/Next is touched

test('truncateRoadmap: a large preamble/Notes section ahead of Now is dropped first, Now+Next fully survive the budget', () => {
  const notes = '## Notes\n' + '- stale historical note\n'.repeat(300);   // huge, deliberately pushes total over budget
  const now = '## Now\n- current work item\n';
  const next = '## Next\n- upcoming work item\n';
  const full = `${notes}\n${now}\n${next}`;
  const budget = 500;
  assert.ok(full.length > budget, 'fixture must actually exceed the budget');
  assert.ok((now + next).length <= budget, 'Now+Next alone must comfortably fit the budget (this is the case being tested)');

  const out = truncateRoadmap(full, budget);
  assert.ok(out.includes('current work item'), 'Now content must fully survive');
  assert.ok(out.includes('upcoming work item'), 'Next content must fully survive');
  assert.ok(!out.includes('stale historical note'), 'the large Notes section must be dropped ahead of touching Now/Next');
});

// ================================================================ 12. cap ordering under real pressure

test('gatherDocDebtCandidates: with MORE project candidates than CANDIDATE_CAP, the highest-gap project survives and leads even when a naive first-N-by-recency selection would have dropped it', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  const scope = 'sdd-pressure';
  const dir = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'projects');
  await mkdir(dir, { recursive: true });

  // CANDIDATE_CAP low-gap projects, all with an EARLIER last_understanding_change than the star,
  // so an ascending-by-recency first-N slice (today's targetProjects behavior) would fill the cap
  // with these before ever reaching the star project below.
  const fillerIds = [];
  for (let i = 0; i < CANDIDATE_CAP; i++) {
    const id = `filler-${String(i).padStart(2, '0')}`;
    fillerIds.push(id);
    const projPath = resolve(dir, `${id}.md`);
    const roadPath = resolve(dir, `${id}.roadmap.md`);
    await writeFile(projPath, `---\nid: ${id}\nscope: ${scope}\nstate: active\nlast_understanding_change: 2026-01-0${(i % 9) + 1}\n---\nbody\n`, 'utf8');
    await writeFile(roadPath, '## Now\n- x\n', 'utf8');
    await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.md`, daysAgoISO(10));
    await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.roadmap.md`, daysAgoISO(10));   // ~zero gap
  }

  // the star: sorts LAST by last_understanding_change (naive-select-would-drop-it), but carries by
  // far the largest roadmap-vs-project staleness gap.
  const starId = 'gap-star';
  const starProjPath = resolve(dir, `${starId}.md`);
  const starRoadPath = resolve(dir, `${starId}.roadmap.md`);
  await writeFile(starProjPath, `---\nid: ${starId}\nscope: ${scope}\nstate: active\nlast_understanding_change: 2026-12-31\n---\nbody\n`, 'utf8');
  await writeFile(starRoadPath, '## Now\n- x\n', 'utf8');
  await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${starId}.md`, daysAgoISO(300));
  await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${starId}.roadmap.md`, daysAgoISO(1));   // huge gap

  const candidates = await gatherDocDebtCandidates(scope, undefined);
  const projectCandidates = candidates.filter((c) => c.project);
  const starIdx = projectCandidates.findIndex((c) => c.project.frontmatter.id === starId);
  assert.ok(starIdx !== -1,
    `gap-star must survive the cap despite sorting last by recency among ${CANDIDATE_CAP + 1} project candidates`);
  assert.equal(starIdx, 0, 'gap-star, carrying by far the largest staleness gap, must lead the ordered candidate list');
});

// ================================================================ 13. oversized reference

test('discoverReferences: a referenced in-root .md file over 256 KB is skipped as a candidate', async () => {
  const engineRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-oversize-engine-'));
  const memoryRoot = await mkdtemp(resolve(tmpdir(), 'doc-debt-oversize-memory-'));
  try {
    await mkdir(resolve(memoryRoot, 'scopes', 'sdd-big', 'projects'), { recursive: true });
    const bigPath = resolve(memoryRoot, 'scopes', 'sdd-big', 'projects', 'huge.md');
    const smallPath = resolve(memoryRoot, 'scopes', 'sdd-big', 'projects', 'small.md');
    await writeFile(bigPath, 'x'.repeat(256 * 1024 + 1), 'utf8');   // just over the 256 KB line
    await writeFile(smallPath, 'small content', 'utf8');

    const refs = await discoverReferences({
      projectId: 'proj-big',
      projectText: 'See scopes/sdd-big/projects/huge.md and scopes/sdd-big/projects/small.md.',
      roadmapText: '',
      engineRoot,
      memoryRoot,
    });
    const paths = refs.map((r) => r.path);
    assert.ok(!paths.some((p) => p === bigPath), 'a referenced .md file over 256 KB must be skipped as a candidate');
    assert.ok(paths.some((p) => p === smallPath), 'a normally-sized referenced .md file must still be accepted (control)');
  } finally {
    await rm(engineRoot, { recursive: true, force: true });
    await rm(memoryRoot, { recursive: true, force: true });
  }
});

// ================================================================ 14. fair allocation (round-robin interleave)

test('gatherDocDebtCandidates: when project candidates alone already reach CANDIDATE_CAP, at least one discovered reference still reaches the final candidate list (fair round-robin share of the widened cap, not first-come starvation)', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  const scope = 'sdd-fair';
  const dir = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'projects');
  await mkdir(dir, { recursive: true });

  // exactly CANDIDATE_CAP projects — enough on their own, under the OLD per-phase break
  // (`if (out.length >= CANDIDATE_CAP) break`), to lock spine docs and references out of the
  // widened CANDIDATE_CAP*2 budget entirely, even though there is room left in the total.
  for (let i = 0; i < CANDIDATE_CAP; i++) {
    const id = `fair-${String(i).padStart(2, '0')}`;
    const projPath = resolve(dir, `${id}.md`);
    const roadPath = resolve(dir, `${id}.roadmap.md`);
    const refText = i === 0 ? `See scopes/${scope}/projects/referenced-sibling.md for background.\n` : '';
    await writeFile(projPath, `---\nid: ${id}\nscope: ${scope}\nstate: active\nlast_understanding_change: 2026-01-0${(i % 9) + 1}\n---\nbody\n${refText}`, 'utf8');
    await writeFile(roadPath, '## Now\n- x\n', 'utf8');
    await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.md`, daysAgoISO(10));
  }
  // the sibling file the first project's body references — a legitimate, existing, in-root .md.
  await writeFile(resolve(dir, 'referenced-sibling.md'), 'sibling content', 'utf8');

  const candidates = await gatherDocDebtCandidates(scope, undefined);
  const refCandidates = candidates.filter((c) => c.doc && c.doc.path && c.doc.path.endsWith('referenced-sibling.md'));
  assert.ok(refCandidates.length > 0,
    'with CANDIDATE_CAP project candidates already filling the base cap, a discovered reference must still '
    + 'reach the final list via the widened CANDIDATE_CAP*2 budget (fair interleave), not be starved by a '
    + 'per-phase break that fires the instant the base CANDIDATE_CAP is first touched');
});
