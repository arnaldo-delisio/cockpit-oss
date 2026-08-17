// step9-judge-mock.mjs — deterministic offline judge() for the MEM-38 step 9 fragmentation
// driver (step9-reconcile-driver.mjs). Same shape as step7-judge-mock.mjs: replaces judge.mjs's
// only export. Routed by CONTENT (a unique substring per prompt-builder), not call order — the
// fragmentation-insight mint fires as an unawaited (`void ...catch`) background promise
// (reconcile.mjs writeFragmentationInsight, called from mergeFragmentedCluster), so its own
// composeFields() judge() call races the main thread's next judge() call (consolidatePrompt); an
// order-indexed mock would nondeterministically hand the wrong canned reply to whichever call
// happened to land first. Content routing has no such race.
//
// STEP9_JUDGE_RESPONSES (JSON object): { distill: <array>, merge: <array>, consolidate: <array> }.
// "compose" (compose-insights.mjs's rewrite pass) always throws, exercising its documented
// fail-soft-to-{} path deliberately — never a canned reply, so a test can assert the composed_*
// fields stay absent. Anything else unaccounted for gets a firm safe default.
const responses = JSON.parse(process.env.STEP9_JUDGE_RESPONSES || '{}');
export async function judge(prompt, opts) {
  const text = String(prompt);
  if (text.includes('You are rewriting an automatically detected insight')) {
    throw new Error('step9-judge-mock: compose-insights judge() call always fails offline (fail-soft path)');
  }
  if (text.includes('SAME cluster')) return responses.merge;
  if (text.includes("CONSOLIDATOR for the")) return responses.consolidate;
  if (text.includes("distiller for the")) return responses.distill;
  return (opts && opts.json) ? [] : { stale: false };
}
