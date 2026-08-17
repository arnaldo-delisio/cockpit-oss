#!/usr/bin/env node
// recall-hermes.mjs — Hermes-side ambient-recall reader (OPEN-9; counterpart to recall-hook.mjs).
//
// Registered as a Hermes `pre_llm_call` shell hook (config.yaml) — the operator-brain analogue of
// Claude's UserPromptSubmit. Verified against the Hermes source (agent/shell_hooks.py,
// hermes_cli/plugins.py):
//   • pre_llm_call is the ONLY hook whose return MUTATES context (plugins.py VALID_HOOKS + :1666).
//   • stdin payload  (shell_hooks.py _serialize_payload):
//        { hook_event_name, session_id, cwd, tool_name, tool_input, extra: { user_message, ... } }
//     the current user turn arrives as `extra.user_message` (non-top-level kwarg -> `extra`).
//   • stdout contract (shell_hooks.py:47-48, 535-536; plugins.py:1669-1673): print
//        { "context": "<text>" }
//     and Hermes injects <text> into the USER message of this turn (never the system prompt —
//     preserves the prompt-cache prefix). Any other / empty JSON = silent no-op.
//
// Same brain-neutral core as the Claude reader: recall() does the gate + floor + dedup + budget,
// READ-ONLY (never writes the graph — MEM-8/9; decoupled from capture — TOOL-6). The Hermes cwd
// drives the SAME scope gate as the Hermes capture reader, so recall and capture agree on scope.
//
// FAIL-SAFE: every error is swallowed; we exit 0 emitting nothing — recall must never disrupt a
// Hermes turn.

import { readFileSync } from 'node:fs';
import { recall } from './recall.mjs';
import { logError } from './capture-core.mjs';

async function main() {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }     // no/garbled stdin -> silent
  if (hook.hook_event_name && hook.hook_event_name !== 'pre_llm_call') return;  // wrong event -> silent

  const extra = hook.extra || {};
  const prompt = extra.user_message || extra.prompt || '';
  if (!prompt) return;

  const { block } = await recall({
    prompt,
    cwd: hook.cwd || process.cwd(),
    sessionId: hook.session_id,
  });
  if (!block) return;                                                       // nothing cleared the floor

  process.stdout.write(JSON.stringify({ context: block }));                 // Hermes injects into the user turn
}

main().catch(logError).finally(() => process.exit(0));   // ALWAYS exit 0 — recall must never disrupt a turn
