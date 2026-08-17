#!/usr/bin/env node
// recall-hook.mjs — Claude-side ambient-recall reader (OPEN-9; counterpart to capture.mjs).
//
// Registered as a Claude Code `UserPromptSubmit` hook. Reads the hook JSON from stdin
// ({ prompt, cwd, session_id, ... }), asks the brain-neutral recall() core for a relevant
// memory block, and — if there is one — emits it as `additionalContext` so it rides into the
// model's context for THIS turn. Read-only: recall() never writes the graph (MEM-8/9).
//
// FOOTER CONTRACT: the injected block ends with a rendering instruction asking the model to
// append a short visible footer of the surfaced node titles/ids (see recall.mjs). Keep that
// contract intact: the footer is what ties in-turn feedback on recalled memories (graded via
// the stop-hook capture path, #good/#bad) back to the nodes that were actually surfaced.
//
// FAIL-SAFE (load-bearing): a UserPromptSubmit hook that exits 2 (or prints to stderr) BLOCKS the
// user's prompt. Recall is a non-essential enhancement — every error is swallowed and we exit 0
// emitting nothing, so a broken recall path can never disrupt or block the session it observes.

import { readFileSync } from 'node:fs';
import { recall } from './recall.mjs';
import { logError } from './capture-core.mjs';   // shared silent error log (memory/scopes/global/staging/)

async function main() {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }   // no/garbled stdin -> silent

  const { block } = await recall({
    prompt: hook.prompt || '',
    cwd: hook.cwd || process.cwd(),
    sessionId: hook.session_id,
  });
  if (!block) return;                                                       // nothing cleared the floor -> stay silent

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: block },
  }));
}

main().catch(logError).finally(() => process.exit(0));   // ALWAYS exit 0 — recall must never block a prompt
