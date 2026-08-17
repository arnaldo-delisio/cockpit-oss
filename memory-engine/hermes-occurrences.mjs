#!/usr/bin/env node
// hermes-occurrences.mjs — Hermes' state.db as a second raw-occurrence source (MEM-34 step 5,
// DESIGN §6a.8d, decisions/harness-self-upgrade.md). Reuses TOOL-8's (history-search) existing
// read-only access to ~/.hermes/state.db — the SHARED, non-confidential state.db; a confidential
// venture runs its own separate HERMES_HOME/state.db entirely (structural isolation, not a row-level
// allowlist — corrected post-third-Codex-pass in the design doc after the original draft overstated
// this as reusing history-search's per-row confidential-wall allowlist, which it does not have for
// Hermes queries).
//
// Deliberately its OWN leaf module, not folded into read-pass.mjs: `node:sqlite` needs Node >=22,
// but memory-engine/package.json declares >=20 — the same reason scope-gate.mjs was split out of
// history-search.mjs (Codex review 2026-07-07: board.mjs's one-line insights footer must never
// transitively require node:sqlite). mechanical-insights.mjs imports this module via a DYNAMIC import inside
// scan() only — never a static top-level import — so board.mjs's countOpenInsights() call never
// touches node:sqlite even though it imports mechanical-insights.mjs.
//
// Genuinely new work, not reuse (as the design says): messages_fts is built for full-text search,
// not structured tool-call events. This extracts the same occurrence shape Claude's JSONL tool_use
// blocks give for free, from Hermes' actual columns (messages.tool_calls, a JSON array of
// {function:{name, arguments}}) — `tool_name` (singular) on the RESULT row is coarse (`skill_view`-
// style wrappers) and NOT used here; the real per-call shape lives in tool_calls on the assistant row.
//
// Scoped v1 mapping (documented, not exhaustive): the 'terminal' tool -> kind: 'bash' (same
// normalizeBash() shape Claude's own Bash occurrences use, so the two providers are directly
// comparable once explicitly cross-provider-aggregated — not assumed now). EVERY other Hermes tool
// name (read_file, write_file, web_search, skill_view, ...) -> kind: 'mcp', shape: <hermes tool
// name> — the same "everything else is out of scope for v1" bucket Claude's own analyzeTranscript
// already uses for Read/Edit/Grep/etc. No skill-specific extraction from skill_view/skill_manage
// calls in v1 (would need its own argument-shape research) — deferred, matching the same
// don't-build-unspecified-mechanics discipline the design used elsewhere (recurring-correction's
// skill/MCP effectiveness signal, also deferred).
//
// No structured success/failure signal found on Hermes' tool-role result rows (unlike Claude's
// tool_result.is_error) — `error` is left `undefined` on every Hermes occurrence, so
// recurring-failure's `o.error === true/false` filters simply never match a Hermes occurrence today
// (neither counted as a success nor a failure). An honest, real limitation — not silently patched
// over with a guessed heuristic.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { cwdScope } from '../skills/history-search/scope-gate.mjs';

const HERMES_DB = resolve(homedir(), '.hermes', 'state.db');
const MIN_OPENER_LEN = 40;   // mirrors read-pass.mjs's analyzeTranscript threshold

function normalizeBash(command) {
  return String(command).trim().split(/\s+/).slice(0, 2).join(' ');
}

// Best-effort JSON parse — a malformed/missing tool_calls value must never crash the scan.
function tryParseJson(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export async function readHermesOccurrences(sinceMs) {
  if (!existsSync(HERMES_DB)) return { occ: [], openers: [] };
  const sinceSec = sinceMs / 1000;   // Hermes timestamps are unix seconds (history-search's own *1000 read confirms this)
  let db = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(HERMES_DB, { readOnly: true });
    const rows = db.prepare(`
      SELECT m.id, m.session_id session, m.role, m.content, m.tool_calls, m.timestamp ts, s.cwd
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.timestamp >= ? ORDER BY m.session_id, m.timestamp ASC
    `).all(sinceSec);

    const occ = [];
    const openerBySession = new Map();   // session -> opener (first qualifying user turn only)
    for (const r of rows) {
      const scope = cwdScope(r.cwd);
      if (scope === 'walled' || !scope) continue;   // hard-skip, same rule as Claude's own gate
      const tsMs = r.ts * 1000;

      if (r.role === 'user' && typeof r.content === 'string' && !openerBySession.has(r.session)) {
        const text = r.content.trim();
        if (text.length >= MIN_OPENER_LEN) {
          openerBySession.set(r.session, {
            text, ts: tsMs, scope, file: HERMES_DB, session: r.session, provider: 'hermes',
          });
        }
      }

      if (r.role !== 'assistant' || typeof r.tool_calls !== 'string') continue;
      const calls = tryParseJson(r.tool_calls);
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        const fn = call && call.function;
        if (!fn || typeof fn.name !== 'string') continue;
        if (fn.name === 'terminal') {
          const args = tryParseJson(fn.arguments);
          if (!args || typeof args.command !== 'string') continue;
          occ.push({
            kind: 'bash', shape: normalizeBash(args.command), ts: tsMs, scope,
            file: HERMES_DB, line: `msg${r.id}`, provider: 'hermes',
          });
        } else {
          occ.push({
            kind: 'mcp', shape: fn.name, ts: tsMs, scope,
            file: HERMES_DB, line: `msg${r.id}`, provider: 'hermes',
          });
        }
      }
    }
    return { occ, openers: [...openerBySession.values()] };
  } catch (err) {
    console.error(`(hermes occurrence read skipped: ${err.message})`);
    return { occ: [], openers: [] };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
