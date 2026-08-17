// scope-gate.mjs — the live-scope allowlist gate (TOOL-8's surface wall), split out of
// history-search.mjs so a consumer that only needs scope classification (e.g. mechanical-insights.mjs,
// DESIGN §6a.8) doesn't transitively pull in history-search's node:sqlite dependency just to
// render a footer count (Codex review 2026-07-07: importing history-search.mjs from board.mjs
// via mechanical-insights.mjs made board.mjs's one-line footer depend on node:sqlite, outside
// memory-engine/package.json's declared Node >=20 engine range).
//
// SURFACE ALLOWLIST (agreed 2026-07-03; mirrors the MEM-14 capture scope-gate):
//   a session enters the surface ONLY if its recorded cwd maps to a live scope —
//   <repo> -> cockpit, or <repo>/scopes/<x> (deepest match first,
//   layout §6) with <x> present in memory/scopes.json.
//   * a scope-root <x> NOT in scopes.json (e.g. a confidential venture) -> HARD SKIP,
//     no sentinel override — absence from scopes.json is a deliberate wall (MEM-32).
//   * cwd outside both trees (scratch/vault/one-offs) -> unmapped (null); callers decide
//     whether an opt-in sentinel applies (history-search's own #capture check does; an
//     automated scanner like mechanical-insights.mjs has no user text to check one against, so it
//     hard-skips unmapped cwds too).
//
// Deliberately HOME-relative, not COCKPIT_MEMORY_ROOT-relative (verified 2026-07-07 against the
// live mechanism, not assumed): this gate governs the RAW TRANSCRIPT layer, which physically lives
// under $HOME/.claude, outside the memory/knowledge tree COCKPIT_MEMORY_ROOT relocates — so
// COCKPIT_MEMORY_ROOT alone cannot wall it. The transcript layer's own isolation is the later
// "MEM-32 extended to the transcript layer" amendment (DECISIONS.md, 2026-07-03): a confidential
// venture's real launcher (`claudex.<scope>` in ~/.bashrc) sets `CLAUDE_CONFIG_DIR` (relocates the
// transcript tree itself — ALL agent state, not transcript-only) TOGETHER WITH
// `COCKPIT_MEMORY_ROOT`/`COCKPIT_SCOPE`, never the latter alone — so its transcripts never land
// under the shared $HOME/.claude/projects this gate walks in the first place; this scope-gate check
// is defense-in-depth over the shared tree, not the primary isolation mechanism. The one residual
// case — a future venture using COCKPIT_MEMORY_ROOT with no CLAUDE_CONFIG_DIR — fails CLOSED here
// (its scope is absent from the shared scopes.json, so cwdScope returns 'walled': excluded, not
// leaked), which is the correct default even though it means such a venture gets no scan coverage
// of its own commands until it also gets a CLAUDE_CONFIG_DIR of its own.

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { REPO_ROOT, MEMORY_ROOT, SCOPES_ROOT } from '../../memory-engine/paths.mjs';

export const COCKPIT_DIR = REPO_ROOT;
// Single root (port layout §6): scope workspaces live INSIDE the repo tree.
// The legacy ~/scopes / ~/projects dual root is not ported; a fresh box has one root.
const SCOPE_ROOTS = [SCOPES_ROOT];

export function liveScopes() {
  try {
    const s = JSON.parse(readFileSync(resolve(MEMORY_ROOT, 'scopes.json'), 'utf8'));
    if (Array.isArray(s) && s.length) return s;
  } catch { /* private file absent (fresh clone) */ }
  return ['cockpit'];
}
const SCOPES = liveScopes();

// cwd -> live scope | 'walled' (known tree, not in scopes.json — deliberate exclusion,
// NO sentinel override) | null (unmapped — caller decides whether an opt-in sentinel applies).
// Deepest match first (layout §6, Codex finding 3): a cwd under scopes/<x> is <x>'s, never
// swallowed as 'cockpit' by the enclosing repo prefix.
export function cwdScope(cwd) {
  if (!cwd) return null;
  const c = resolve(cwd);
  for (const root of SCOPE_ROOTS) {
    if (c === root || c.startsWith(root + sep)) {
      const top = c.slice(root.length + 1).split(sep)[0];
      if (!top) break;   // scopes/ itself: falls through to the repo -> cockpit
      return SCOPES.includes(top) ? top : 'walled';
    }
  }
  if (c === COCKPIT_DIR || c.startsWith(COCKPIT_DIR + sep)) return 'cockpit';
  return null;
}
