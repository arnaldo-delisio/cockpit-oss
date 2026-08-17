// fixtures.mjs — temp-dir memory pool for tests. Nodes go through the REAL writeNode/loadPool,
// so a fixture pool is byte-identical to an on-disk one (nodes.mjs §FIELD_ORDER).
//
// The temp root is minted by the `test/setup.mjs` preload, not here: the engine resolves
// MEMORY_ROOT at import time (paths.mjs:17), so setting it from a module body would only hold
// while no engine module sits earlier in source order. This module validates it and fails closed
// — a test process without the preload must die, never fall through to the real memory repo.

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as engine from '../nodes.mjs';

export { engine };

export const TEST_MEMORY_ROOT = resolve(process.env.COCKPIT_MEMORY_ROOT || '.');
if (!process.env.COCKPIT_MEMORY_ROOT || !TEST_MEMORY_ROOT.startsWith(resolve(tmpdir()) + '/')) {
  throw new Error('fixtures.mjs: COCKPIT_MEMORY_ROOT unset or not a temp dir — run via `npm test` (needs the --import ./test/setup.mjs preload)');
}

// a node in canonical shape; `id` doubles as filename and [[wikilink]] target.
export function makeNode({
  id,
  title = id,
  type = 'knowledge',
  claim = 'principle',
  scope = 'cockpit',
  citation,
  centrality = 0.5,
  body = `Fixture prose for ${id}.`,
  ...rest
} = {}) {
  if (!id) throw new Error('makeNode: id is required');
  return {
    id,
    frontmatter: { id, title, type, claim, scope, centrality, ...(citation ? { citation } : {}), ...rest },
    body,
  };
}

// normalize a `turns` spec into the SHAPE read-pass.mjs:buildDigest actually emits: a plain object
// keyed by the ORIGINAL turn index, SPARSE (only digest-selected turns appear), values { text, via }.
// It is not an array, and its keys are not dense from 0 — a fixture that used an array hid exactly
// the case where `source_turns` points at a turn the digest dropped (`turnIndex[i]` undefined).
// Ergonomics preserved: an array is still accepted and means "turns 0..n-1 all survived"; an object
// lets a test place turns at their real indices and leave holes.
function toTurnIndex(turns) {
  const entries = Array.isArray(turns)
    ? turns.map((t, i) => [i, t])
    : Object.entries(turns || {}).map(([k, t]) => [Number(k), t]);
  const turnIndex = {};
  for (const [i, t] of entries) turnIndex[i] = typeof t === 'string' ? { text: t, via: null } : t;
  return turnIndex;
}

// a distiller proposal in the shape applyConsolidation consumes. `turns` is the work-unit's
// turnIndex as MEM-38 step 2 emits it: `{ text, via }` per turn, `via` null when unstamped.
export function makeProposal({
  idx = 0,
  title = `Proposal ${idx}`,
  type = 'knowledge',
  prose = `Proposed prose ${idx}.`,
  cluster = 'unclustered',
  centrality = 0.5,
  turns = [],
  turnIndex = toTurnIndex(turns),
  source_turns = Object.keys(turnIndex).map((i) => `#${i}`),
  isSource = false,
  anchor = 'sessions/2026-07-25',
  brain = 'claude',
  ...rest
} = {}) {
  return {
    idx, title, type, prose, cluster, centrality, tags: [], entities: {}, source_turns,
    _wu: { isSource, anchor, brain, turnIndex },
    ...rest,
  };
}

// write nodes (specs or already-built nodes) into the temp pool; returns the written nodes.
export async function writePool(specs) {
  const nodes = specs.map(s => (s.frontmatter ? s : makeNode(s)));
  for (const n of nodes) await engine.writeNode(n);
  return nodes;
}
