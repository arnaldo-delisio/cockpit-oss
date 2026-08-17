// detector-shared-plumbing.test.mjs — MEM-38-family detector upgrade, shared-gather + prompt +
// ordering + recency spec (frozen spec sections A-E, see the task that authored this file).
//
// AUTHORED AS THE INDEPENDENT TEST PASS, BEFORE the implementation exists — every test here is
// expected to FAIL against today's semantic-insights.mjs / read-pass.mjs / mechanical-insights.mjs,
// and PASS only once the spec functions below are added and exported. Do not weaken a test to make
// it pass early. Matches doc-debt-upgrade.test.mjs's conventions: hermetic temp fixture repos,
// offline (setup.mjs's HF-remote guard), node --test, git fixture helpers reproduced locally.
//
// API CONTRACT ASSUMED (none of this exists today; this is the surface this suite requires):
//
// semantic-insights.mjs:
//   • gatherProjectCandidates(scope, project) — NEW. The shared enrichment gather (spec A): once
//     per scan, produces the per-project candidate list currently built inline inside
//     gatherDocDebtCandidates's project loop (project + roadmap text + staleDays + roadmapStaleDays
//     + roadmapLastChangeISO). gatherDocDebtCandidates, gatherResearchGapCandidates, and
//     gatherProjectSchedulingCandidates all consume it instead of each re-reading/re-git-logging.
//   • gatherResearchGapCandidates(scope, project) — already exists as a local fn; needs export.
//   • gatherProjectSchedulingCandidates(scope, project) — already exists as a local fn; needs
//     export, AND (spec C) needs the same largest-gap-first ordering + cap doc-debt already applies,
//     applied AFTER the gap sort, mirroring gatherDocDebtCandidates's own cap discipline.
//   • buildResearchGapPrompt(c) — NEW pure prompt-builder, pulled out of the existing inline
//     judgeResearchGap() so its text is assertable without invoking judge(). Must use
//     truncateRoadmap (not the old truncate(c.roadmap, 2000)) and include the doc-debt-style
//     deterministic git header lines (docDebtHeaderLines) for candidates carrying the new
//     enrichment fields.
//   • buildProjectSchedulingPrompt(c) — NEW pure prompt-builder, same deal for
//     judgeProjectScheduling().
//
// read-pass.mjs:
//   • skillGitDates(relPath, gitRoot) — NEW pure(ish) helper, mirrors semantic-insights.mjs's
//     staleDaysFor/lastCommitDateFor split (same `git log --follow --format=%aI` call
//     enumerateSkills already makes, parametrized by an explicit gitRoot so tests never touch the
//     real cockpit repo — same testability precedent workCommitsSince established). Returns
//     { ageDays, lastChangedDays }: ageDays from the OLDEST commit (dates.at(-1), today's existing
//     enumerateSkills behavior), lastChangedDays from the NEWEST commit (dates[0], new).
//     enumerateSkills() itself is expected to call this with the real COCKPIT_DIR and attach
//     `lastChangedDays` to each returned skill object — not directly re-tested here since
//     enumerateSkills is hardwired to the real repo's skills/ dir (untestable hermetically); the
//     git-log parsing logic itself is what skillGitDates isolates and this suite exercises.
//
// mechanical-insights.mjs:
//   • SKILL_AGE_FLOOR_DAYS — already a module-local const (14); needs export.
//   • buildUnderusedSkillPrompt(candidate) — NEW pure prompt-builder, pulled out of the existing
//     inline classifyUnderusedSkill() so its text is assertable without invoking judge(). Must
//     include the new recency signal (lastChangedDays) in the rendered text.
//   • filterUnderusedSkillCandidates(raw) — NEW pure filter, the age/invocation/recency-floor gate
//     currently inline in collectUnderusedSkillCandidates's for-loop, plus the NEW recency floor:
//     a candidate whose lastChangedDays < SKILL_AGE_FLOOR_DAYS is excluded even if ageDays clears
//     the existing floor (a skill that's old but was JUST touched is not "underused" this week).
//   • rankUnderusedSkillCandidates(raw) — NEW pure sort, least-recently-used first (largest
//     lastChangedDays first), replacing today's implicit readdir order ahead of the
//     SKILL_JUDGE_CAP slice in collectUnderusedSkillCandidates.
//
// Ambiguity resolutions (stated up front):
//   1. Field name for the new recency signal is this author's choice (`lastChangedDays`), not
//      specified verbatim by the spec ("or similar per the implementation's chosen name"). Tests
//      assert on this exact name because SOME name must be assumed to write an executable test;
//      a differently-named field that carries the same value under a different key would need this
//      test's import/property-access updated, not its intent.
//   2. Section A ("assert equality of enrichment values across the three gatherers") is read
//      literally: same fixture, same scope/project in, each gatherer's project-shaped candidates
//      must carry identical staleDays/roadmapStaleDays/roadmapLastChangeISO for the same project id.
//      No spy/call-count assertions are made (explicitly out of scope per the spec).
//   3. Prompt-builder pure-function extraction (buildResearchGapPrompt / buildProjectSchedulingPrompt
//      / buildUnderusedSkillPrompt) is this author's chosen seam to make prompt TEXT assertable
//      without invoking judge() or mocking the LLM — mirrors the codebase's own established
//      precedent (docDebtHeaderLines, truncateRoadmap are already pure exported formatters feeding
//      judgeDocDebt's prompt string).
//   4. "least-recently-used first" (spec E) is read as: largest lastChangedDays (longest since last
//      touched) sorts first — the same direction as doc-debt's "largest gap first" (§ spec C).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile, writeFile, mkdir, rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';
import {
  gatherProjectCandidates, gatherDocDebtCandidates, gatherResearchGapCandidates,
  gatherProjectSchedulingCandidates, buildResearchGapPrompt, buildProjectSchedulingPrompt,
  truncateRoadmap, CANDIDATE_CAP,
} from '../semantic-insights.mjs';
import { skillGitDates } from '../read-pass.mjs';
import {
  SKILL_AGE_FLOOR_DAYS, buildUnderusedSkillPrompt, filterUnderusedSkillCandidates,
  rankUnderusedSkillCandidates,
} from '../mechanical-insights.mjs';

const execFileP = promisify(execFile);

// ---------- git fixture helpers (reproduced from doc-debt-upgrade.test.mjs's convention) ----------

async function initGitRepo(root) {
  await execFileP('git', ['-C', root, 'init', '--quiet']);
  await execFileP('git', ['-C', root, 'config', 'user.name', 'Test']);
  await execFileP('git', ['-C', root, 'config', 'user.email', 'test@test.invalid']);
}

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

async function makeFixtureProject(scope, id, { projDays = 10, roadDays = 10 } = {}) {
  const dir = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'projects');
  await mkdir(dir, { recursive: true });
  const projPath = resolve(dir, `${id}.md`);
  const roadPath = resolve(dir, `${id}.roadmap.md`);
  await writeFile(projPath, `---\nid: ${id}\nscope: ${scope}\nstate: active\n---\nbody text for ${id}\n`, 'utf8');
  await writeFile(roadPath, '## Now\n- now item\n## Next\n' + '- filler\n'.repeat(50) + '- DEEP-NEXT-MARKER\n', 'utf8');
  await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.md`, daysAgoISO(projDays));
  await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.roadmap.md`, daysAgoISO(roadDays));
  return { projPath, roadPath };
}

// ================================================================ A. shared gather

test('gatherProjectCandidates: produces the enriched per-project shape (staleDays, roadmapStaleDays, roadmapLastChangeISO)', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  await makeFixtureProject('spa1', 'proj-a', { projDays: 30, roadDays: 3 });

  const candidates = await gatherProjectCandidates('spa1', 'proj-a');
  assert.equal(candidates.length, 1, 'single-project mode must return exactly one candidate');
  const c = candidates[0];
  assert.equal(c.project.frontmatter.id, 'proj-a');
  assert.ok(Number.isFinite(c.staleDays), 'staleDays must be populated');
  assert.ok(Number.isFinite(c.roadmapStaleDays), 'roadmapStaleDays must be populated');
  assert.ok(Math.abs(c.staleDays - 30) < 1.5);
  assert.ok(Math.abs(c.roadmapStaleDays - 3) < 1.5);
  assert.ok(c.roadmapLastChangeISO, 'roadmapLastChangeISO must be populated');
});

test('gatherDocDebtCandidates, gatherResearchGapCandidates, gatherProjectSchedulingCandidates: all three carry identical enrichment fields for the same project (single shared gather, not three separate re-reads)', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  await makeFixtureProject('spb1', 'proj-b', { projDays: 45, roadDays: 6 });

  const [docDebt, researchGap, scheduling] = await Promise.all([
    gatherDocDebtCandidates('spb1', 'proj-b'),
    gatherResearchGapCandidates('spb1', 'proj-b'),
    gatherProjectSchedulingCandidates('spb1', 'proj-b'),
  ]);

  const findB = (list) => list.find((c) => c.project && c.project.frontmatter.id === 'proj-b');
  const dd = findB(docDebt);
  const rg = findB(researchGap);
  const ps = findB(scheduling);
  assert.ok(dd && rg && ps, 'proj-b candidate must be present in all three gatherers');

  for (const field of ['staleDays', 'roadmapStaleDays', 'roadmapLastChangeISO']) {
    assert.ok(Number.isFinite(rg[field]) || typeof rg[field] === 'string',
      `research-gap candidate must carry enrichment field "${field}"`);
    assert.ok(Number.isFinite(ps[field]) || typeof ps[field] === 'string',
      `project-scheduling candidate must carry enrichment field "${field}"`);
    assert.equal(rg[field], dd[field], `research-gap's "${field}" must equal doc-debt's (same underlying gather)`);
    assert.equal(ps[field], dd[field], `project-scheduling's "${field}" must equal doc-debt's (same underlying gather)`);
  }
});

// ================================================================ B. prompt builders

test('buildResearchGapPrompt: uses truncateRoadmap, not the old 2000-char blind cut — a marker deep in Next survives', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  await makeFixtureProject('spc1', 'proj-c', { projDays: 20, roadDays: 20 });
  const [c] = await gatherResearchGapCandidates('spc1', 'proj-c');
  const prompt = await buildResearchGapPrompt(c);
  assert.ok(prompt.includes('DEEP-NEXT-MARKER'), 'content deep in Next, past the old 2000-char cutoff, must reach the prompt');
});

test('buildResearchGapPrompt: includes the deterministic git header lines (roadmap-unchanged days, work-commit count or age-only fallback)', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  await makeFixtureProject('spc2', 'proj-c2', { projDays: 20, roadDays: 12 });
  const [c] = await gatherResearchGapCandidates('spc2', 'proj-c2');
  const prompt = await buildResearchGapPrompt(c);
  assert.match(prompt, /roadmap unchanged 12 day/i, 'must state the roadmap-unchanged day count');
  assert.match(prompt, /work commit|age-only|no work-commit count/i, 'must state a work-commit count or its age-only fallback wording');
});

test('buildProjectSchedulingPrompt: uses truncateRoadmap — a marker deep in Next survives', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  await makeFixtureProject('spd1', 'proj-d', { projDays: 15, roadDays: 15 });
  const [c] = await gatherProjectSchedulingCandidates('spd1', 'proj-d');
  const prompt = await buildProjectSchedulingPrompt(c);
  assert.ok(prompt.includes('DEEP-NEXT-MARKER'), 'content deep in Next must reach the project-scheduling prompt');
});

test('buildProjectSchedulingPrompt: includes the deterministic git header lines', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  await makeFixtureProject('spd2', 'proj-d2', { projDays: 15, roadDays: 8 });
  const [c] = await gatherProjectSchedulingCandidates('spd2', 'proj-d2');
  const prompt = await buildProjectSchedulingPrompt(c);
  assert.match(prompt, /roadmap unchanged 8 day/i, 'must state the roadmap-unchanged day count');
  assert.match(prompt, /work commit|age-only|no work-commit count/i, 'must state a work-commit count or its age-only fallback wording');
});

// ================================================================ C. project-scheduling ordering

test('gatherProjectSchedulingCandidates: with more project candidates than the cap, the largest work-vs-roadmap divergence is ordered first — a naive recency-only selection would have dropped it', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  const scope = 'sps-pressure';
  const dir = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'projects');
  await mkdir(dir, { recursive: true });

  // CANDIDATE_CAP filler projects, all near-zero staleness gap, each sorting AHEAD of the star by
  // last_understanding_change (ascending recency, today's targetProjects default order) — a naive
  // first-N-by-recency slice fills the cap with these before ever reaching the star below.
  for (let i = 0; i < CANDIDATE_CAP; i++) {
    const id = `filler-${String(i).padStart(2, '0')}`;
    const projPath = resolve(dir, `${id}.md`);
    const roadPath = resolve(dir, `${id}.roadmap.md`);
    await writeFile(projPath, `---\nid: ${id}\nscope: ${scope}\nstate: active\nlast_understanding_change: 2026-01-0${(i % 9) + 1}\n---\nbody\n`, 'utf8');
    await writeFile(roadPath, '## Now\n- x\n', 'utf8');
    await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.md`, daysAgoISO(10));
    await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.roadmap.md`, daysAgoISO(10));   // ~zero gap
  }

  // the star: sorts LAST by last_understanding_change, but carries by far the largest
  // roadmap-vs-project staleness gap.
  const starId = 'gap-star';
  await writeFile(resolve(dir, `${starId}.md`), `---\nid: ${starId}\nscope: ${scope}\nstate: active\nlast_understanding_change: 2026-12-31\n---\nbody\n`, 'utf8');
  await writeFile(resolve(dir, `${starId}.roadmap.md`), '## Now\n- x\n', 'utf8');
  await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${starId}.md`, daysAgoISO(300));
  await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${starId}.roadmap.md`, daysAgoISO(1));   // huge gap

  const candidates = await gatherProjectSchedulingCandidates(scope, undefined);
  const starIdx = candidates.findIndex((c) => c.project.frontmatter.id === starId);
  assert.ok(starIdx !== -1, `gap-star must survive the cap despite sorting last by recency among ${CANDIDATE_CAP + 1} candidates`);
  assert.equal(starIdx, 0, 'gap-star, carrying by far the largest staleness gap, must lead the ordered candidate list');
});

// ================================================================ D. underused-skill recency signal

test('skillGitDates: an old-creation, recently-touched fixture skill file yields large ageDays and small lastChangedDays', async () => {
  const repo = await mkTmpRepo('detector-skillgit-');
  try {
    await mkdir(resolve(repo, 'skills', 'sample-skill'), { recursive: true });
    const relPath = 'skills/sample-skill/SKILL.md';
    await writeFile(resolve(repo, relPath), 'v1', 'utf8');
    await commitAt(repo, relPath, daysAgoISO(400), 'initial skill');   // old creation
    await writeFile(resolve(repo, relPath), 'v2 — freshly touched', 'utf8');
    await commitAt(repo, relPath, daysAgoISO(2), 'small recent tweak');   // fresh touch

    const { ageDays, lastChangedDays } = await skillGitDates(relPath, repo);
    assert.ok(Number.isFinite(ageDays) && ageDays > 100, `ageDays must reflect the OLD creation commit, got ${ageDays}`);
    assert.ok(Number.isFinite(lastChangedDays) && lastChangedDays < 10, `lastChangedDays must reflect the RECENT commit, got ${lastChangedDays}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('skillGitDates: a skill with only one (old) commit has ageDays approx equal to lastChangedDays', async () => {
  const repo = await mkTmpRepo('detector-skillgit2-');
  try {
    await mkdir(resolve(repo, 'skills', 'single-commit-skill'), { recursive: true });
    const relPath = 'skills/single-commit-skill/SKILL.md';
    await writeFile(resolve(repo, relPath), 'v1', 'utf8');
    await commitAt(repo, relPath, daysAgoISO(50), 'only commit');

    const { ageDays, lastChangedDays } = await skillGitDates(relPath, repo);
    assert.ok(Math.abs(ageDays - lastChangedDays) < 1.5, 'a single-commit file must have ageDays ~= lastChangedDays');
    assert.ok(Math.abs(ageDays - 50) < 1.5);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('skillGitDates: untracked path never throws, returns nulls', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'detector-skillgit-none-'));
  try {
    const { ageDays, lastChangedDays } = await skillGitDates('skills/nope/SKILL.md', dir);
    assert.equal(ageDays, null);
    assert.equal(lastChangedDays, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildUnderusedSkillPrompt: the rendered prompt text carries the recency signal (lastChangedDays)', () => {
  const candidate = {
    name: 'sample-skill', description: 'does a thing', ageDays: 400, lastChangedDays: 2,
    hasLearned: false, learnedBytes: 0, lastUse: null, openers: [],
  };
  const prompt = buildUnderusedSkillPrompt(candidate);
  assert.match(prompt, /\b2\b.*day/i, 'the small lastChangedDays value must appear in the rendered prompt text');
});

test('filterUnderusedSkillCandidates: excludes a candidate whose lastChangedDays is below SKILL_AGE_FLOOR_DAYS, even though ageDays clears the floor (recency floor)', () => {
  assert.ok(SKILL_AGE_FLOOR_DAYS > 0, 'sanity: the floor constant must be a positive number');
  const oldButFresh = { name: 'old-but-fresh', ageDays: 400, lastChangedDays: SKILL_AGE_FLOOR_DAYS - 1 };
  const oldAndStale = { name: 'old-and-stale', ageDays: 400, lastChangedDays: SKILL_AGE_FLOOR_DAYS + 100 };
  const tooNew = { name: 'too-new', ageDays: SKILL_AGE_FLOOR_DAYS - 1, lastChangedDays: SKILL_AGE_FLOOR_DAYS - 1 };

  const kept = filterUnderusedSkillCandidates([oldButFresh, oldAndStale, tooNew]);
  const names = kept.map((c) => c.name);
  assert.ok(!names.includes('old-but-fresh'), 'a skill just touched inside the recency floor must be excluded despite being old');
  assert.ok(!names.includes('too-new'), 'a skill inside the age floor must still be excluded (existing behavior preserved)');
  assert.ok(names.includes('old-and-stale'), 'a skill old AND stale past both floors must survive the filter (control)');
});

// ================================================================ F. memo invalidation across scans

// clearProjectGatherMemo (or equivalent) is the parallel implementer's addition, not yet landed as
// of this test's authoring — imported dynamically so a missing export fails this one test with a
// clear message instead of a SyntaxError that aborts the whole file at module-load time.
test('gatherProjectCandidates: a fresh scan after clearing the memo reflects a modified roadmap/commit, not the first scan\'s cached values', async () => {
  await initGitRepo(TEST_MEMORY_ROOT);
  const scope = 'spe1';
  const id = 'proj-e';
  await makeFixtureProject(scope, id, { projDays: 10, roadDays: 10 });

  const mod = await import('../semantic-insights.mjs');
  const clearFn = mod.clearProjectGatherMemo;
  assert.equal(typeof clearFn, 'function',
    'semantic-insights.mjs must export a memo-clearing function (e.g. clearProjectGatherMemo) so a '
    + 'new scan is not stuck serving a previous scan\'s cached gather within the same process');

  // First scan: memoized gather, captured for comparison.
  const first = await mod.gatherProjectCandidates(scope, id);
  assert.equal(first.length, 1);
  const firstRoadmap = first[0].roadmap;
  assert.ok(firstRoadmap.includes('DEEP-NEXT-MARKER'), 'sanity: first gather sees the fixture roadmap body');
  const firstRoadmapStaleDays = first[0].roadmapStaleDays;

  // Modify the fixture: change the roadmap content and add a fresh commit dated today.
  const roadPath = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'projects', `${id}.roadmap.md`);
  const newRoadmapBody = '## Now\n- CHANGED-NOW-ITEM\n## Next\n- FRESH-MARKER-AFTER-EDIT\n';
  await writeFile(roadPath, newRoadmapBody, 'utf8');
  await commitAt(TEST_MEMORY_ROOT, `scopes/${scope}/projects/${id}.roadmap.md`, daysAgoISO(0), 'edit roadmap for memo-invalidation test');

  // Re-gathering without clearing must still return the memoized (stale) value, even though the
  // fixture on disk has already changed — this discriminates a real memo from a no-op cache.
  const stillMemoized = await mod.gatherProjectCandidates(scope, id);
  assert.equal(stillMemoized[0].roadmap, firstRoadmap, 'without clearing, the memo must keep serving the first scan\'s (now stale) value');
  assert.equal(stillMemoized[0].roadmapStaleDays, firstRoadmapStaleDays, 'without clearing, roadmapStaleDays must also still reflect the original (stale) value');

  // Simulate a new scan: clear the memo, gather again.
  clearFn();
  const second = await mod.gatherProjectCandidates(scope, id);
  assert.equal(second.length, 1);
  assert.ok(second[0].roadmap.includes('FRESH-MARKER-AFTER-EDIT'),
    'after clearing the memo, gather must reflect the MODIFIED roadmap text, not the first scan\'s cached body');
  assert.ok(second[0].roadmap.includes('CHANGED-NOW-ITEM'), 'the new roadmap body must be the one served post-clear');
  assert.notEqual(second[0].roadmap, firstRoadmap, 'second gather must differ from the first scan\'s cached roadmap text');
  assert.ok(Math.abs(second[0].roadmapStaleDays - 0) < 1.5, 'roadmapStaleDays must reflect the fresh commit (today), not the original 10-day-old value');
  assert.notEqual(second[0].roadmapStaleDays, firstRoadmapStaleDays, 'roadmapStaleDays must change after the memo is cleared and the fixture is modified');
});

// ================================================================ E. underused-skill cap fairness

test('rankUnderusedSkillCandidates: least-recently-used (largest lastChangedDays) sorts first, not readdir/alphabetical order', () => {
  const raw = [
    { name: 'aaa-fresh', lastChangedDays: 20 },
    { name: 'zzz-stale', lastChangedDays: 500 },
    { name: 'mmm-mid', lastChangedDays: 100 },
  ];
  const ranked = rankUnderusedSkillCandidates(raw);
  assert.deepEqual(ranked.map((c) => c.name), ['zzz-stale', 'mmm-mid', 'aaa-fresh'],
    'ranking must be by descending lastChangedDays (most stale first), independent of name order');
});

test('cap fairness: with more than SKILL_JUDGE_CAP skill candidates, a stale-but-alphabetically-late skill still survives the pre-judge slice once ranked', () => {
  // Reproduce the exact bug this spec item targets: readdir/insertion order today means an
  // alphabetically-late (or filesystem-late) but heavily-stale skill can be pushed past the cap by
  // a run of fresher-but-earlier-ordered skills. Assert the FIX: rank-before-slice keeps it.
  const SKILL_JUDGE_CAP = 15;   // mirrors mechanical-insights.mjs's own constant value
  const raw = [];
  for (let i = 0; i < SKILL_JUDGE_CAP; i++) {
    raw.push({ name: `aaa-filler-${String(i).padStart(2, '0')}`, lastChangedDays: 20 + i });   // mildly stale
  }
  // alphabetically LAST, but by far the most stale (least recently used) — a naive
  // slice(0, SKILL_JUDGE_CAP) over readdir/insertion order would drop it.
  raw.push({ name: 'zzz-very-stale', lastChangedDays: 900 });

  const ranked = rankUnderusedSkillCandidates(raw);
  const toJudge = ranked.slice(0, SKILL_JUDGE_CAP);
  assert.ok(toJudge.some((c) => c.name === 'zzz-very-stale'),
    'the far-more-stale skill must survive the cap slice once the list is ranked by staleness first, '
    + 'despite sorting alphabetically/positionally last');
  assert.equal(toJudge[0].name, 'zzz-very-stale', 'the most-stale candidate must lead the post-rank, pre-cap list');
});
