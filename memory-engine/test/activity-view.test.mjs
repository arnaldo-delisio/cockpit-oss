// activity-view.test.mjs — the board-spine activity time-series brick.
//
// Seams pinned: grid shape/alignment (days length == every counts length), day bucketing
// against a REAL git repo minted inside the temp memory root (fixed committer dates), the
// zero-history flat line, and the scope wall (unregistered scope's projects never appear).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dayGrid, bucketCounts, composeActivityPayload, activityViewPayload } from '../activity-view.mjs';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);

// ---- pure composers ----

test('dayGrid: oldest→newest ISO dates ending on today, exact length', () => {
  const g = dayGrid(5, '2026-08-04');
  assert.deepEqual(g, ['2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
});

test('dayGrid: crosses month boundaries correctly', () => {
  const g = dayGrid(3, '2026-03-01');
  assert.deepEqual(g, ['2026-02-27', '2026-02-28', '2026-03-01']);
});

test('bucketCounts: multiple commits on one day accumulate, out-of-window dates drop', () => {
  const grid = dayGrid(3, '2026-08-04');
  const counts = bucketCounts(['2026-08-03', '2026-08-03', '2026-08-04', '2026-01-01', 'junk'], grid);
  assert.deepEqual(counts, [0, 2, 1]);
});

test('compose: shape holds — days length and every counts length match the days param', () => {
  const p = composeActivityPayload({
    days: 7,
    todayIso: '2026-08-04',
    projects: [
      { scope: 'cockpit', id: 'alpha', dates: ['2026-08-04'] },
      { scope: 'cockpit', id: 'flat', dates: [] },
    ],
  });
  assert.equal(typeof p.generatedAt, 'string');
  assert.equal(p.days.length, 7);
  for (const proj of p.projects) assert.equal(proj.counts.length, 7);
  assert.deepEqual(p.projects.find((x) => x.id === 'flat').counts, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(p.projects.find((x) => x.id === 'alpha').counts[6], 1);
});

// ---- store-backed entry point, against a real git repo in the temp memory root ----

const git = (args, dateIso) =>
  execFileP('git', ['-C', TEST_MEMORY_ROOT, ...args], {
    env: {
      ...process.env,
      ...(dateIso
        ? (() => {
            const full = dateIso.includes('T') ? dateIso : `${dateIso}T12:00:00Z`;
            return { GIT_AUTHOR_DATE: full, GIT_COMMITTER_DATE: full };
          })()
        : {}),
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t',
    },
  });

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

test('activityViewPayload: buckets real commits, flat-zeros no-history, walls unregistered scopes', async () => {
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(['cockpit']), 'utf8');
  const reg = resolve(TEST_MEMORY_ROOT, 'scopes', 'cockpit', 'projects');
  const walled = resolve(TEST_MEMORY_ROOT, 'scopes', 'demo', 'projects');
  await mkdir(reg, { recursive: true });
  await mkdir(walled, { recursive: true });

  await git(['init', '-q']);
  // alpha: two commits three days ago, one yesterday.
  await writeFile(resolve(reg, 'alpha.roadmap.md'), '# Now\n- a\n', 'utf8');
  const alphaRel = 'scopes/cockpit/projects/alpha.roadmap.md';
  await git(['add', alphaRel]);
  await git(['commit', '-q', '-m', 'c1'], daysAgo(3));
  await writeFile(resolve(reg, 'alpha.roadmap.md'), '# Now\n- a2\n', 'utf8');
  await git(['add', alphaRel]);
  await git(['commit', '-q', '-m', 'c2'], daysAgo(3));
  await writeFile(resolve(reg, 'alpha.roadmap.md'), '# Now\n- a3\n', 'utf8');
  await git(['add', alphaRel]);
  await git(['commit', '-q', '-m', 'c3'], daysAgo(1));
  // flat: exists on disk, never committed — honest all-zero line.
  await writeFile(resolve(reg, 'flat.roadmap.md'), '# Now\n', 'utf8');
  // walled: committed history in an UNREGISTERED scope — must not appear.
  await writeFile(resolve(walled, 'sneaky.roadmap.md'), '# Now\n', 'utf8');
  await git(['add', 'scopes/demo/projects/sneaky.roadmap.md']);
  await git(['commit', '-q', '-m', 'walled'], daysAgo(1));

  const p = await activityViewPayload(7);
  assert.equal(p.days.length, 7);
  assert.equal(p.days[6], today);
  assert.deepEqual(p.projects.map((x) => `${x.scope}/${x.id}`).sort(), ['cockpit/alpha', 'cockpit/flat']);

  const alpha = p.projects.find((x) => x.id === 'alpha');
  assert.equal(alpha.counts.length, 7);
  assert.equal(alpha.counts[6 - 3], 2); // two commits three days ago
  assert.equal(alpha.counts[6 - 1], 1); // one yesterday
  assert.equal(alpha.counts.reduce((a, b) => a + b, 0), 3);

  assert.deepEqual(p.projects.find((x) => x.id === 'flat').counts, new Array(7).fill(0));
});

test('activityViewPayload: non-UTC committer offset buckets by UTC day, not local day', async () => {
  // 05:00 at +14:00 on daysAgo(1) is 15:00 UTC on daysAgo(2): %cs would report the LOCAL
  // day (daysAgo(1)); the %ct→UTC path must land the commit on daysAgo(2).
  const reg = resolve(TEST_MEMORY_ROOT, 'scopes', 'cockpit', 'projects');
  await writeFile(resolve(reg, 'tz.roadmap.md'), '# Now\n- tz\n', 'utf8');
  await git(['add', 'scopes/cockpit/projects/tz.roadmap.md']);
  await git(['commit', '-q', '-m', 'tz'], `${daysAgo(1)}T05:00:00+14:00`);

  const p = await activityViewPayload(7);
  const tz = p.projects.find((x) => x.id === 'tz');
  assert.equal(tz.counts[p.days.indexOf(daysAgo(2))], 1);
  assert.equal(tz.counts[p.days.indexOf(daysAgo(1))], 0);
  assert.equal(tz.counts.reduce((a, b) => a + b, 0), 1);
});

test('activityViewPayload: a rename from an unregistered scope carries no pre-move history', async () => {
  // sneaky.roadmap.md has a commit at daysAgo(1) inside the UNREGISTERED demo scope. Move it
  // (exact rename) into the registered scope: only the post-move commit may count — renames
  // are intentionally not followed (wall), so the walled scope's activity never leaks in.
  await git(['mv', 'scopes/demo/projects/sneaky.roadmap.md', 'scopes/cockpit/projects/moved.roadmap.md']);
  await git(['commit', '-q', '-m', 'moved'], `${today}T12:00:00Z`);

  const p = await activityViewPayload(7);
  const moved = p.projects.find((x) => x.id === 'moved');
  assert.ok(moved, 'post-move file must enumerate in the registered scope');
  assert.equal(moved.counts[6], 1); // the move commit, today
  assert.equal(moved.counts[p.days.indexOf(daysAgo(1))], 0); // pre-move demo commit stays walled
  assert.equal(moved.counts.reduce((a, b) => a + b, 0), 1);

  // put the tree back so later tests see the original fixture
  await git(['mv', 'scopes/cockpit/projects/moved.roadmap.md', 'scopes/demo/projects/sneaky.roadmap.md']);
  await git(['commit', '-q', '-m', 'moved-back'], `${today}T12:00:00Z`);
});

test('activityViewPayload: a symlinked projects dir escaping the scope is walled out', async () => {
  // Register a second scope whose projects dir is a symlink into the UNREGISTERED demo
  // scope: readdir would happily traverse it, so containment (realpath compare) must skip
  // the whole scope, and the rest of the payload must stand.
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(['cockpit', 'sly']), 'utf8');
  const sly = resolve(TEST_MEMORY_ROOT, 'scopes', 'sly');
  await mkdir(sly, { recursive: true });
  await symlink(resolve(TEST_MEMORY_ROOT, 'scopes', 'demo', 'projects'), resolve(sly, 'projects'));

  const p = await activityViewPayload(7);
  assert.ok(!p.projects.some((x) => x.scope === 'sly'), 'symlinked scope leaked');
  assert.ok(!p.projects.some((x) => x.id === 'sneaky'), 'walled project id leaked');
  assert.ok(p.projects.some((x) => x.scope === 'cockpit'), 'healthy scope must survive the walled one');

  await rm(resolve(sly, 'projects'));
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(['cockpit']), 'utf8');
});

test('activityViewPayload: a symlinked roadmap file inside a legit dir is excluded', async () => {
  const reg = resolve(TEST_MEMORY_ROOT, 'scopes', 'cockpit', 'projects');
  const link = resolve(reg, 'linked.roadmap.md');
  await symlink(resolve(TEST_MEMORY_ROOT, 'scopes', 'demo', 'projects', 'sneaky.roadmap.md'), link);

  const p = await activityViewPayload(7);
  assert.ok(!p.projects.some((x) => x.id === 'linked'), 'symlinked roadmap file leaked');
  assert.ok(p.projects.some((x) => x.id === 'alpha'), 'regular files must still enumerate');

  await rm(link);
});

test('activityViewPayload: bad days param falls back to the 42-day default', async () => {
  const p = await activityViewPayload('lots');
  assert.equal(p.days.length, 42);
});
