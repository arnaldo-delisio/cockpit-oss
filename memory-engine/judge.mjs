// judge.mjs — per-tier adapter router; exports judge() and MODEL_BY_TIER for the engine's passes.
//
// ROUTING (default, no JUDGE_ADAPTER set):
//   tier 'hard'       -> judge-hermes.mjs  (Codex via `hermes -z`)
//   tier 'bulk'       -> judge-claude.mjs  (Claude Code CLI)
//   tier 'mechanical' -> judge-claude.mjs  (only the Claude adapter wires this tier)
//
// WHY the hard tier is not on the Claude adapter [2026-08-15]: judge-claude.mjs passes
// --system-prompt to own the identity slot, and that flag raises the model's emission threshold, so
// thin material distills to an empty array (measured 8 empty of 8 on the demo content; see
// decisions/model-routing-and-cost.md). Dropping the flag restores yield but puts the Claude Code
// builder persona back in the identity slot. The Hermes adapter owns a genuinely neutral identity
// slot and distills the same material reliably, so hard-tier work routes there.
//
// OVERRIDE: JUDGE_ADAPTER=hermes|claude forces ONE adapter for every tier, tier validation included.
// dream.sh exports JUDGE_ADAPTER=hermes and therefore behaves exactly as before.
//
// NO SILENT FALLBACK: when the hard tier cannot reach Hermes, judge() throws with a message naming
// what is missing. Falling back to the Claude adapter would return an empty array, which reads as a
// successful run that distilled nothing, the exact failure this routing exists to end. A caller that
// wants that trade must ask for it explicitly with JUDGE_ADAPTER=claude.

import { access, constants } from 'node:fs/promises';
import { resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';

import * as claudeAdapter from './judge-claude.mjs';
import * as hermesAdapter from './judge-hermes.mjs';

const HERMES_AUTH = resolve(homedir(), '.hermes', 'auth.json');   // Codex OAuth store judge-hermes.mjs links to

const FORCED = process.env.JUDGE_ADAPTER === 'hermes' ? hermesAdapter
  : process.env.JUDGE_ADAPTER === 'claude' ? claudeAdapter
  : null;

// Null-prototype: `tier in ADAPTER_BY_TIER` is a presence test on a caller-supplied key.
const ADAPTER_BY_TIER = Object.assign(Object.create(null), {
  hard: hermesAdapter,
  bulk: claudeAdapter,
  mechanical: claudeAdapter,
});

// The model each tier actually runs on under the effective routing. attention-nightly.mjs reports
// from this map, so it has to follow the same rule the dispatch does.
export const MODEL_BY_TIER = FORCED
  ? FORCED.MODEL_BY_TIER
  : Object.assign(Object.create(null), Object.fromEntries(
      Object.keys(ADAPTER_BY_TIER)
        .filter((t) => t in ADAPTER_BY_TIER[t].MODEL_BY_TIER)
        .map((t) => [t, ADAPTER_BY_TIER[t].MODEL_BY_TIER[t]]),
    ));

async function onPath(bin) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try { await access(resolve(dir, bin), constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

// Preflight for the Hermes-routed tiers. Cached only on success, so a fixed install is picked up by
// the next call without restarting the process.
let _hermesOk = null;
async function assertHermesUsable(tier) {
  if (_hermesOk) return;
  const missing = [];
  if (!(await onPath('hermes'))) missing.push('the `hermes` binary is not on PATH');
  try { await access(HERMES_AUTH, constants.R_OK); }
  catch { missing.push(`the Codex login store ${HERMES_AUTH} is missing or unreadable`); }
  if (missing.length) {
    throw new Error(
      `judge: tier "${tier}" routes through the Hermes adapter and it is not usable: ${missing.join('; ')}. `
      + 'Install Hermes and log in to the Codex CLI (INSTALL.md prerequisites). '
      + 'Not falling back to the Claude adapter: its hard tier returns an empty result on thin material, '
      + 'which looks like a successful run that distilled nothing. '
      + 'To take that trade deliberately, set JUDGE_ADAPTER=claude.',
    );
  }
  _hermesOk = true;
}

// judge(prompt, { tier, json, retries, timeoutMs }) -> parsed object (json) | string (text)
export async function judge(prompt, opts = {}) {
  const { tier = 'hard' } = opts;
  if (FORCED) return FORCED.judge(prompt, opts);
  const adapter = ADAPTER_BY_TIER[tier];
  if (!adapter) throw new Error(`judge: unknown tier "${tier}"`);
  if (adapter === hermesAdapter) await assertHermesUsable(tier);
  return adapter.judge(prompt, opts);
}
