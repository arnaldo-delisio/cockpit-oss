#!/usr/bin/env node
// roadmap.mjs — the roadmap sidecar write-back verb CLI (AR-5 task-6, WORK-1; ATT-4 step 1).
//
//   node roadmap.mjs add   <project-id> "<text>" [--section now|next] [--dry-run]
//   node roadmap.mjs check <project-id> <item-index-or-match-text> [--undo] [--section now|next|done] [--dry-run]
//   node roadmap.mjs move  <project-id> <item-index-or-match-text> --to now|next|done [--section now|next|done] [--dry-run]
//
// Adds, completes, or relocates a checkbox item (`- [ ] text` / `- [x] text`) inside a Project's
// roadmap sidecar (`<scope>/projects/<id>.roadmap.md`), the file the dashboard renders. Section
// heading grammar and item-block regex must stay byte-for-byte compatible with
// `roadmapSections()` in dashboard/cockpit-middleware.ts (exact "## Now" match, "## Now Later"
// must NOT match). Every edit is a targeted splice of the raw file text; nothing outside the
// touched item block is reformatted.
//
// ATT-4 semantics change (board-rethink-design §8): `check` is an idempotent SET-DONE, no
// longer a toggle — an already-checked item is a no-op success, and unchecking takes the
// explicit `--undo` flag (already-unchecked likewise no-ops). The dashboard caller is rebuilt
// against this semantics in ATT-4 step 3. `add` appends one conventional `- [ ]` line at the
// section's body end (default next) with hygiene per §6: ≤2 sentences, ≤280 chars, optional
// `→` pointer, exact duplicate = idempotent no-op success, near-duplicate (token-set
// similarity ≥ 0.6 against any open now/next item) = refusal naming the match.
//
// Transaction contract per §8, all write verbs: the shared single-writer lock
// (locks.mjs tryAcquireLock; busy → exit 75), a stale-snapshot precondition (the file is
// hashed at parse time and re-hashed immediately before the rename; a mismatch refuses with
// exit 65 — see writeWithPrecondition), atomic tmp+rename, and ONE path-scoped commit of just
// the roadmap file after a real write. --dry-run writes and commits nothing (it still takes
// the lock, accept.mjs's honesty rule: a preview against a mid-write tree would lie).
//
// Exit codes (fixed contract): 0 = applied or no-op success; 1 = refusal/error;
// 65 = stale snapshot (the file changed under the verb; re-run); 75 = busy (lock held; retry).

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MEMORY_ROOT } from './nodes.mjs';
import { findProjectPath } from './closure.mjs';
import { tryAcquireLock, releaseLock } from './locks.mjs';
import { scopedCommit, gitAt } from './scoped-commit.mjs';
import { canonicalItemText, tokenSetSimilarity } from './item-identity.mjs';

const VERBS = ['add', 'check', 'move'];
const SECTIONS = ['now', 'next', 'done'];
const HEADINGS = { now: 'Now', next: 'Next', done: 'Done' };
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ITEM_RE = /^- \[[ x]\] .+(?:\n(?![-#]| *- \[).+)*/gm;

// add hygiene caps (§6)
const ADD_MAX_CHARS = 280;
const ADD_MAX_SENTENCES = 2;
const NEAR_DUP_THRESHOLD = 0.6;

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// refusals throw with an exit code so the finally in main() ALWAYS releases the lock
// (accept.mjs's pattern; process.exit mid-flow would skip finally and leave the fence held).
function refuse(message, exitCode = 1) { const e = new Error(message); e.exitCode = exitCode; throw e; }

function usage(msg) {
  if (msg) console.error(`roadmap: ${msg}`);
  console.error('usage: roadmap.mjs add   <project-id> "<text>" [--section now|next] [--dry-run]\n' +
    '       roadmap.mjs check <project-id> <item-index-or-match-text> [--undo] [--section now|next|done] [--dry-run]\n' +
    '       roadmap.mjs move  <project-id> <item-index-or-match-text> --to now|next|done [--section now|next|done] [--dry-run]');
  process.exit(1);
}

// Exact-heading section body span, matching cockpit-middleware.ts's roadmapSections().
// Exported (with itemsIn) for decisions.mjs's --item resolution — one parser, never two.
export function sectionSpan(text, section) {
  const m = text.match(new RegExp(`^## ${HEADINGS[section]}[ \\t]*$`, 'm'));
  if (!m || m.index === undefined) return null;
  const bodyStart = m.index + m[0].length;
  const rest = text.slice(bodyStart);
  const next = rest.search(/\n## /);
  const bodyEnd = next === -1 ? text.length : bodyStart + next;
  return { bodyStart, bodyEnd };
}

// Every item block in a section, with absolute offsets into the full file text.
export function itemsIn(text, section) {
  const span = sectionSpan(text, section);
  if (!span) return [];
  const body = text.slice(span.bodyStart, span.bodyEnd);
  const out = [];
  ITEM_RE.lastIndex = 0;
  let m;
  while ((m = ITEM_RE.exec(body))) {
    out.push({
      section,
      absStart: span.bodyStart + m.index,
      absEnd: span.bodyStart + m.index + m[0].length,
      raw: m[0],
      done: m[0].startsWith('- [x]'),
      text: m[0].slice(6).replace(/\n\s*/g, ' ').trim(),
    });
  }
  return out;
}

// Resolves <item-index-or-match-text> against candidate sections (one if --section given,
// all three otherwise), requiring exactly one hit. Refuses (not usage) — runs under the lock.
function resolveItem(text, sections, key) {
  const pool = sections.flatMap((s) => itemsIn(text, s));
  const asIndex = /^\d+$/.test(key) ? Number(key) : null;
  let hits;
  if (asIndex !== null) {
    if (sections.length !== 1) refuse('a numeric index needs an explicit --section');
    hits = pool[asIndex] !== undefined ? [pool[asIndex]] : [];
  } else {
    hits = pool.filter((it) => it.text.includes(key));
  }
  if (hits.length === 0) refuse(`no item matched "${key}"`);
  if (hits.length > 1) refuse(`"${key}" matched ${hits.length} items, be more specific or pass --section`);
  return hits[0];
}

// Stale-snapshot precondition + atomic write (§8): immediately before the rename, re-read and
// re-hash the file; a mismatch means another writer (or a raw editor) moved it since this verb
// parsed it — refuse with exit 65 (chosen as the distinct stale-snapshot code: nonzero, not 1
// = generic refusal, not 75 = busy) so callers can retry from a fresh parse. Returns true when
// bytes actually landed (false on dry-run).
async function writeWithPrecondition(path, snapshotHash, updated, dryRun) {
  if (dryRun) {
    console.log(`(--dry-run: nothing written)\n\n=== would write ${path} ===`);
    return false;
  }
  let current;
  try { current = await readFile(path, 'utf8'); } catch { refuse(`roadmap vanished at ${path}; re-run`, 65); }
  if (sha256(current) !== snapshotHash) {
    refuse(`conflict: ${path} changed on disk since this verb read it; nothing written, re-run`, 65);
  }
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, updated, 'utf8');
  await rename(tmpPath, path);   // atomic on the same filesystem
  return true;
}

// Heal the rename-landed-but-commit-missed crash window (§8): a prior run may have written the
// roadmap and died between the rename and its scoped commit, leaving durable uncommitted state
// that retries (which land on the idempotent no-op paths) would otherwise never converge. The
// heal is RESIDUE-PROOF: it commits ONLY when the working bytes are exactly what the interrupted
// identical verb would have produced from HEAD (`replay` re-applies this verb's transform to the
// HEAD bytes). Anything else — a raw-editor edit, another verb's residue — is left untouched
// with a stderr note; roadmaps are legitimately dirty mid-session, and a blanket commit here
// would absorb foreign uncommitted work.
async function healNoop(verb, id, roadmapRel, roadmapPath, dryRun, replay) {
  if (dryRun) return;
  let working;
  try { working = await readFile(roadmapPath, 'utf8'); } catch { return; }
  let head = null;
  try { ({ stdout: head } = await gitAt(MEMORY_ROOT, ['show', `HEAD:${roadmapRel}`])); }
  catch { /* file not in HEAD (or no HEAD): the replay base is unprovable */ }
  if (head !== null && working === head) return;   // clean file, nothing to heal
  let expected = null;
  if (head !== null) {
    try { expected = replay(head); } catch { /* transform not reconstructible from HEAD */ }
  }
  if (expected !== working) {
    console.error(`roadmap: ${roadmapRel} has uncommitted changes this verb did not produce; left untouched`);
    return;
  }
  const healed = await scopedCommit(MEMORY_ROOT, `roadmap: ${verb} ${id} (commit heal)`, [roadmapRel]);
  if (healed === 'committed') console.log(`roadmap: healed an uncommitted ${roadmapRel}`);
}

// Naive sentence count for the add cap: terminator runs followed by whitespace/end. Counts
// abbreviations like "e.g." as terminators — accepted slack, the cap is hygiene, not grammar.
function sentenceCount(text) {
  const stripped = text.replace(/→\s*[^\s,;]+/g, ' ');
  return (stripped.match(/[.!?]+(?=\s|$)/g) ?? []).length;
}

async function main() {
  const args = process.argv.slice(2);
  const [verb, id, key] = args;
  if (!VERBS.includes(verb)) usage(`unknown verb "${verb || ''}" (must be add|check|move)`);
  if (!id || !KEBAB.test(id)) usage('need <project-id> as a kebab-slug');
  if (key === undefined) usage(verb === 'add' ? 'need "<text>"' : 'need <item-index-or-match-text>');

  // Flags are scanned only past the fixed positionals (verb, id, key) so a positional value
  // that happens to equal "--section"/"--dry-run" etc. (arbitrary item-match text from a
  // caller) can never be mistaken for a flag.
  const flagArgs = args.slice(3);
  const flag = (name) => {
    const i = flagArgs.indexOf(`--${name}`);
    const v = i !== -1 ? flagArgs[i + 1] : null;
    return v != null && !v.startsWith('--') ? v : null;
  };
  const dryRun = flagArgs.includes('--dry-run');
  const undo = flagArgs.includes('--undo');
  const sectionFlag = flag('section');
  if (sectionFlag && !SECTIONS.includes(sectionFlag)) usage('--section must be now|next|done');
  if (verb === 'add' && sectionFlag === 'done') usage('add takes --section now|next (never done)');
  if (verb === 'move') {
    const to = flag('to');
    if (!to || !SECTIONS.includes(to)) usage('move needs --to now|next|done');
  }
  const sections = sectionFlag ? [sectionFlag] : SECTIONS;

  // add hygiene that needs no file: cheap refusals before the lock (§6).
  const addText = verb === 'add' ? key.replace(/\s+/g, ' ').trim() : null;
  if (verb === 'add') {
    if (!addText) usage('refusing an empty item');
    if (addText.length > ADD_MAX_CHARS) usage(`item too long (${addText.length} chars, cap ${ADD_MAX_CHARS}); tighten it or point to a doc with →`);
    if (sentenceCount(addText) > ADD_MAX_SENTENCES) usage(`item has more than ${ADD_MAX_SENTENCES} sentences; roadmap lines stay short, point to a doc with →`);
  }

  const projectPath = await findProjectPath(id);
  if (!projectPath) usage(`no project found with id "${id}"`);
  const projectText = await readFile(projectPath, 'utf8');
  const stateMatch = projectText.match(/^state:\s*(\S+)/m);
  if (stateMatch && stateMatch[1] !== 'active') {
    usage(`project "${id}" is not active (state: ${stateMatch[1]}), refusing to edit its roadmap`);
  }
  const roadmapPath = projectPath.replace(/\.md$/, '.roadmap.md');
  const roadmapRel = relative(MEMORY_ROOT, roadmapPath);

  // Transaction fence (§8): every write verb serializes on the shared single-writer lock.
  if (!(await tryAcquireLock())) {
    console.error('busy: another writer holds the lock, retry');
    process.exit(75);
  }
  try {
    let text;
    try { text = await readFile(roadmapPath, 'utf8'); } catch { refuse(`no roadmap sidecar for "${id}" at ${roadmapPath}`); }
    const snapshotHash = sha256(text);

    if (verb === 'add') {
      const targetSection = sectionFlag ?? 'next';
      const canonical = canonicalItemText(addText);
      // duplicate screen against OPEN (now+next) items in this project (§6): identical
      // canonical text is an idempotent no-op success; a near-duplicate refuses with the match.
      const open = [...itemsIn(text, 'now'), ...itemsIn(text, 'next')].filter((it) => !it.done);
      for (const it of open) {
        if (canonicalItemText(it.raw) === canonical) {
          await healNoop(verb, id, roadmapRel, roadmapPath, dryRun, (head) => {
            const headSpan = sectionSpan(head, targetSection);
            if (!headSpan) return null;
            const nl = headSpan.bodyEnd > 0 && head[headSpan.bodyEnd - 1] !== '\n' ? '\n' : '';
            return head.slice(0, headSpan.bodyEnd) + nl + `- [ ] ${addText}\n` + head.slice(headSpan.bodyEnd);
          });
          console.log(`roadmap: ${id} item already present in ${it.section}, no-op: ${it.text.slice(0, 60)}`);
          return;
        }
      }
      for (const it of open) {
        const sim = tokenSetSimilarity(addText, it.raw);
        if (sim >= NEAR_DUP_THRESHOLD) {
          refuse(`near-duplicate of an open ${it.section} item (similarity ${sim.toFixed(2)}): "${it.text}" — check/move that item instead, or reword`);
        }
      }
      const span = sectionSpan(text, targetSection);
      if (!span) refuse(`roadmap sidecar for "${id}" has no "## ${HEADINGS[targetSection]}" section`);
      let block = `- [ ] ${addText}\n`;
      const insertAt = span.bodyEnd;
      // Seam guard (move's lesson): a body not ending on a line boundary would fuse the lines.
      const needsLeadingNewline = insertAt > 0 && text[insertAt - 1] !== '\n';
      const updated = text.slice(0, insertAt) + (needsLeadingNewline ? '\n' : '') + block + text.slice(insertAt);
      const wrote = await writeWithPrecondition(roadmapPath, snapshotHash, updated, dryRun);
      if (wrote) await scopedCommit(MEMORY_ROOT, `roadmap: add ${id}`, [roadmapRel]);
      console.log(`roadmap: ${id} item added to ${targetSection}: ${addText.slice(0, 60)}`);
      return;
    }

    const item = resolveItem(text, sections, key);

    if (verb === 'check') {
      // Idempotent set-done (or set-open with --undo): the desired state already holding is a
      // no-op success, never a flip back — retries and double-clicks converge (§8 idempotency).
      const want = !undo;
      if (item.done === want) {
        await healNoop(verb, id, roadmapRel, roadmapPath, dryRun, (head) => {
          const it = resolveItem(head, sections, key);
          return head.slice(0, it.absStart + 3) + (want ? 'x' : ' ') + head.slice(it.absStart + 4);
        });
        console.log(`roadmap: ${id} item already ${want ? 'checked' : 'unchecked'} in ${item.section}, no-op: ${item.text.slice(0, 60)}`);
        return;
      }
      // Set the checkbox char in place: "- [ ]"/"- [x]" — index 3 is the space or 'x'.
      const updated = text.slice(0, item.absStart + 3) + (want ? 'x' : ' ') + text.slice(item.absStart + 4);
      const wrote = await writeWithPrecondition(roadmapPath, snapshotHash, updated, dryRun);
      if (wrote) await scopedCommit(MEMORY_ROOT, `roadmap: check ${id}`, [roadmapRel]);
      console.log(`roadmap: ${id} item ${want ? 'checked' : 'unchecked'} in ${item.section}: ${item.text.slice(0, 60)}`);
      return;
    }

    // move (--to was validated before the lock; see main's pre-lock block)
    const to = flag('to');
    if (to === item.section) {
      await healNoop(verb, id, roadmapRel, roadmapPath, dryRun, (head) => {
        const it = resolveItem(head, sections, key);
        // HEAD already has the item in the target section: the interrupted identical verb was a
        // no-op, so the replay is identity — cut-and-append here would model a REORDER and
        // absorb a human's uncommitted reorder as crash residue.
        if (it.section === to) return head;
        let headCutEnd = it.absEnd;
        if (head[headCutEnd] === '\n') headCutEnd += 1;
        const without = head.slice(0, it.absStart) + head.slice(headCutEnd);
        const headSpan = sectionSpan(without, to);
        if (!headSpan) return null;
        let blk = it.raw;
        if (!blk.endsWith('\n')) blk += '\n';
        const nl = headSpan.bodyEnd > 0 && without[headSpan.bodyEnd - 1] !== '\n' ? '\n' : '';
        return without.slice(0, headSpan.bodyEnd) + nl + blk + without.slice(headSpan.bodyEnd);
      });
      console.log(`roadmap: ${id} item already in ${to}, no-op`);
      return;
    }
    // Cut the item block (plus one trailing newline if present) from its source section.
    let cutEnd = item.absEnd;
    if (text[cutEnd] === '\n') cutEnd += 1;
    const withoutItem = text.slice(0, item.absStart) + text.slice(cutEnd);
    // Re-locate the target section in the mutated text and append the block at its body end.
    const targetSpan = sectionSpan(withoutItem, to);
    if (!targetSpan) refuse(`roadmap sidecar for "${id}" has no "## ${HEADINGS[to]}" section`);
    let block = item.raw;
    if (!block.endsWith('\n')) block += '\n';
    const insertAt = targetSpan.bodyEnd;
    // Guard the seam: if the target body doesn't already end on a line boundary, the moved
    // block would fuse onto the last existing line (e.g. "- [ ] existing- [ ] moved").
    const needsLeadingNewline = insertAt > 0 && withoutItem[insertAt - 1] !== '\n';
    const updated =
      withoutItem.slice(0, insertAt) + (needsLeadingNewline ? '\n' : '') + block + withoutItem.slice(insertAt);
    const wrote = await writeWithPrecondition(roadmapPath, snapshotHash, updated, dryRun);
    if (wrote) await scopedCommit(MEMORY_ROOT, `roadmap: move ${id}`, [roadmapRel]);
    console.log(`roadmap: ${id} item moved ${item.section} -> ${to}: ${item.text.slice(0, 60)}`);
  } finally {
    // the fence always lifts, even on a refusal path that throws.
    await releaseLock();
  }
}

// Run ONLY when invoked directly — importing this module must never trigger writes.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error('roadmap failed:', e.message); process.exit(e.exitCode ?? 1); });
