// step7-judge-mock.mjs, judge.mjs with a deterministic offline judge() for the MEM-38 step 7
// staleness-producer tests. The staleness prompt names its subject as `NODE [[<id>]]`; the mock
// answers from the verdict map the parent test passed in STEP7_STALENESS_VERDICTS (JSON:
// { "<node-id>": <verdict object> }). Any prompt without a mapped subject gets a firm
// { stale: false }, so nothing else that might reach judge() can mint by accident.
// The real judge.mjs is NOT star-re-exported on purpose: importing it would immediately
// dynamic-import an adapter module; judge() is its only export and is fully replaced here.
export async function judge(prompt /* , opts */) {
  const id = String(prompt).match(/^NODE \[\[([a-z0-9_-]+)\]\]/m)?.[1];
  const verdicts = JSON.parse(process.env.STEP7_STALENESS_VERDICTS || '{}');
  return (id && verdicts[id]) || { stale: false };
}
