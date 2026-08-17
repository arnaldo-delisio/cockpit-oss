#!/usr/bin/env node
// ratify.mjs — MEM-38 step 5: the ratification write path. A human "yes, keep that as a rule"
// stamps the `ratified:` block onto a behavioral node; its PRESENCE is the graduation gate
// (nodes.mjs FIELD_ORDER), and projection.mjs turns it into a durable rule on the next run,
// no streak (decisions/memory-two-pool-architecture.md, build order step 5).
//
//   node ratify.mjs <node-id> --via in-session|dashboard --turn <session>:<turn>
//
// Decision 1 (ratification overrides provenance, narrows MEM-37): a `claim: reported` node is a
// source attribution and never graduates AUTOMATICALLY, but an explicit human yes overrides the
// tier. Ratification rewrites `claim` and moves the `src:` citation into `ratified.overrode`, so
// provenance is superseded with a trail, never erased. The citation must actually MOVE, not stay:
// reconcile's reclassifier (reconcile.mjs:1327) flips any `claim: fact` + `src:` citation back to
// `reported`, which would silently undo the override on the next nightly.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNode, writeNode, poolOf, NODES_DIR } from './nodes.mjs';

export const RATIFY_VIAS = ['in-session', 'dashboard'];

// id doubles as a filename (NODES_DIR/<id>.md), so it is validated as a slug, never joined raw.
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export async function ratifyNode(id, { via, turn, at = new Date().toISOString() } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid node id: ${JSON.stringify(id)}`);
  if (!RATIFY_VIAS.includes(via)) throw new Error(`--via must be one of: ${RATIFY_VIAS.join(', ')}`);
  if (typeof turn !== 'string' || !turn.includes(':')) throw new Error('--turn must be <session>:<turn> (the authored turn that ratified)');
  let text;
  try { text = await readFile(resolve(NODES_DIR, `${id}.md`), 'utf8'); }
  catch { throw new Error(`node not found: ${id}`); }
  const node = parseNode(text, id);
  // only behavioral-pool nodes can graduate: projection's ratified lane filters on isBehavioral,
  // so a ratified: block on a library node would persist but never project. Refuse before any write.
  if (poolOf(node) !== 'behavioral') throw new Error(`node ${id} is not behavioral (pool: ${poolOf(node)}); only behavioral nodes can be ratified`);
  if (node.frontmatter.superseded) throw new Error(`node ${id} is superseded; ratify its successor, not the corpse`);
  if (node.frontmatter.ratified) return { node, changed: false };   // idempotent: the first human yes stands

  const ratified = { at, via, turn };
  if (node.frontmatter.claim === 'reported') {
    ratified.overrode = {
      claim: 'reported',
      ...(node.frontmatter.citation != null ? { citation: node.frontmatter.citation } : {}),
    };
    node.frontmatter.claim = 'fact';
    delete node.frontmatter.citation;   // moved into the trail above (see header: a src: citation left in place gets reclassified back to reported)
  }
  node.frontmatter.ratified = ratified;
  node.frontmatter.updated = at;
  await writeNode(node);
  return { node, changed: true };
}

// MEM-38 step 7: the reverse write. Unratification RETIRES the ratified block instead of deleting
// it (MEM-37 keeps trails): the block moves into the ratified_retired trail (an append-only list,
// so repeated ratify/unratify cycles keep every entry) and the `ratified:` key itself is removed,
// which is exactly the signal projection's ratified lane and accept's liveNodeStatus key on
// (presence of `ratified`, MEM-38 step 5). A claim/citation override the original ratification
// performed is NOT undone here: that provenance history already lives in the retired block.
export async function unratifyNode(id, { via, turn, at = new Date().toISOString() } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid node id: ${JSON.stringify(id)}`);
  if (!RATIFY_VIAS.includes(via)) throw new Error(`--via must be one of: ${RATIFY_VIAS.join(', ')}`);
  if (typeof turn !== 'string' || !turn.includes(':')) throw new Error('--turn must be <session>:<turn> (the authored turn that unratified)');
  let text;
  try { text = await readFile(resolve(NODES_DIR, `${id}.md`), 'utf8'); }
  catch { throw new Error(`node not found: ${id}`); }
  const node = parseNode(text, id);
  if (!node.frontmatter.ratified) return { node, changed: false };   // idempotent: already unratified

  const trail = Array.isArray(node.frontmatter.ratified_retired) ? node.frontmatter.ratified_retired : [];
  trail.push({ ...node.frontmatter.ratified, retired: { at, via, turn } });
  node.frontmatter.ratified_retired = trail;
  delete node.frontmatter.ratified;
  node.frontmatter.updated = at;
  await writeNode(node);
  return { node, changed: true };
}

// Direct run:  node ratify.mjs <node-id> --via in-session|dashboard --turn <session>:<turn>
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const id = args.find((a) => !a.startsWith('--') && a !== flag('--via') && a !== flag('--turn'));
  try {
    const { node, changed } = await ratifyNode(id, { via: flag('--via'), turn: flag('--turn') });
    console.log(changed
      ? `ratified [[${node.id}]] (via ${node.frontmatter.ratified.via}, turn ${node.frontmatter.ratified.turn})${node.frontmatter.ratified.overrode ? ' (provenance overridden, trail in ratified.overrode)' : ''}`
      : `[[${node.id}]] was already ratified (${node.frontmatter.ratified.at}); nothing written`);
  } catch (e) {
    console.error(`ratify: ${e.message}\nusage: node ratify.mjs <node-id> --via in-session|dashboard --turn <session>:<turn>`);
    process.exit(1);
  }
}
