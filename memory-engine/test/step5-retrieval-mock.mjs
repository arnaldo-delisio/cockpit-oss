// step5-retrieval-mock.mjs, retrieval.mjs with a deterministic embed(): every DISTINCT text gets
// its own one-hot basis vector, so cosine (dot of the real L2 convention) is exactly 1.0 for
// byte-identical texts and exactly 0.0 for different ones. That puts identical rule/coverage pairs
// over SUPPRESS_COS (0.6) and everything else under it, with no model, no network, no randomness.
// Everything else (contentHash, dot, caches) is the real module, imported below; the loader hook
// does not intercept this file's own import (see step5-embed-loader.mjs).
export * from '../retrieval.mjs';

const DIMS = 4096;   // far more than any scenario's distinct-text count
const dimOf = new Map();
export async function embed(texts) {
  return texts.map((t) => {
    if (!dimOf.has(t)) {
      if (dimOf.size >= DIMS) throw new Error('step5-retrieval-mock: one-hot dimensions exhausted');
      dimOf.set(t, dimOf.size);
    }
    const v = new Array(DIMS).fill(0);
    v[dimOf.get(t)] = 1;
    return v;
  });
}
