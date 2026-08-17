#!/usr/bin/env node
// supersede.mjs — the human's own retirement door for a knowledge node.
//
//   node supersede.mjs <node-id> --reason "why this node stops being live" [--card <card-id>]
//
// Why this exists (MEM-8 amendment, 2026-08-17): every sanctioned node write was card-mediated.
// accept.mjs writes nodes, but only where a detector minted a card whose `on_accept` offered the
// retirement, and the card is what supplied the trail (`superseded_by: accept:<cardId>`). So a
// human who judged a node dead could act only when a detector happened to agree; a card that
// proposed "refresh" instead of "retire" left the human with no door at all. This verb is that
// door, and it keeps the property the card was there to provide: a named cause on the node.
//
// It does NOT weaken MEM-8's single-writer rule for the reconciler's own lane. Retirement is a
// mark plus a trail (the same two fields reconcile.mjs's stageSupersede and accept.mjs's `retire`
// write), never a delete: the body, the history, and the supersession chain all stay readable.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNode, writeNode, NODES_DIR, MEMORY_ROOT } from './nodes.mjs';
import { scopedCommit } from './scoped-commit.mjs';
import { tryAcquireLock, releaseLock, knowledgeTreeDirty } from './locks.mjs';

// id doubles as a filename (NODES_DIR/<id>.md), so it is validated as a slug, never joined raw.
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export async function supersedeNode(id, { reason, card, at = new Date().toISOString() } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid node id: ${JSON.stringify(id)}`);
  // The reason IS the trail: without it the node records that someone retired it, but not why,
  // which is the failure mode a bare verb would introduce. Required, not defaulted.
  if (typeof reason !== 'string' || reason.trim().length < 8) throw new Error('--reason is required (a sentence on why this node stops being live)');
  if (card !== undefined && (typeof card !== 'string' || !ID_RE.test(card))) throw new Error(`invalid card id: ${JSON.stringify(card)}`);
  // Same two fences accept.mjs raises before any node write (accept.mjs:314-322), for the same
  // reason: this verb writes the canonical tree, so it must never run against a mid-reconcile or
  // half-written one. Non-blocking — a held lock is reported, never waited on.
  if (!(await tryAcquireLock())) {
    const busy = new Error('busy: reconcile holds the lock, retry');
    busy.exitCode = 75;
    throw busy;
  }
  try {
    if (await knowledgeTreeDirty()) throw new Error('knowledge/ has uncommitted changes. Either a prior run crashed mid-write, or the tree was edited by hand. Commit the change you meant, or restore the tree, then retry.');
    let text;
    try { text = await readFile(resolve(NODES_DIR, `${id}.md`), 'utf8'); }
    catch { throw new Error(`node not found: ${id}`); }
    const node = parseNode(text, id);
    if (node.frontmatter.superseded) return { node, changed: false };   // idempotent: the corpse stays as it is

    node.frontmatter.superseded = true;
    // `human:<date>` distinguishes this lane from `accept:<cardId>` and `truth-pass:<entry>`, and
    // from a successor node id, so a later reader can tell operator judgement from a detector's.
    node.frontmatter.superseded_by = `human:${at.slice(0, 10)}`;
    node.frontmatter.superseded_reason = reason.trim();
    // Set only when the human acted on a card that offered something else; it records which card was
    // in front of them, without claiming the card authorized the retirement.
    if (card) node.frontmatter.superseded_card = card;
    node.frontmatter.updated = at;
    await writeNode(node);
    await scopedCommit(MEMORY_ROOT, `supersede: [[${id}]] retired by hand — ${reason.trim()}`, [`knowledge/nodes/${id}.md`]);
    return { node, changed: true };
  } finally {
    await releaseLock();
  }
}

// Direct run: node supersede.mjs <node-id> --reason "…" [--card <card-id>]
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const id = args.find((a) => !a.startsWith('--') && a !== flag('--reason') && a !== flag('--card'));
  try {
    const { node, changed } = await supersedeNode(id, { reason: flag('--reason'), card: flag('--card') });
    console.log(changed
      ? `superseded [[${node.id}]] (${node.frontmatter.superseded_by}) — ${node.frontmatter.superseded_reason}`
      : `[[${node.id}]] was already superseded (by ${node.frontmatter.superseded_by ?? 'unknown'}); nothing written`);
  } catch (e) {
    // 75 is accept.mjs's "reconcile holds the lock" code, kept identical so a caller can tell
    // "try again later" apart from "this was refused".
    if (e.exitCode === 75) { console.error(`supersede: ${e.message}`); process.exit(75); }
    console.error(`supersede: ${e.message}\nusage: node supersede.mjs <node-id> --reason "why this node stops being live" [--card <card-id>]`);
    process.exit(1);
  }
}
