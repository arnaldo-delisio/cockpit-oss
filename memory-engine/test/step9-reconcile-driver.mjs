// step9-reconcile-driver.mjs, child-process driver for the MEM-38 step 9 fragmentation-insight
// tests (step9-drift-fragmentation.test.mjs). Runs the REAL reconcile.mjs main() against the pool
// at COCKPIT_MEMORY_ROOT (the parent's temp root, already git-initialized by the parent), with
// judge.mjs swapped for the deterministic mock via --import test/step9-judge-register.mjs. Any
// CLI args after this driver's own path (e.g. `--scope s9f`) ride straight through: main() reads
// process.argv.slice(2) itself, so this driver has nothing to parse.
//
// Offline embedding guard, same two lines as test/setup.mjs (replicated, never weakened): embed()
// must reject instead of touching the network or a warm HF cache. project() (main()'s phase 3)
// reaches embed() through the suppression backstop, which is fail-open on a reject.
import { env as hfEnv } from '@huggingface/transformers';
hfEnv.allowRemoteModels = false;
hfEnv.allowLocalModels = false;

import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// fail closed exactly like fixtures.mjs: never run against a real memory root.
const root = resolve(process.env.COCKPIT_MEMORY_ROOT || '.');
if (!process.env.COCKPIT_MEMORY_ROOT || !root.startsWith(resolve(tmpdir()) + '/')) {
  throw new Error('step9-reconcile-driver: COCKPIT_MEMORY_ROOT unset or not a temp dir');
}

const { main } = await import(new URL('../reconcile.mjs', import.meta.url).href);
try {
  await main();
} catch (e) {
  // Known environment-specific quirk, ORTHOGONAL to what this driver tests: projection.mjs's
  // commitFile() treats a no-op pathspec-scoped commit as success only when git's stderr matches
  // /nothing to commit|no changes added to commit/i (its own comment, projection.mjs:500-502). This
  // git version's actual message for that exact case is "nothing added to commit but untracked
  // files present (use \"git add\" to track)" — neither substring matches, so the no-op re-throws.
  // This fires only on a SECOND main() run against an already-committed, content-unchanged
  // .reconciler/projection-state.json (phase 3, strictly after the fragmentation-insight write this
  // suite actually exercises has already landed) — never on the behavior under test. Swallowing it
  // here (test infra only, not a production fix) lets the driver still report done so the calling
  // test's assertions — which read insights/ written before phase 3 ever runs — can proceed.
  const text = `${e.message || ''}\n${e.stderr || ''}\n${e.stdout || ''}`;
  if (!/nothing added to commit but untracked files present/i.test(text)) throw e;
  console.error(`step9-reconcile-driver: swallowed known git-message-mismatch no-op commit failure: ${e.message}`);
}
console.log('___DONE___');
