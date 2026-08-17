#!/usr/bin/env node
// capture.mjs — Claude-side capture reader (B1; was the whole pipeline, now a thin reader).
//
// Registered as a Claude Code Stop / PreCompact / SessionEnd hook. Reads the hook JSON from
// stdin, turns the transcript JSONL into a normalized entries[], and hands it to the shared
// brain-neutral pipeline (capture-core.mjs). All judgment is the reconciler's (dumb capture).
//
// FAIL-SAFE: every error is swallowed (logged to global staging/.capture-errors.log) and the
// process exits 0 — capture must NEVER disrupt the session it observes.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, logError } from './capture-core.mjs';

// ---------- Claude transcript shape: content = string | block[] (formats drift — never throw) ----------
function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('\n').trim();
  }
  return '';
}
function hasToolError(content) {
  return Array.isArray(content)
    && content.some((b) => b && b.type === 'tool_result' && b.is_error === true);
}

// ---------- provenance channel (MEM-38 step 2) ----------
// The transcript records the channel a user turn arrived through; capture discarded it until now.
// Verified against ~/.claude/projects (2026-07-25): a human keystroke carries
// `origin: { kind: 'human' }` + `promptSource: 'typed'`; hook/system injections carry
// `origin.kind: 'task-notification'` with `promptSource: 'system'`; tool_result records (the bulk
// of `type: user` lines) carry NEITHER field; sidechain records carry `isSidechain: true`.
//
// Only two tokens are derivable here; everything else stays unstamped, and step 3 resolves absence.
// Gated on `text` so a tool_result-only record (no prose, surfaced only when it errored) never
// carries a channel: a machine trace is not an authored turn.
//
// FAIL-SAFE (see the header): these fields drift across Claude Code versions, so every read is
// defensive. A missing, renamed or garbled field yields no via, never a throw.
export function viaOf(e, role, text) {
  try {
    if (role !== 'user' || !text) return null;
    if (e.isSidechain) return 'subagent';
    const kind = e.origin && typeof e.origin === 'object' ? e.origin.kind : null;
    if (kind === 'human' && e.promptSource === 'typed') return 'claude:typed';
    return null;
  } catch { return null; }
}

async function main() {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/garbled stdin */ }

  const tpath = hook.transcript_path;
  if (!tpath || !existsSync(tpath)) return;            // nothing to capture

  // One normalized entry per parsed transcript line (incl. empties) so the cursor count is stable.
  const lines = readFileSync(tpath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const ln of lines) {
    let e; try { e = JSON.parse(ln); } catch { continue; }   // skip bad line
    const role = (e.message && e.message.role) || e.type || 'unknown';
    const content = e.message ? e.message.content : undefined;
    const text = textOf(content);
    entries.push({ role, text, errored: hasToolError(content), ts: e.timestamp || '', via: viaOf(e, role, text) });
  }

  await capture({
    entries,
    cwd: hook.cwd || process.cwd(),
    sessionId: hook.session_id,
    event: hook.hook_event_name || 'Unknown',
    provenance: tpath,
    brain: 'claude',
  });
}

// Run only when executed directly (the hook path, registered with an absolute path in
// settings.json — hooks/settings.template.json:62). Importing this module (the MEM-38 step 2 tests
// exercise viaOf) must never trigger a capture. Same guard as hermes-capture.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(logError).finally(() => process.exit(0));
}
