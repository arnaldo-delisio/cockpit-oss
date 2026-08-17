// step5-driver.mjs, child-process driver for the MEM-38 step 5 tests (ratification.test.mjs).
// Runs the REAL project() against the pool at COCKPIT_MEMORY_ROOT (set by the parent test to its
// own temp root) and prints the audit as one JSON line. It exists because the non-dry-run card
// minting paths call judge()/composeFields(), which spawn the `claude` CLI: the parent launches
// this driver with a trimmed PATH (no `claude`) and HOME pointed inside the temp root, so every
// judge call fails FAST (spawn ENOENT) and side effects (ensureReconcilerHome) stay in the temp
// root. It deliberately does NOT import test/setup.mjs: setup mints a fresh root, and the parent
// needs this child to run against the root it already seeded.
//
// Offline embedding guard, same two lines as test/setup.mjs (replicated, never weakened): embed()
// must reject instead of touching the network or a warm HF cache.
import { env as hfEnv } from '@huggingface/transformers';
hfEnv.allowRemoteModels = false;
hfEnv.allowLocalModels = false;

import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// fail closed exactly like fixtures.mjs: never run against a real memory root.
const root = resolve(process.env.COCKPIT_MEMORY_ROOT || '.');
if (!process.env.COCKPIT_MEMORY_ROOT || !root.startsWith(resolve(tmpdir()) + '/')) {
  throw new Error('step5-driver: COCKPIT_MEMORY_ROOT unset or not a temp dir');
}

const opts = JSON.parse(process.argv[2] || '{}');
const { loadPool } = await import(new URL('../nodes.mjs', import.meta.url).href);
const { project } = await import(new URL('../projection.mjs', import.meta.url).href);
const audit = await project(await loadPool(), { dryRun: !!opts.dryRun });

// hostile-key hygiene report: any own property the run left on shared prototypes.
const WATCH = ['rule', 'source', 'sourceHash', 'hash', 'insight', 'at', 'door', 'judged'];
const polluted = WATCH.filter((k) => Object.prototype.hasOwnProperty.call(Object.prototype, k));
console.log('___AUDIT___' + JSON.stringify({ audit, polluted }));
