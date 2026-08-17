// activity-view.mjs — per-project activity time-series for the dashboard board spine.
//
// One read-path brick, same lane as graph-view.mjs: the middleware's /__cockpit_activity
// route calls activityViewPayload instead of shelling out itself, so the logic sits in the
// engine's node --test lane. Read-only: enumerates roadmap files and reads git history from
// the nested memory repo; writes nothing.
//
// The composition (day grid + date bucketing) is pure so tests can drive it without a git
// repo; the store-backed entry point runs git via fixed-argv execFile, never a shell string.
//
// All days are UTC: the grid is UTC-midnight based, and commit timestamps come from git as
// epoch seconds (%ct) converted to the UTC calendar day here — never %cs, whose day is the
// committer's LOCAL calendar day and mis-buckets commits near offset boundaries.
//
// Scope wall: only registered scopes are enumerated (registeredScopes, same registry the
// graph wall honors), so an unregistered scope's projects never enter the payload.

import { readdir, realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MEMORY_ROOT, registeredScopes, isScopeSlug } from './paths.mjs';

const execFileP = promisify(execFile);

const DAY_MS = 24 * 60 * 60 * 1000;
const ROADMAP_SUFFIX = '.roadmap.md';

// ISO day grid, oldest → newest, ending on todayIso (UTC calendar days).
export function dayGrid(days, todayIso = new Date().toISOString().slice(0, 10)) {
  const end = Date.parse(`${todayIso}T00:00:00Z`);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

// Bucket a list of ISO dates into the grid. A Map keyed by grid dates, not a plain record:
// the keys here are our own ISO strings, but the no-id-keyed-records rule holds anyway.
// Dates outside the grid (older than the window, or malformed) are silently out of frame —
// the grid IS the frame, that is not data loss.
export function bucketCounts(dates, grid) {
  const index = new Map(grid.map((d, i) => [d, i]));
  const counts = new Array(grid.length).fill(0);
  for (const d of dates) {
    const i = index.get(d);
    if (i !== undefined) counts[i] += 1;
  }
  return counts;
}

// Pure composer. projects = [{ scope, id, dates: ISO date strings (one per commit) }].
export function composeActivityPayload({ days = 42, todayIso, projects }) {
  const grid = dayGrid(days, todayIso);
  return {
    generatedAt: new Date().toISOString(),
    days: grid,
    projects: projects.map((p) => ({ scope: p.scope, id: p.id, counts: bucketCounts(p.dates, grid) })),
  };
}

// Commit days (UTC calendar day per commit) for one path inside the memory repo.
// %ct (committer epoch seconds) then UTC conversion in JS, matching the grid's basis.
// History starts at the file's CURRENT path; renames are intentionally not followed: wall.
// --follow (at any -M threshold) carries history across a scope-boundary rename, counting an
// unregistered scope's commit dates as registered activity — and its fuzzy matching also
// cross-attributed look-alike roadmap stubs. For a weeks-scale sparkline, pre-rename history
// is not worth that leak class. A file with no history (untracked, or the repo itself
// absent) yields [] — the caller renders honest flat zeros, never an error.
async function commitDates(relPath) {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', MEMORY_ROOT, 'log', '--format=%ct', '--', relPath],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
      .map((n) => new Date(n * 1000).toISOString().slice(0, 10));
  } catch {
    return [];
  }
}

// Store-backed entry point (what the middleware calls). Per-scope failure isolation: one
// scope's readdir or git trouble skips that scope, never blanks the payload.
export async function activityViewPayload(days = 42) {
  const n = Number.isInteger(days) && days >= 1 && days <= 366 ? days : 42;
  const grid = dayGrid(n);
  const projects = [];
  // Symlink wall (Codex round 2, high): readdir follows a symlinked projects dir, so a
  // registered scope's projects -> ../unregistered/projects would leak walled project ids.
  // Containment check compares realpaths (MEMORY_ROOT itself may legitimately be a symlink,
  // e.g. tmpdir on some platforms), fail-closed: an escaping dir skips the scope.
  const rootReal = await realpath(MEMORY_ROOT).catch(() => null);
  for (const scope of registeredScopes().filter(isScopeSlug)) {
    try {
      const dir = resolve(MEMORY_ROOT, 'scopes', scope, 'projects');
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // scope has no projects dir (fresh scope): nothing to report
      }
      if (rootReal === null) continue; // no resolvable root: nothing provable, serve nothing
      const dirReal = await realpath(dir);
      if (dirReal !== resolve(rootReal, 'scopes', scope, 'projects')) continue; // escapes the wall
      for (const e of entries.filter((x) => x.name.endsWith(ROADMAP_SUFFIX)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        // Regular files only: a symlinked roadmap file points outside the scope's own dir.
        // Where the dirent type is unreliable (d_type unknown), lstat decides — lstat never
        // follows the link, so a symlink can never read as a regular file here.
        if (!e.isFile()) {
          if (e.isSymbolicLink()) continue;
          const st = await lstat(resolve(dir, e.name)).catch(() => null);
          if (!st || !st.isFile()) continue;
        }
        const dates = await commitDates(`scopes/${scope}/projects/${e.name}`);
        projects.push({ scope, id: e.name.slice(0, -ROADMAP_SUFFIX.length), counts: bucketCounts(dates, grid) });
      }
    } catch {
      /* per-scope isolation: this scope drops, the rest of the payload stands */
    }
  }
  return { generatedAt: new Date().toISOString(), days: grid, projects };
}
