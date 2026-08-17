// truth-clear-driver.mjs, child-process driver for the re-quarantine-guard tests
// (truth-clear.test.mjs). Runs the REAL truthPass() against the pool at COCKPIT_MEMORY_ROOT
// (the parent's temp root) with roots pinned INSIDE that root, where the parent has written a
// DECISIONS.md, so the judge lanes are live. Both truth judge lanes are covered by deps.judge
// (documented override), fed from TRUTH_CLEAR_VERDICTS ({"<node-id>": <verdict object>}); the
// staleness lane's judge.mjs import is swapped for the deterministic mock via
// `--import test/step7-judge-register.mjs` (returns { stale: false }, so nothing mints).
//
// Offline embedding guard, same two lines as test/setup.mjs (replicated, never weakened).
import { env as hfEnv } from '@huggingface/transformers';
hfEnv.allowRemoteModels = false;
hfEnv.allowLocalModels = false;

import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// fail closed exactly like fixtures.mjs: never run against a real memory root.
const root = resolve(process.env.COCKPIT_MEMORY_ROOT || '.');
if (!process.env.COCKPIT_MEMORY_ROOT || !root.startsWith(resolve(tmpdir()) + '/')) {
  throw new Error('truth-clear-driver: COCKPIT_MEMORY_ROOT unset or not a temp dir');
}

const { loadPool } = await import(new URL('../nodes.mjs', import.meta.url).href);
const { truthPass } = await import(new URL('../truth-pass.mjs', import.meta.url).href);

const verdicts = JSON.parse(process.env.TRUTH_CLEAR_VERDICTS || '{}');

const audit = { modified: [], superseded: [], held: [], autoApplied: [] };
const report = await truthPass({
  pool: await loadPool(),
  scopes: ['cockpit'],
  state: {},
  audit,
  dryRun: false,
  deps: {
    // single-node prompts name their subject as `NODE [[<id>]]`; unmapped nodes get no conflict.
    judge: async (prompt) => {
      const id = String(prompt).match(/NODE \[\[([a-z0-9_-]+)\]\]/)?.[1];
      return [(id && verdicts[id]) || { id, conflict: false }];
    },
    guardDecision: async () => { throw new Error('truth-clear-driver: guardDecision must be unreachable (no second-day confirmation here)'); },
    isAlwaysLoadEligible: () => false,
  },
  roots: { cockpitRoot: root, memoryRoot: root },
});
console.log('___REPORT___' + JSON.stringify(report));
