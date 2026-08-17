// step7-judge-loader.mjs, module-resolution hook (step5-embed-loader.mjs's pattern): any import
// of judge.mjs resolves to step7-judge-mock.mjs. This is the seam that lets the REAL
// runStalenessMinting run offline: truth-pass.mjs imports `judge` from judge.mjs at module scope
// (the documented deps.judge hook does not cover that lane), so no runtime injection point
// exists. judge-hermes.mjs / judge-claude.mjs do NOT match the pattern and stay real (unreached:
// the driver root has no ledger, so the truth lanes never call them).
export async function resolve(specifier, context, next) {
  if (/(^|\/)judge\.mjs$/.test(specifier)
    && context.parentURL && !context.parentURL.includes('step7-judge-mock')) {
    return { url: new URL('./step7-judge-mock.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
