// lenses.mjs — the Board's 5-lens computation, extracted from board.mjs (ATT-2 B1) so the CLI
// Board and the dashboard render ONE computation instead of two. Pure read-time logic: reads
// Project objects + the decision-log via its callers' loaders, writes nothing (ATT-1's hard wall
// unchanged — Board -> Projects and Board -> Memory stay forbidden flows).

import { listAllProjects } from './closure.mjs';
import { readDecisionLog, latestDecisions } from './decisions.mjs';

export const LENS_ORDER = ['deferral-expired', 'waiting', 'blocked', 'newly-surfaced', 'active'];
export const today = () => new Date().toISOString().slice(0, 10);

// Returns the trimmed text of a `## <heading>` body section, or '' if absent/empty (the template
// omits Standing entirely when there's nothing to report — DESIGN.md §6a.6).
export function section(body, heading) {
  const marker = `## ${heading}`;
  const idx = body.indexOf(marker);
  if (idx === -1) return '';
  const rest = body.slice(idx + marker.length);
  const next = rest.search(/\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function classify(project, entry) {
  const { frontmatter: fm, body } = project;
  const standing = section(body, 'Standing');
  const stale = entry && fm.last_understanding_change && fm.last_understanding_change > entry.ts.slice(0, 10);
  const live = stale ? null : entry;   // a stale entry is ignored entirely, not just its suppression

  if (live?.decision === 'waiting') return { lens: 'waiting', detail: `waiting on: ${live.on}` };
  if (live?.decision === 'defer') {
    const expired = live.until ? today() >= live.until : false;
    if (!expired) return null;   // suppressed — still within its window
    return { lens: 'deferral-expired', detail: live.until ? `was deferred until ${live.until}` : `was deferred on: ${live.cond}` };
  }
  if (live?.decision === 'dismiss') return null;   // suppressed

  if (standing) return { lens: 'blocked', detail: standing.split('\n')[0] };
  if (!entry) return { lens: 'newly-surfaced', detail: null };
  return { lens: 'active', detail: null };   // had a decision once, now stale, nothing else flags it
}

// The full Board computation: { lens: [{ p, detail }] }, lenses in LENS_ORDER, items sorted by
// last_understanding_change ascending (stalest first) — byte-identical grouping to the old inline
// board.mjs logic.
export async function computeBoard({ scopeFilter = null } = {}) {
  const all = await listAllProjects();
  const projects = all.filter((p) => p.frontmatter.state === 'active' && (!scopeFilter || p.scope === scopeFilter));
  const latest = latestDecisions(await readDecisionLog());

  const groups = Object.fromEntries(LENS_ORDER.map((l) => [l, []]));
  for (const p of projects) {
    const entry = latest.get(p.frontmatter.id);
    const result = classify(p, entry);
    if (result) groups[result.lens].push({ p, detail: result.detail });
  }
  for (const lens of LENS_ORDER) {
    groups[lens].sort((a, b) =>
      (a.p.frontmatter.last_understanding_change || '').localeCompare(b.p.frontmatter.last_understanding_change || ''));
  }
  return groups;
}
