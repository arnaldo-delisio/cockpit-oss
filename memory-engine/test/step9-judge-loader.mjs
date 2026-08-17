// step9-judge-loader.mjs, module-resolution hook (step7-judge-loader.mjs's pattern): any import of
// judge.mjs resolves to step9-judge-mock.mjs, letting the REAL reconcile.mjs main() run offline
// for the MEM-38 step 9 fragmentation-insight tests.
export async function resolve(specifier, context, next) {
  if (/(^|\/)judge\.mjs$/.test(specifier)
    && context.parentURL && !context.parentURL.includes('step9-judge-mock')) {
    return { url: new URL('./step9-judge-mock.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
