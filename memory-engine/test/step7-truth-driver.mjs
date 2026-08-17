// step7-truth-driver.mjs, child-process driver for the MEM-38 step 7 staleness-producer tests
// (step7-producers.test.mjs). Runs the REAL truthPass() against the pool at COCKPIT_MEMORY_ROOT
// (the parent's temp root) with roots pinned INSIDE that root, so no scope has a ledger and the
// truth lanes (sweeper/confirmer judges, guardDecision) stay unreached; what runs for real is the
// rotation lane bookkeeping plus runStalenessMinting, whose judge.mjs import the parent swapped
// for the deterministic mock via --import test/step7-judge-register.mjs. composeFields still
// spawns the `claude` CLI, so the parent launches this driver with a trimmed PATH (spawn ENOENT →
// fail-soft plain mint, ratification.test.mjs's posture).
//
// Offline embedding guard, same two lines as test/setup.mjs (replicated, never weakened): embed()
// must reject instead of touching the network or a warm HF cache. The staleness fold-candidate
// lookup is cache-only by contract, so the guard never fires on the happy path.
import { env as hfEnv } from '@huggingface/transformers';
hfEnv.allowRemoteModels = false;
hfEnv.allowLocalModels = false;

import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// fail closed exactly like fixtures.mjs: never run against a real memory root.
const root = resolve(process.env.COCKPIT_MEMORY_ROOT || '.');
if (!process.env.COCKPIT_MEMORY_ROOT || !root.startsWith(resolve(tmpdir()) + '/')) {
  throw new Error('step7-truth-driver: COCKPIT_MEMORY_ROOT unset or not a temp dir');
}

const { loadPool } = await import(new URL('../nodes.mjs', import.meta.url).href);
const { truthPass } = await import(new URL('../truth-pass.mjs', import.meta.url).href);

const audit = {};
const report = await truthPass({
  pool: await loadPool(),
  scopes: ['cockpit'],
  state: {},
  audit,
  dryRun: false,
  // deps are unreachable with no ledger in `roots`; fail loudly if that premise ever breaks.
  deps: {
    guardDecision: async () => { throw new Error('step7-truth-driver: guardDecision must be unreachable (no ledger)'); },
    isAlwaysLoadEligible: () => false,
  },
  roots: { cockpitRoot: root, memoryRoot: root },
});
console.log('___REPORT___' + JSON.stringify(report));
