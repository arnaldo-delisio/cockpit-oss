// mem40-retrieval-mock.mjs — offline stand-in for retrieval.mjs's embedding surface, installed by
// mem40-judge-loader.mjs for the MEM-40 driver runs only. Needed because the consolidation test
// actually MINTS a node, and reconcile.mjs's PHASE-1 write path re-embeds touched nodes through an
// unguarded syncCache() call (reconcile.mjs ~line 1334) — the real embed() rejects by design
// offline (test/setup.mjs disables both model sources), which crashed the whole driver. Everything
// except embed/syncCache is the REAL module (star re-export; local exports shadow the star), so
// cache format, contentHash and search plumbing stay production code. Vectors are zeros: nothing
// in these tests asserts on similarity, only on write-backs and prompts.
export * from '../retrieval.mjs';
import { contentHash } from '../retrieval.mjs';

export async function embed(texts) { return texts.map(() => new Float32Array(384)); }

// real syncCache closes over the real embed internally, so it must be re-implemented, not wrapped.
export async function syncCache(nodes, cache) {
  for (const n of nodes) {
    if (!cache.get(n.id, contentHash(n.prose))) cache.set(n.id, contentHash(n.prose), new Float32Array(384));
  }
  cache.prune(nodes.map((n) => n.id));
  return cache;
}
