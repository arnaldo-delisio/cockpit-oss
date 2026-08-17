// program-order.mjs — reader for the standing cross-scope ranking (ATT-4 §3), the file at
// memory/scopes/cockpit/program-order.md (one fact one home: the file IS the order, this
// module only parses and ranks, it never stores anything).
//
// File grammar (documented in the file's own header too): one entry per line,
// `- [stable-id] member, member, ...` where a member is a scope name (matches every project
// in that scope) or `scope/project-id` (matches one project). Any line not matching the
// grammar is ignored (prose, headings, blanks). Entries rank top to bottom; the FIRST entry
// matching a project wins on duplicate membership. Projects matching no entry rank after all
// matched ones, ordered by the scope hierarchy (personal, studio, cockpit) then
// project id — so every (scope, projectId) gets a total, comparator-usable rank.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MEMORY_ROOT } from './nodes.mjs';

export const PROGRAM_ORDER_PATH = resolve(MEMORY_ROOT, 'scopes', 'cockpit', 'program-order.md');

// Fallback ordering for unmatched projects (§3). Unknown scopes rank after these three.
const SCOPE_HIERARCHY = ['personal', 'studio', 'cockpit'];

const ENTRY_RE = /^- \[([a-z0-9][a-z0-9-]*)\] +(.+)$/;

// parse the grammar above → [{ id, members }], members verbatim (scope or scope/project-id).
export function parseProgramOrder(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(ENTRY_RE);
    if (!m) continue;
    const members = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (members.length) out.push({ id: m[1], members });
  }
  return out;
}

// Convenience loader; missing file → [] (every project falls to the hierarchy fallback).
export async function loadProgramOrder() {
  try { return parseProgramOrder(await readFile(PROGRAM_ORDER_PATH, 'utf8')); } catch { return []; }
}

// Total rank for one (scope, projectId): membership is project-level (a scope-name member
// matches every project in that scope), first matching entry wins. Unmatched projects rank
// after all matched ones: rank = entries.length + scopeHierarchyIndex (unknown scope ranks
// after the known four). Returns { rank, matchedEntry, projectId }; the caller's comparator
// sorts on (rank, projectId) so the unmatched tail is ordered by hierarchy then project id.
export function programRank(entries, scope, projectId) {
  const qualified = `${scope}/${projectId}`;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].members.some((mem) => mem === scope || mem === qualified)) {
      return { rank: i, matchedEntry: entries[i], projectId };
    }
  }
  const h = SCOPE_HIERARCHY.indexOf(scope);
  return { rank: entries.length + (h === -1 ? SCOPE_HIERARCHY.length : h), matchedEntry: null, projectId };
}
