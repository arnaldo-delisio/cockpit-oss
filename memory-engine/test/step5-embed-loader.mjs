// step5-embed-loader.mjs, module-resolution hook: any import of retrieval.mjs (except the mock's
// own passthrough import) resolves to step5-retrieval-mock.mjs, which re-exports the real module
// but replaces embed() with a deterministic offline stand-in. This is the seam that lets the REAL
// project() suppression backstop run offline: projection.mjs imports embed at module scope, so no
// runtime injection point exists, and the test setup's offline guard (correctly) makes the real
// embed() reject.
export async function resolve(specifier, context, next) {
  if (/(^|\/)retrieval\.mjs$/.test(specifier)
    && context.parentURL && !context.parentURL.includes('step5-retrieval-mock')) {
    return { url: new URL('./step5-retrieval-mock.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
