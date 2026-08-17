#!/usr/bin/env node
// hermes-capture.mjs — Hermes-side capture reader (B1; counterpart to capture.mjs, TOOL-6).
//
// Registered as a Hermes `on_session_end` shell hook (config.yaml). Reads the hook JSON from
// stdin (session_id + cwd; NO transcript_path — Hermes keeps conversations in state.db), pulls
// the session's turns from ~/.hermes/state.db via the built-in node:sqlite (read-only, no new
// dependency), normalizes them to entries[], and hands them to the shared brain-neutral pipeline.
//
// `on_session_end` fires per-turn (turn_finalizer.py) — like Claude's Stop — so capture is
// incremental via the same per-session cursor. Same §9 scope gate as the Claude path: an
// unmapped cwd with no #capture opt-in SKIPS, so autonomous/gateway Hermes sessions never
// auto-enroll (paperclip protection, structural).
//
// Rows are read WITHOUT the `active=1` filter (ORDER BY timestamp, id): the cursor is a count,
// and `active` flips to 0 on compaction, which would shrink the count and strand later turns
// behind a stale cursor. All-rows is append-monotonic (stable cursor) and compacted turns are
// still real memory. The reconciler dedups any compaction-summary rows downstream.
//
// FAIL-SAFE: errors swallowed to the shared error log; always exit 0 — never disrupt Hermes.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { capture, logError } from './capture-core.mjs';

const STATE_DB = resolve(homedir(), '.hermes', 'state.db');

// Hermes tool results are JSON ({"success":bool,...} | {"output":...} | {"content":...}). A tool
// error is STRUCTURAL: top-level success===false, a truthy `error` key, or is_error===true.
// (Substring scanning false-fires on legit output — verified against the live store.)
function toolErrored(content) {
  if (typeof content !== 'string' || !content) return false;
  let j; try { j = JSON.parse(content); } catch { return false; }
  if (!j || typeof j !== 'object') return false;
  return j.success === false || j.is_error === true || ('error' in j && !!j.error);
}

// Assistant text lives in one of three columns (verified against the live store, 2026-07-24;
// mirrors the dashboard's Hermes session endpoint in dashboard/vite.config.ts):
//   - content: plain text, or a JSON array of parts for multimodal turns
//   - tool_calls: JSON array of function calls; the only payload on ~80% of assistant rows
//   - codex_message_items: Codex-brain duplicate of content (never the sole carrier today,
//     but read as a fallback in case a future Hermes version stops mirroring it into content)
function assistantText(r) {
  const raw = typeof r.content === 'string' ? r.content.trim() : '';
  let text = raw;
  if (text.startsWith('[')) {
    // Multimodal: JSON array of parts ({text}|{content}|string). Some assistant rows hold
    // OTHER JSON arrays (e.g. structured rule output) — if the parts mapping yields nothing,
    // keep the raw JSON like the old reader did rather than collapsing to empty.
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        const parts = arr.map((c) => (typeof c === 'string' ? c : c?.text ?? c?.content ?? ''))
          .filter(Boolean).join('\n').trim();
        if (parts) text = parts;
      }
    } catch { /* keep raw */ }
  }
  if (!text && typeof r.codex_message_items === 'string' && r.codex_message_items.trim()) {
    try {
      const items = JSON.parse(r.codex_message_items);
      if (Array.isArray(items)) {
        text = items.flatMap((it) => it?.content ?? [])
          .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
          .filter(Boolean).join('\n').trim();
      }
    } catch { /* ignore */ }
  }
  if (typeof r.tool_calls === 'string' && r.tool_calls.trim().startsWith('[')) {
    // Summarize what the agent did (name + truncated args), like the dashboard transcript
    // view: appended after any text, or standing alone on action-only turns so capture is
    // no longer blind to them. These are SYNTHETIC action traces, marked with a literal
    // `[tool] ` prefix — not assistant prose.
    try {
      const calls = JSON.parse(r.tool_calls);
      if (Array.isArray(calls)) {
        const summary = calls.map((c) => {
          const name = c?.function?.name ?? c?.name ?? '';
          if (!name) return '';
          let args = c?.function?.arguments ?? '';
          if (typeof args !== 'string') args = JSON.stringify(args ?? '');
          args = args.replace(/\s+/g, ' ').trim();
          return args.length > 140 ? `${name} ${args.slice(0, 140)}…` : `${name} ${args}`;
        }).filter(Boolean).map((s) => `[tool] ${s}`).join('\n');
        if (summary) text = text ? `${text}\n${summary}` : summary;
      }
    } catch { /* unparseable tool_calls — no summary */ }
  }
  return text;
}

// ---------- provenance channel (MEM-38 step 2) ----------
// The channel signal is at SESSION granularity, not per-turn: `sessions.source` (verified live
// 2026-07-25 — the only observed values are `cli` (143 rows) and `subagent` (2); `user_id` is NULL
// on all 145 rows and the schema has NO column identifying a chat channel, so `hermes:telegram` is
// not derivable here and is deliberately NOT fabricated).
//
// One session-level token applies to that session's USER turns only. That role gate is also what
// handles the `[tool] ` synthetic action traces: they are appended by assistantText() and
// `tool_calls` is non-empty on assistant rows only (verified: 4852 assistant rows, 0 user/tool), so
// a truncated machine trace can never inherit `hermes:cli` structurally, not by string sniffing.
// Assistant turns, tool rows and unknown sources stay unstamped; step 3 resolves absence.
// Null-prototype: `row.source` is a column value from the Hermes sqlite file, i.e. an untrusted key.
// On a plain `{}`, a source named `toString`/`valueOf`/`constructor` reads a truthy inherited
// function, so an UNKNOWN source would be stamped as a real via (a function object, serialized into
// the node's provenance_via) instead of degrading to null the way every other unknown source does.
const SESSION_VIA = Object.assign(Object.create(null), { cli: 'hermes:cli', subagent: 'subagent' });

// FAIL-SAFE (see the header): a missing/unreadable sessions row degrades to no via, never throws.
function sessionVia(db, sessionId) {
  try {
    const row = db.prepare('SELECT source FROM sessions WHERE id = ?').get(sessionId);
    return (row && SESSION_VIA[row.source]) || null;
  } catch { return null; }
}

async function main() {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/garbled stdin */ }

  const sessionId = hook.session_id;
  if (!sessionId) return;                              // nothing to locate

  const db = new DatabaseSync(STATE_DB, { readOnly: true });
  let rows, via;
  try {
    rows = db.prepare(
      'SELECT role, content, tool_calls, codex_message_items, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp, id'
    ).all(sessionId);
    via = sessionVia(db, sessionId);                   // MEM-38 step 2
  } finally {
    db.close();
  }

  // One normalized entry per row (incl. empties / tool plumbing) so the cursor count stays stable.
  const entries = rows.map((r) => {
    const role = r.role || 'unknown';
    const isTool = role === 'tool';
    const text = isTool ? '' : (role === 'assistant' ? assistantText(r)
      : (typeof r.content === 'string' ? r.content.trim() : ''));
    return {
      role,
      via: role === 'user' && text ? via : null,        // MEM-38 step 2 (see sessionVia)
      // Don't duplicate large tool outputs in staging (raw lives in state.db) — mirror the Claude
      // path, which surfaces tool ERRORS but drops tool plumbing. User/assistant text is verbatim;
      // assistant turns fall back to codex_message_items / tool_calls (see assistantText).
      text,
      errored: isTool ? toolErrored(r.content) : false,
      ts: typeof r.timestamp === 'number' ? new Date(r.timestamp * 1000).toISOString() : '',
    };
  });

  await capture({
    entries,
    cwd: hook.cwd || process.cwd(),
    sessionId,
    event: hook.hook_event_name || 'on_session_end',
    provenance: `hermes:state.db#${sessionId}`,
    brain: 'hermes',
  });
}

// Run only when executed directly (the hook path). Importing this module (e.g. a read-only
// verification script borrowing assistantText) must never trigger a capture.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(logError).finally(() => process.exit(0));
}
