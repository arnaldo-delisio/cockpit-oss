#!/usr/bin/env node
// accept.mjs — MEM-38 step 6: the ATT-3 execution contract's transaction owner. A dashboard
// "accept" on a card becomes ONE fenced transaction here: lock, dirty-tree refusal, idempotency
// check, on_accept validation + fresh preconditions, execute, status flip, per-boundary scoped
// commits (one per file written, so a crash at any boundary leaves a clean recoverable tree),
// optional detached projection refresh. The card's frontmatter `status` is the single source of
// truth; this verb is what kills the state.json overlay split-brain.
//
//   node accept.mjs accept <card-id> [--project <id>] [--dry-run]
//
// Exit codes (fixed contract, the dashboard middleware depends on them):
//   0  = applied, or a no-op (card already left `new`: idempotent success)
//   1  = refusal/error (dirty tree, unknown on_accept kind, stale preconditions + re-mint, git failure)
//   75 = busy (reconcile holds the single-writer lock; retry)
//
// Registry (step 7): ratify, unratify, retire, merge, task, doc-edit (validateOnAccept below is
// the shape authority). Every kind is idempotent (see the execute-before-flip comment below);
// unknown kinds still refuse, card untouched. `--project <id>` is the task kind's override for a
// card minted with an empty project.

import { readFile, readdir, writeFile, rename, realpath } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MEMORY_ROOT, NODES_DIR, parseNode, writeNode } from './nodes.mjs';
import { tryAcquireLock, releaseLock, knowledgeTreeDirty } from './locks.mjs';
import { INSIGHTS_DIR, writeInsightFile } from './mechanical-insights.mjs';
import { ratifyNode, unratifyNode } from './ratify.mjs';
import { writeSidecarTask } from './sidecar-tasks.mjs';
import { loadDocProposals, writeProposal } from './doc-proposals.mjs';
import { listAllProjects } from './closure.mjs';
import { gitAt, assertOwnRepo as assertOwnRepoAt, scopedCommit } from './scoped-commit.mjs';

// id doubles as a filename (INSIGHTS_DIR/<id>.md, NODES_DIR/<id>.md) — slug-validated like
// ratify's ID_RE before any path join, never joined raw.
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

// refusals throw with an exit code so the finally below ALWAYS releases the lock (process.exit
// would skip finally and leave the fence held); the CLI foot maps exitCode to the process exit.
function refuse(message, exitCode = 1) { const e = new Error(message); e.exitCode = exitCode; throw e; }

const nowISO = () => new Date().toISOString();
const today = () => nowISO().slice(0, 10);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------- target-node reads (nothing stored is trusted: hash and status are computed FRESH) ----------
async function readNodeRaw(id) {
  try { return await readFile(resolve(NODES_DIR, `${id}.md`)); } catch { return null; }
}
// The claim-relevant live state the precondition compares against `expected_status` (step 7
// producers mint the matching value): superseded and ratified dominate, else the claim tier.
function liveNodeStatus(frontmatter) {
  if (frontmatter.superseded) return 'superseded';
  if (frontmatter.ratified) return 'ratified';
  return frontmatter.claim ?? 'unknown';
}

// ---------- on_accept registry (step 7; unknown kind → refuse, card untouched) ----------
// Per-kind preconditions the card MUST carry (mint-time freshness is the only defense the
// destructive kinds get; task carries none by design, ratify's stay optional).
const REQUIRED_PRECONDITIONS = {
  retire: ['expected_node_hash', 'expected_status'],
  merge: ['expected_node_hash', 'expected_target_hash'],
  unratify: ['expected_node_hash', 'expected_status'],
  'doc-edit': ['expected_target_hash'],
};
function validateOnAccept(onAccept, cardId) {
  if (typeof onAccept !== 'object' || onAccept === null || Array.isArray(onAccept)) {
    return { error: 'on_accept is not an object' };
  }
  const idField = (f) => (typeof onAccept[f] === 'string' && ID_RE.test(onAccept[f]) ? onAccept[f] : null);
  switch (onAccept.kind) {
    case 'ratify':
    case 'unratify': {
      const node = idField('node');
      if (node === null) return { error: `on_accept.node is not a valid node id: ${JSON.stringify(onAccept.node)}` };
      if (onAccept.turn !== undefined && typeof onAccept.turn !== 'string') {
        return { error: 'on_accept.turn must be a string when present' };
      }
      return { kind: onAccept.kind, node, turn: onAccept.turn ?? `dashboard:${cardId}` };
    }
    case 'retire': {
      const node = idField('node');
      if (node === null) return { error: `on_accept.node is not a valid node id: ${JSON.stringify(onAccept.node)}` };
      return { kind: 'retire', node };
    }
    case 'merge': {
      const node = idField('node');
      const into = idField('into');
      if (node === null) return { error: `on_accept.node is not a valid node id: ${JSON.stringify(onAccept.node)}` };
      if (into === null) return { error: `on_accept.into is not a valid node id: ${JSON.stringify(onAccept.into)}` };
      if (node === into) return { error: 'on_accept merge cannot fold a node into itself' };
      return { kind: 'merge', node, into };
    }
    case 'task': {
      // the line lands verbatim on a roadmap checklist row, so it must be a single line
      if (typeof onAccept.line !== 'string' || !onAccept.line.trim() || onAccept.line.includes('\n')) {
        return { error: `on_accept.line must be a non-empty single-line string: ${JSON.stringify(onAccept.line)}` };
      }
      if (onAccept.project !== undefined && typeof onAccept.project !== 'string') {
        return { error: 'on_accept.project must be a string when present' };
      }
      return { kind: 'task', project: onAccept.project ?? '', line: onAccept.line.trim() };
    }
    case 'doc-edit': {
      const proposal = idField('proposal');
      if (proposal === null) return { error: `on_accept.proposal is not a valid proposal id: ${JSON.stringify(onAccept.proposal)}` };
      return { kind: 'doc-edit', proposal };
    }
    default:
      return { error: `unknown on_accept kind: ${JSON.stringify(onAccept.kind)}` };
  }
}

// ---------- task project resolution (the inbox's sidecar convention, never a second one:
// scopes/<scope>/projects/<id>.roadmap.md, scope from the live Project object) ----------
async function resolveTaskProject(action, override, cardId) {
  // the --project override exists ONLY for cards minted with an empty project; a producer-fixed
  // project is authoritative, so a conflicting override refuses rather than silently rerouting
  // or silently ignoring the flag (the caller must learn which project would have won).
  if (override !== undefined && action.project !== '') {
    refuse(`refused, override-not-allowed (card ${cardId} fixes project ${action.project}; drop --project) (card untouched)`);
  }
  const projectId = action.project !== '' ? action.project : (override ?? null);
  if (projectId === null) {
    refuse(`refused, project-required (task card ${cardId} has no project; retry with --project <id>) (card untouched)`);
  }
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    refuse(`refused, invalid project id: ${JSON.stringify(projectId)} (card untouched)`);
  }
  const match = (await listAllProjects()).find((p) => p.frontmatter.id === projectId && p.frontmatter.state !== 'archived');
  if (!match) refuse(`refused, project-not-found: ${projectId} (no live project with that id; card untouched)`);
  const rel = `scopes/${match.scope}/projects/${projectId}.roadmap.md`;
  return { projectId, rel, path: resolve(MEMORY_ROOT, rel) };
}

// ---------- doc-edit resolution (proposal record + containment-checked target + live hash) ----------
// An already-applied proposal short-circuits: the executed-but-not-flipped crash window must land
// on the no-op path, not on a pointless target-hash re-mint. The realpath containment check is
// defense in depth: producers must only mint doc-edit for targets inside MEMORY_ROOT, this
// refuses anything else anyway (symlinks included).
// shared by the applied-heal path and the disk resolution: a target only joins a write set as a
// sanitized repo-relative path (inside the root, never the repo metadata dir), else null
function repoRelTarget(t) {
  if (typeof t !== 'string' || !t) return null;
  const r = relative(MEMORY_ROOT, resolve(MEMORY_ROOT, t));
  return (r && !r.startsWith('..') && !isAbsolute(r) && r.split(sep)[0] !== '.git') ? r : null;
}
// the fenced block is the store's wrapping (mintDocProposal), not part of the edit: unwrap it
function unwrapDraft(body) {
  const m = body.trim().match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  const draft = m ? m[1] : body.trim();
  return draft.endsWith('\n') ? draft : `${draft}\n`;
}
async function resolveDocEdit(proposalId) {
  const proposal = (await loadDocProposals()).find((p) => p.id === proposalId) ?? null;
  if (proposal === null) refuse(`refused, doc-proposal not found: ${proposalId} (card untouched)`);
  if (proposal.frontmatter.status === 'applied') {
    // targetRel here is DETECTION scope only (which paths to porcelain-check); the applied-heal
    // verification itself trusts the HEAD baseline's target, never the disk copy's (4a' below)
    return { applied: true, proposal, targetRel: repoRelTarget(proposal.frontmatter.target) };
  }
  if (proposal.frontmatter.status !== 'new') {
    refuse(`refused, doc-proposal ${proposalId} is ${proposal.frontmatter.status} (card untouched)`);
  }
  const target = proposal.frontmatter.target;
  if (typeof target !== 'string' || !target) refuse(`refused, doc-proposal ${proposalId} has no file target (card untouched)`);
  const rootReal = await realpath(MEMORY_ROOT);
  let targetReal;
  try { targetReal = await realpath(resolve(MEMORY_ROOT, target)); }
  catch { refuse(`refused, doc-edit target missing: ${target} (card untouched)`); }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    refuse(`refused, doc-edit target outside the memory root: ${target} (card untouched)`);
  }
  // inside the root is not enough: the repo metadata dir would let an accepted edit corrupt git
  const gitReal = resolve(rootReal, '.git');
  if (targetReal === gitReal || targetReal.startsWith(gitReal + sep)) {
    refuse(`refused, doc-edit target inside the repo metadata dir: ${target} (card untouched)`);
  }
  let bytes;
  try { bytes = await readFile(targetReal); }
  catch { refuse(`refused, doc-edit target unreadable: ${target} (card untouched)`); }
  return {
    applied: false, proposal, targetPath: targetReal, targetRel: relative(rootReal, targetReal),
    targetHash: sha256(bytes), draft: unwrapDraft(proposal.body),
  };
}

// ---------- re-mint on stale preconditions ----------
// A mismatch means the world moved under the card since mint: never apply against stale
// expectations; mint a fresh card off the LIVE node state and retire the old one with a trail.
async function nextCardId(oldId) {
  const slug = oldId.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  let id = `${today()}-${slug}`;
  let i = 2;
  while (id === oldId || await fileExists(resolve(INSIGHTS_DIR, `${id}.md`))) id = `${today()}-${slug}-${i++}`;
  return id;
}
async function fileExists(p) { try { await readFile(p); return true; } catch { return false; } }

// crash-retry dedupe for the re-mint path (per-boundary commits): a prior run may have minted the
// replacement card and crashed before dismissing the old one. Before minting, scan INSIGHTS_DIR
// for a `new` card whose reminted_from names the old card AND whose expectations match the
// CURRENT live state; found means the replacement already exists, so the retry finishes the
// dismissal instead of minting a duplicate. Lineage plus still-fresh expectations is the adoption
// condition: without the reminted_from check, an UNRELATED card that happened to share the same
// action and current expectations could be adopted and wrongly wired as superseded_by. A lineage
// match with stale expectations is NOT adopted; it falls through to minting a fresh replacement
// (which also stamps reminted_from), so one old card can accumulate several lineage children over
// repeated crashes and adoption picks the one matching the live state. The sorted scan makes the
// (theoretical) multiple-fresh-children tie-break deterministic by id; left as is on purpose.
// Frontmatter is untrusted: own-key reads only (null-prototype discipline). Adoption is keyed on
// deep-equality of the WHOLE on_accept object (kind-agnostic, step 7): preconditions live outside
// on_accept and are matched against the live state separately below.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}
async function findExistingRemint(oldId, onAccept, { wantsHash, liveHash, wantsStatus, liveStatus, wantsTarget, liveTargetHash }) {
  const own = (o, k) => (o !== null && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k) ? o[k] : undefined);
  let files;
  try { files = await readdir(INSIGHTS_DIR); } catch { return null; }
  for (const f of files.sort()) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    if (id === oldId || !ID_RE.test(id)) continue;
    let fm;
    try { fm = parseNode(await readFile(resolve(INSIGHTS_DIR, f), 'utf8'), id).frontmatter; } catch { continue; }
    if (own(fm, 'status') !== 'new') continue;
    if (own(fm, 'reminted_from') !== oldId) continue;
    if (!deepEqual(own(fm, 'on_accept'), onAccept)) continue;
    if (wantsHash ? own(fm, 'expected_node_hash') !== liveHash : own(fm, 'expected_node_hash') !== undefined) continue;
    if (wantsStatus ? own(fm, 'expected_status') !== liveStatus : own(fm, 'expected_status') !== undefined) continue;
    if (wantsTarget ? own(fm, 'expected_target_hash') !== liveTargetHash : own(fm, 'expected_target_hash') !== undefined) continue;
    return id;
  }
  return null;
}

// ---------- git (pathspec-scoped commit; the assertOwnRepo/gitCommit pair this file authored
// is extracted to scoped-commit.mjs, ATT-4 step 1, so every write verb shares one
// implementation; the helpers throw plain Errors, wrapped into this file's refuse contract) ----------
async function git(args) { return gitAt(MEMORY_ROOT, args); }
async function assertOwnRepo() {
  try { await assertOwnRepoAt(MEMORY_ROOT); } catch (e) { refuse(`memory ${e.message}`); }
}
// scoped dirty check for write sets OUTSIDE knowledge/ (task sidecars, doc-edit targets,
// doc-proposals). knowledgeTreeDirty stays as is, reconcile shares it; this helper covers only
// the exact paths an action is about to write, tracked or untracked.
async function dirtyPaths(paths) {
  const { stdout } = await git(['status', '--porcelain', '--', ...paths]);
  return stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
}
async function gitCommit(message, paths) { return scopedCommit(MEMORY_ROOT, message, paths); }

// ---------- detached projection refresh ----------
// project() makes serial LLM calls; the HTTP response behind this verb must never block on it.
// Failure is reported in the log file, and the accept result names the log path.
// The detached child is NOT projection.mjs directly: projection's direct entry now takes the
// reconciler lock (exit 75 when busy), and accept still holds that lock at spawn time, so a direct
// launch would instantly lose the race. Instead we spawn our own --refresh-projection wrapper
// mode, which retries projection.mjs until the lock frees (see refreshProjectionLoop).
function spawnProjectionRefresh() {
  const log = resolve(MEMORY_ROOT, '.reconciler', 'projection-refresh.log');
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh-projection'], {
    detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);   // the child holds its own copy of the fd
  return log;
}

// ---------- internal wrapper mode: `node accept.mjs --refresh-projection` (undocumented) ----------
// Single lock owner by design: this wrapper takes NO lock itself; projection.mjs's direct entry is
// the one lock owner. The wrapper just execs it synchronously and retries on exit 75 (busy) every
// RETRY_MS for up to WINDOW_MS, logging each attempt to the projection-refresh.log it inherits as
// stdout/stderr. A give-up after the window is REPORTED in the log, never silent.
async function refreshProjectionLoop() {
  const RETRY_MS = 5_000, WINDOW_MS = 10 * 60_000;
  const projection = fileURLToPath(new URL('./projection.mjs', import.meta.url));
  const deadline = Date.now() + WINDOW_MS;
  for (let attempt = 1; ; attempt++) {
    console.log(`[${nowISO()}] projection refresh: attempt ${attempt}`);
    const code = await new Promise((done) => {
      const child = spawn(process.execPath, [projection], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('error', (e) => { console.error(`[${nowISO()}] projection spawn failed: ${e.message}`); done(1); });
      child.on('close', (c) => done(c));
    });
    if (code === 0) { console.log(`[${nowISO()}] projection refresh: done (attempt ${attempt})`); return 0; }
    if (code !== 75) { console.error(`[${nowISO()}] projection refresh: FAILED (exit ${code})`); return code ?? 1; }
    if (Date.now() + RETRY_MS > deadline) {
      console.error(`[${nowISO()}] projection refresh: GAVE UP, lock still busy after ${WINDOW_MS / 60_000} minutes (${attempt} attempts)`);
      return 75;
    }
    console.log(`[${nowISO()}] projection refresh: busy (exit 75), retrying in ${RETRY_MS / 1000}s`);
    await sleep(RETRY_MS);
  }
}

// ---------- the transaction ----------
async function acceptCard(cardId, { dryRun = false, project: projectOverride } = {}) {
  if (typeof cardId !== 'string' || !ID_RE.test(cardId)) throw new Error(`invalid card id: ${JSON.stringify(cardId)}`);

  // 1. non-blocking fence on the reconciler's single-writer lock (dry-run takes it too, to be
  //    honest about busy — a preview against a mid-reconcile tree would lie).
  if (!(await tryAcquireLock())) {
    console.error('busy: reconcile holds the lock, retry');
    process.exit(75);
  }
  try {
    // 2. dirty-tree refusal (same check reconcile uses at lock-acquire, shared via locks.mjs):
    //    never execute over a half-written canonical tree.
    if (await knowledgeTreeDirty()) {
      refuse('knowledge/ has uncommitted changes. Either a prior run crashed mid-write, or the tree was edited by hand. Commit the change you meant, or restore the tree, then retry.');
    }
    // 2b. repo-ownership guard runs BEFORE any write, not just at commit time: a misconfigured
    //     root must never leave a flipped-but-uncommitted card behind (test-pass observation).
    await assertOwnRepo();

    // 3. load the card; idempotency discriminator. `status !== 'new'` is a NO-OP SUCCESS, by
    //    design distinct from a precondition mismatch: a retry after a crash-between-execute-and-
    //    flip lands here only if the flip DID land, and a double-click lands here harmlessly.
    const cardPath = resolve(INSIGHTS_DIR, `${cardId}.md`);
    let cardText;
    try { cardText = await readFile(cardPath, 'utf8'); } catch { throw new Error(`card not found: ${cardId}`); }
    const card = parseNode(cardText, cardId);
    if (card.frontmatter.status !== 'new') {
      // heal a crash-after-flip-before-commit: the flip landed but its scoped commit may not
      // have. gitCommit skips when nothing is staged, so the healthy case stays a pure no-op.
      if (!dryRun) await gitCommit(`accept: ${cardId} applied (commit heal after crash)`, [`insights/${cardId}.md`]);
      console.log(`already ${card.frontmatter.status}, nothing to do`);
      return;
    }

    let ranOnAccept = false;
    let plan = 'flip card status to applied';

    // 4. on_accept: validate → preconditions (FRESH) → execute → (then) flip.
    if (card.frontmatter.on_accept !== undefined) {
      const action = validateOnAccept(card.frontmatter.on_accept, cardId);
      if (action.error) refuse(`refused, ${action.error} (card untouched)`);
      for (const field of REQUIRED_PRECONDITIONS[action.kind] ?? []) {
        if (card.frontmatter[field] == null) refuse(`refused, ${action.kind} requires ${field} (card untouched)`);
      }

      // 4a. per-kind context resolution, before preconditions AND before dry-run so both stay
      //     honest: task resolves its project (project-required refusal lives here), doc-edit
      //     resolves its proposal + target file (the precondition hashes the TARGET FILE).
      const taskCtx = action.kind === 'task' ? await resolveTaskProject(action, projectOverride, cardId) : null;
      const docCtx = action.kind === 'doc-edit' ? await resolveDocEdit(action.proposal) : null;

      // 4a'. write-set dirty guard, BEFORE any write. knowledgeTreeDirty (step 2) covers only
      //      knowledge/; task and doc-edit write outside it, and a pre-existing uncommitted change
      //      at those exact paths would be absorbed into the scoped commit or overwritten. The two
      //      dirty cases are opposites and must not collide: dirty write set + proposal NOT
      //      applied = someone else's edits, refuse (finding: pre-execute dirty refusal); dirty
      //      write set + proposal ALREADY applied = our own crash between writeProposal and its
      //      scoped commit, heal with the same scoped commit so the retry converges instead of
      //      refusing forever. The card's own path is exempt (the no-op heal in step 3 sweeps it).
      if (taskCtx !== null) {
        const dirty = await dirtyPaths([taskCtx.rel]);
        if (dirty.length > 0) {
          // provenance test for a dirty sidecar: a crash between writeSidecarTask and its scoped
          // commit leaves exactly ONE added row, this card's own marker line. Only that precise
          // diff may proceed (writeSidecarTask dedups on the marker, the scoped commit heals).
          // git diff HEAD covers both the unstaged and the staged-then-crashed windows; an
          // untracked sidecar has no baseline to prove provenance against, so it refuses.
          let ownResidue = false;
          try {
            const tracked = (await git(['ls-files', '--', taskCtx.rel])).stdout.trim() !== '';
            if (tracked) {
              const { stdout: diff } = await git(['diff', 'HEAD', '--', taskCtx.rel]);
              const changes = diff.split('\n').filter((l) =>
                (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')));
              ownResidue = changes.length === 1 && changes[0] === `+- [ ] ${action.line}  <!-- inbox:${cardId} -->`;
            }
          } catch { /* no HEAD or diff failure means provenance is unprovable: refuse below */ }
          if (!ownResidue) {
            refuse(`refused, uncommitted changes at ${dirty.join(', ')} (commit or clean them first; card untouched)`);
          }
        }
      }
      if (docCtx !== null) {
        const proposalRel = `doc-proposals/${action.proposal}.md`;
        const writeSet = [proposalRel, ...(docCtx.applied ? (docCtx.targetRel ? [docCtx.targetRel] : []) : [docCtx.targetRel])];
        const dirty = await dirtyPaths(writeSet);
        if (dirty.length > 0) {
          if (!docCtx.applied) {
            refuse(`refused, uncommitted changes at ${dirty.join(', ')} (commit or clean them first; card untouched)`);
          }
          // trust model: HEAD is the trusted baseline, the ONLY writer-owned delta is the applied
          // transition (status new to applied, resolved appearing, with whatever stamp the crashed
          // run minted). Re-serializing the disk copy would only prove canonical form; a
          // serializer-valid foreign edit (e.g. a retargeted `target`) would slip through, so the
          // disk copy is compared field by field against the proposal AS COMMITTED AT HEAD, and
          // the write set plus the target-byte check use the BASELINE's target, never the disk's.
          let baseRaw = null;
          try { ({ stdout: baseRaw } = await git(['show', `HEAD:${proposalRel}`])); } catch { /* refusal below */ }
          if (baseRaw === null) {
            refuse(`refused, no committed baseline for ${proposalRel} at HEAD; reconcile by hand (card untouched)`);
          }
          let base;
          try { base = parseNode(baseRaw, action.proposal); }
          catch { refuse(`refused, unparseable baseline for ${proposalRel} at HEAD; reconcile by hand (card untouched)`); }
          const baseFm = base.frontmatter, diskFm = docCtx.proposal.frontmatter;
          if (baseFm.status === 'applied') {
            refuse(`refused, ${proposalRel} is already applied at HEAD, dirty write set is foreign; reconcile by hand (card untouched)`);
          }
          const statusOk = baseFm.status === 'new' && diskFm.status === 'applied';
          const resolvedOk = baseFm.resolved == null && diskFm.resolved != null;
          const keys = new Set([...Object.keys(baseFm), ...Object.keys(diskFm)]);
          keys.delete('status'); keys.delete('resolved');
          const fieldsOk = [...keys].every((k) => deepEqual(baseFm[k], diskFm[k]));
          const bodyOk = base.body.trim() === docCtx.proposal.body.trim();
          if (!statusOk || !resolvedOk || !fieldsOk || !bodyOk) {
            refuse(`refused, uncommitted foreign changes at ${proposalRel} (only the new to applied transition may differ from HEAD; reconcile by hand, card untouched)`);
          }
          const baseTargetRel = repoRelTarget(baseFm.target);
          if (baseTargetRel === null) {
            refuse(`refused, applied doc-proposal ${action.proposal} has an unverifiable baseline target; reconcile by hand (card untouched)`);
          }
          let targetBytes = null;
          try { targetBytes = await readFile(resolve(MEMORY_ROOT, baseTargetRel)); } catch { /* refusal below */ }
          if (targetBytes === null || !targetBytes.equals(Buffer.from(unwrapDraft(base.body), 'utf8'))) {
            refuse(`refused, uncommitted foreign changes at ${baseTargetRel} (not the applied draft; reconcile by hand, card untouched)`);
          }
          if (!dryRun) {
            await gitCommit(`accept: ${cardId} doc-proposal ${action.proposal} (commit heal after crash)`, [proposalRel, baseTargetRel]);
          }
        }
      }

      // 4b. preconditions, only when the fields are present (required per kind, checked above).
      //     Hash and status are recomputed from the live files: nothing stored is trusted. An
      //     already-applied doc-edit proposal skips them (its target moved BECAUSE it applied).
      const wantsHash = card.frontmatter.expected_node_hash != null;
      const wantsStatus = card.frontmatter.expected_status != null;
      const wantsTarget = card.frontmatter.expected_target_hash != null;
      if (action.kind === 'task' && (wantsHash || wantsStatus || wantsTarget)) {
        refuse('refused, task cards carry no preconditions (card untouched)');
      }
      if ((wantsHash || wantsStatus || wantsTarget) && !docCtx?.applied) {
        let liveHash, liveStatus;
        if (wantsHash || wantsStatus) {
          const raw = await readNodeRaw(action.node);
          if (raw === null) throw new Error(`on_accept target node not found: ${action.node}`);
          liveHash = sha256(raw);
          liveStatus = liveNodeStatus(parseNode(raw.toString('utf8'), action.node).frontmatter);
        }
        let liveTargetHash;
        if (wantsTarget) {
          if (action.kind === 'merge') {
            const rawTarget = await readNodeRaw(action.into);
            if (rawTarget === null) throw new Error(`merge target node not found: ${action.into}`);
            liveTargetHash = sha256(rawTarget);
          } else {
            liveTargetHash = docCtx.targetHash;
          }
        }
        const staleHash = wantsHash && liveHash !== card.frontmatter.expected_node_hash;
        const staleStatus = wantsStatus && liveStatus !== card.frontmatter.expected_status;
        const staleTarget = wantsTarget && liveTargetHash !== card.frontmatter.expected_target_hash;
        if (staleHash || staleStatus || staleTarget) {
          // refuse + re-mint, per-boundary commits: mint the NEW card, commit it, THEN dismiss the
          // old card (supersession trail), commit it. A crash between the boundaries leaves a
          // committed replacement and the old card still `new`; the retry finds the replacement
          // via findExistingRemint (below) and finishes the dismissal instead of minting a twin.
          const staleWhat = [
            staleHash ? 'node hash moved' : null,
            staleStatus ? `status is ${liveStatus}, expected ${card.frontmatter.expected_status}` : null,
            staleTarget ? 'target hash moved' : null,
          ].filter(Boolean).join(', ');
          if (dryRun) refuse(`(--dry-run) would refuse: preconditions stale (${staleWhat}); would re-mint as ${await nextCardId(cardId)} and dismiss ${cardId}`);
          const live = { wantsHash, liveHash, wantsStatus, liveStatus, wantsTarget, liveTargetHash };
          let newId = await findExistingRemint(cardId, card.frontmatter.on_accept, live);
          if (newId === null) {
            newId = await nextCardId(cardId);
            const freshFm = {
              ...card.frontmatter,
              id: newId, status: 'new', detected: today(), resolved: null,
              reminted_from: cardId,
              ...(wantsHash ? { expected_node_hash: liveHash } : {}),
              ...(wantsStatus ? { expected_status: liveStatus } : {}),
              ...(wantsTarget ? { expected_target_hash: liveTargetHash } : {}),
            };
            await writeInsightFile(resolve(INSIGHTS_DIR, `${newId}.md`), freshFm, card.body, false);
            await gitCommit(`accept: ${cardId} preconditions stale, re-minted as ${newId}`, [`insights/${newId}.md`]);
          }
          await writeInsightFile(cardPath, { ...card.frontmatter, status: 'dismissed', resolved: nowISO(), superseded_by: newId }, card.body, false);
          await gitCommit(`accept: ${cardId} dismissed, superseded by ${newId}`, [`insights/${cardId}.md`]);
          refuse(`refused, preconditions stale (${staleWhat}); re-minted as ${newId}, ${cardId} dismissed`);
        }
      }

      if (dryRun) {
        const desc = {
          ratify: () => `ratify [[${action.node}]] (via dashboard, turn ${action.turn})`,
          unratify: () => `unratify [[${action.node}]] (retire its ratified block with a trail, via dashboard, turn ${action.turn})`,
          retire: () => `supersede [[${action.node}]] (trail accept:${cardId})`,
          merge: () => `supersede [[${action.node}]] into [[${action.into}]] (mechanical, target node untouched)`,
          task: () => `append "${action.line}" under ${taskCtx.projectId}'s roadmap ## Next`,
          'doc-edit': () => (docCtx.applied
            ? `do nothing (doc-proposal ${action.proposal} already applied)`
            : `apply doc-proposal ${action.proposal} to ${docCtx.targetRel}`),
        }[action.kind]();
        console.log(`(--dry-run) would ${desc}, flip ${cardId} to applied${card.frontmatter.project === true ? ', then start a detached projection refresh' : ''}`);
        return;
      }

      // 4c/4d. EXECUTE BEFORE the status flip, with a scoped commit at EACH boundary: execute →
      // commit the touched file(s) → flip → commit the card (step 5/6 below). on_accept kinds must
      // be idempotent, so every crash window has a deterministic retry: crash before the execute
      // commit leaves the tree dirty and the dirty-tree refusal surfaces it; crash after the
      // execute commit but before the flip finds a clean tree and a still-`new` card (the executor
      // re-runs as a no-op or, if the changed file broke a precondition, the re-mint path above
      // produces a fresh card whose accept lands on the no-op); crash after the flip but before
      // the card commit lands on the idempotency no-op path above, which re-runs the scoped card
      // commit to heal. Flip-first would strand a never-executed accept as `applied`.
      switch (action.kind) {
        case 'ratify': {
          await ratifyNode(action.node, { via: 'dashboard', turn: action.turn });
          await gitCommit(`accept: ${cardId} ratified [[${action.node}]]`, [`knowledge/nodes/${action.node}.md`]);
          plan = `ratified [[${action.node}]]`;
          break;
        }
        case 'unratify': {
          const { changed } = await unratifyNode(action.node, { via: 'dashboard', turn: action.turn });
          await gitCommit(`accept: ${cardId} unratified [[${action.node}]]`, [`knowledge/nodes/${action.node}.md`]);
          plan = changed ? `unratified [[${action.node}]]` : `[[${action.node}]] already unratified (no-op)`;
          break;
        }
        case 'retire': {
          const raw = await readNodeRaw(action.node);
          if (raw === null) throw new Error(`on_accept target node not found: ${action.node}`);
          const node = parseNode(raw.toString('utf8'), action.node);
          if (node.frontmatter.superseded) {
            plan = `[[${action.node}]] already superseded (no-op)`;
          } else {
            // reconcile.mjs stageSupersede's representation exactly (superseded: true + updated),
            // plus superseded_by as the trail naming the accepting card.
            node.frontmatter.superseded = true;
            node.frontmatter.superseded_by = `accept:${cardId}`;
            node.frontmatter.updated = nowISO();
            await writeNode(node);
            plan = `superseded [[${action.node}]] (trail accept:${cardId})`;
          }
          await gitCommit(`accept: ${cardId} superseded [[${action.node}]]`, [`knowledge/nodes/${action.node}.md`]);
          break;
        }
        case 'merge': {
          const raw = await readNodeRaw(action.node);
          if (raw === null) throw new Error(`on_accept target node not found: ${action.node}`);
          const src = parseNode(raw.toString('utf8'), action.node);
          if (src.frontmatter.superseded && src.frontmatter.superseded_by === action.into) {
            plan = `[[${action.node}]] already merged into [[${action.into}]] (no-op)`;
          } else {
            // MECHANICAL supersede only: no LLM at accept time, the content is not rewritten (git
            // and the corpse keep it) and the target node is never modified.
            // A node retired by hand (supersede.mjs, MEM-8 amendment) already carries a pointer and
            // an operator's reason. Overwriting the pointer here would leave that reason explaining
            // a supersession that no longer exists, so the old trail moves into an append-only
            // superseded_prior list first — same shape ratify.mjs uses for ratified_retired.
            if (src.frontmatter.superseded && src.frontmatter.superseded_by !== undefined) {
              const prior = Array.isArray(src.frontmatter.superseded_prior) ? src.frontmatter.superseded_prior : [];
              prior.push({
                superseded_by: src.frontmatter.superseded_by,
                ...(src.frontmatter.superseded_reason != null ? { reason: src.frontmatter.superseded_reason } : {}),
                ...(src.frontmatter.superseded_card != null ? { card: src.frontmatter.superseded_card } : {}),
                replaced: { at: nowISO(), by: `accept:${cardId}` },
              });
              src.frontmatter.superseded_prior = prior;
              delete src.frontmatter.superseded_reason;
              delete src.frontmatter.superseded_card;
            }
            src.frontmatter.superseded = true;
            src.frontmatter.superseded_by = action.into;
            src.frontmatter.updated = nowISO();
            await writeNode(src);
            plan = `superseded [[${action.node}]] into [[${action.into}]]`;
          }
          await gitCommit(`accept: ${cardId} merged [[${action.node}]] into [[${action.into}]]`, [`knowledge/nodes/${action.node}.md`]);
          break;
        }
        case 'task': {
          // writeSidecarTask's inline marker (keyed on the card id) makes the retry idempotent
          const write = await writeSidecarTask(taskCtx.path, cardId, action.line);
          if (!write.ok) refuse(`refused, sidecar write failed (${write.reason}) at ${taskCtx.rel} (card untouched)`);
          await gitCommit(`accept: ${cardId} task to ${taskCtx.projectId} roadmap`, [taskCtx.rel]);
          plan = `appended task to ${taskCtx.projectId}'s roadmap${write.deduped ? ' (already present)' : ''}`;
          break;
        }
        case 'doc-edit': {
          if (docCtx.applied) {
            plan = `doc-proposal ${action.proposal} already applied (no-op)`;
          } else {
            // the draft lands verbatim (tmp + rename, atomic), then the proposal flips to applied
            // through its own store writer; ONE scoped commit covers both files as a boundary.
            const tmp = `${docCtx.targetPath}.tmp-${process.pid}`;
            await writeFile(tmp, docCtx.draft, 'utf8');
            await rename(tmp, docCtx.targetPath);
            await writeProposal(docCtx.proposal.path, { ...docCtx.proposal.frontmatter, status: 'applied', resolved: nowISO() }, docCtx.proposal.body, false);
            await gitCommit(`accept: ${cardId} applied doc-proposal ${action.proposal} to ${docCtx.targetRel}`, [docCtx.targetRel, `doc-proposals/${action.proposal}.md`]);
            plan = `applied doc-proposal ${action.proposal} to ${docCtx.targetRel}`;
          }
          break;
        }
      }
      ranOnAccept = true;
    } else if (dryRun) {
      console.log(`(--dry-run) would flip ${cardId} to applied (no on_accept: pure status flip)`);
      return;
    }

    // 5. flip the card: status → applied, resolved = now (atomic tmp+rename via the store's writer).
    await writeInsightFile(cardPath, { ...card.frontmatter, status: 'applied', resolved: nowISO() }, card.body, false);

    // 6. scoped commit of the card alone (the node committed at its own boundary in 4c/4d).
    //    A commit failure PROPAGATES (nonzero exit via the outer catch), never swallowed.
    await gitCommit(`accept: ${cardId} applied (${plan})`, [`insights/${cardId}.md`]);
    console.log(`accepted ${cardId}: ${plan}, status applied`);

    // 7. optional projection refresh, detached: never awaited.
    if (ranOnAccept && card.frontmatter.project === true) {
      const log = spawnProjectionRefresh();
      console.log(`projection refresh started (detached; log: ${log})`);
    }
  } finally {
    // 9. the fence always lifts, even on a refusal path that throws.
    await releaseLock();
  }
}

// Run ONLY when invoked directly — importing this module must never execute a transaction.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--refresh-projection')) {
    // internal wrapper mode (spawned detached by spawnProjectionRefresh); never a transaction.
    process.exit(await refreshProjectionLoop());
  }
  const dryRun = args.includes('--dry-run');
  const pi = args.indexOf('--project');
  const project = pi >= 0 ? args[pi + 1] : undefined;
  const [verb, cardId] = args.filter((a, i) => !a.startsWith('--') && (pi < 0 || i !== pi + 1));
  if (verb !== 'accept' || !cardId) {
    console.error('usage: node accept.mjs accept <card-id> [--project <id>] [--dry-run]');
    process.exit(1);
  }
  acceptCard(cardId, { dryRun, project }).catch((e) => { console.error(`accept: ${e.message}`); process.exit(e.exitCode ?? 1); });
}
