// mem40-judge-loader.mjs — module-resolution hook (step9-judge-loader.mjs's pattern): any import
// of judge.mjs resolves to mem40-judge-mock.mjs, letting the REAL reconcile.mjs main() run offline
// for the MEM-40 source-sha re-distill / contradiction-override tests.
export async function resolve(specifier, context, next) {
  if (/(^|\/)judge\.mjs$/.test(specifier)
    && context.parentURL && !context.parentURL.includes('mem40-judge-mock')) {
    return { url: new URL('./mem40-judge-mock.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (/(^|\/)retrieval\.mjs$/.test(specifier)
    && context.parentURL && !context.parentURL.includes('mem40-retrieval-mock')) {
    return { url: new URL('./mem40-retrieval-mock.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
