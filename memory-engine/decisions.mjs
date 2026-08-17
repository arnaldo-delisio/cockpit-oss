#!/usr/bin/env node
// decisions.mjs — the decision-log verb CLI (WORK-1/ATT-1, Lane B brick #3; ATT-4 step 1).
//
//   node decisions.mjs defer   <project-id> --until <YYYY-MM-DD>|--cond "<text>" [--note "..."] [--dry-run]
//   node decisions.mjs dismiss <project-id> [--note "..."] [--dry-run]
//   node decisions.mjs waiting <project-id> --on "<text>" [--note "..."] [--dry-run]
//   node decisions.mjs pin|park|unpin|unpark <project-id> --by <owner>|hermes [--item "<match-text>"|--item-hash <16hex>] [--reason "..."] [--dry-run]
//
// Records a human attention choice about an active Project, keyed by its (root-unique) id, into
// the append-only `memory/decision-log.jsonl` — a peer store to Projects, never Project-object
// content (ATT-1's "five stores" table; WORK-1 §7). One JSON object per line; a changed mind is a
// new line, never an edit — the same "supersede, keep the trail" discipline DECISIONS.md already
// runs, applied to attention instead of truth. This file never touches knowledge/ or scopes/*
// /projects/*.md — it only reads Projects (to validate the id), reads roadmaps (to resolve
// --item), and appends its own log.
//
// ATT-4 (board-rethink-design §5) adds the pin family: `pin` and `park` (park = anti-pin) plus
// their append-only reversals `unpin`/`unpark`, each authored (`--by <owner>|hermes`, required;
// <owner> is this install's human identity, resolved by paths.mjs from COCKPIT_OWNER or git)
// and optionally targeting one open roadmap item (`--item`, resolved against the project's open
// now/next items; the entry then carries the composite item identity with a canonical-text
// snapshot for the later rebind contract). `--item-hash <16hex>` (step 3) is the mutually
// exclusive resolution-free alternative for the §5 orphan dismiss/rebind path: the item may be
// gone from the roadmap, so no open-item lookup runs; the entry carries the given hash with the
// canonical snapshot recovered from the latest log entry holding that hash for the project, or
// null when none ever did. Entry shape:
//   { kind, project, scope, ts, by, reason?, item?: { hash, canonical } }
// The old triage entries (`decision: defer|dismiss|waiting`) stay readable forever and are not
// migrated; the dashboard simply stops writing them. Effective pin state is NOT bare
// latest-entry-wins: reducePinEntries below is THE one shared author-aware reader (OM-12's veto
// is structural), and effectivePinState resolves item-over-project per the §3 author-first rule.
//
// Pin verbs run under the §8 transaction contract (shared single-writer lock, busy → exit 75,
// stale-snapshot precondition on the log with exit 65, atomic write, one path-scoped commit,
// effective-state idempotency). The triage verbs keep their original lockless append (legacy
// writers, superseded on the dashboard).
//
// Board.mjs is the reader of the triage entries: the *latest* entry per project governs, and a
// stale entry (the project's `last_understanding_change` is newer than the entry's `ts`) is
// ignored entirely by the Board — the anti-nag mechanism. This file has no opinion on staleness;
// it only appends facts.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MEMORY_ROOT, parseNode } from './nodes.mjs';
import { AGENT_AUTHOR, ownerName, OWNER_UNSET_HINT } from './paths.mjs';
import { findProjectPath } from './closure.mjs';
import { tryAcquireLock, releaseLock } from './locks.mjs';
import { scopedCommit, gitAt } from './scoped-commit.mjs';
import { itemsIn } from './roadmap.mjs';
import { canonicalItemText, itemHash, compositeItemKey } from './item-identity.mjs';

const LOG_REL = 'decision-log.jsonl';
const LOG_PATH = resolve(MEMORY_ROOT, LOG_REL);
const DECISIONS = ['defer', 'dismiss', 'waiting'];
const PIN_KINDS = ['pin', 'park', 'unpin', 'unpark'];
// The two author identities: the install's human owner (resolved per install, paths.mjs) and the
// fixed agent identity. HUMAN_AUTHOR is null when no owner name is resolvable; the CLI refuses the
// pin family in that case rather than accepting any string.
const HUMAN_AUTHOR = ownerName();
const AUTHORS = HUMAN_AUTHOR ? [HUMAN_AUTHOR, AGENT_AUTHOR] : [AGENT_AUTHOR];
const AUTHORS_HINT = AUTHORS.join('|');
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH16 = /^[0-9a-f]{16}$/;   // --item-hash: the §5 composite identity's 8-byte prefix

const nowISO = () => new Date().toISOString();
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// refusals throw with an exit code so the finally ALWAYS releases the lock (accept.mjs's pattern).
function refuse(message, exitCode = 1) { const e = new Error(message); e.exitCode = exitCode; throw e; }

// Normalized reason for idempotency comparisons: trimmed, empty/absent/null all equal null —
// a repeat pin with a CHANGED reason is a new fact (new line), an identical reason is a no-op.
function normReason(r) { const t = typeof r === 'string' ? r.trim() : ''; return t || null; }

// Residue-proof heal comparator: does `parsed` equal the entry this verb would append, ignoring
// ts? Reasons compare normalized; item compares structurally ({hash, canonical}, both runs build
// it in the same shape).
function sameEntryIgnoringTs(parsed, entry) {
  const norm = (e) => JSON.stringify({
    kind: e.kind, project: e.project, scope: e.scope, by: e.by,
    reason: normReason(e.reason), item: e.item ?? null,
  });
  return norm(parsed) === norm(entry);
}

// Reads every recorded decision, oldest first (append order == chronological order).
export async function readDecisionLog() {
  let text = '';
  try { text = await readFile(LOG_PATH, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// Latest entry per project id — later lines win, matching the append-only "new entry supersedes"
// rule. TRIAGE entries only (the pin family is author-aware, never latest-wins: reducePinEntries).
export function latestDecisions(entries) {
  const map = new Map();
  for (const e of entries) if (e.decision !== undefined) map.set(e.project, e);
  return map;
}

// ---------- the one shared author-aware pin reduction (§5) ----------
// Target key: project-level `scope/project`, item-level the composite key (item-identity.mjs).
// Rules (OM-12's human veto is structural): a human entry supersedes anything prior on its
// target; a hermes entry supersedes only prior HERMES entries — over a live human state it never
// changes the effective state, it is retained as `hermesSuggestion` (grey rendering). After a
// human unpin/unpark on a target, subsequent hermes entries on it stay inert (suggestion only)
// until a new human pin/park re-opens hermes authority. A hermes unpin/unpark clears only
// hermes-authored state (its live layer and its own standing suggestion). Both reversal kinds
// clear their author's layer to neutral regardless of which state it held (an unpin over a park
// still clears — the reversal is "stand down", not a state-matched toggle; the CLI's idempotency
// check is where kind matching lives). Returns Map<key, { state, by, reason, ts,
// hermesSuggestion? }> with state ∈ pinned|parked|neutral.
export function reducePinEntries(entries) {
  const targets = new Map();
  const blank = () => ({
    humanState: 'neutral', humanReason: null, humanTs: null, humanBy: null,
    hermesState: 'neutral', hermesReason: null, hermesTs: null,
    hermesInert: false, hermesSuggestion: null,
  });
  for (const e of entries) {
    if (!PIN_KINDS.includes(e.kind)) continue;   // triage entries and foreign kinds pass through untouched
    const key = e.item ? compositeItemKey(e.scope, e.project, e.item.hash) : `${e.scope}/${e.project}`;
    const t = targets.get(key) ?? blank();
    const state = e.kind === 'pin' ? 'pinned' : e.kind === 'park' ? 'parked' : 'neutral';
    if (e.by === AGENT_AUTHOR) {
      if (state === 'neutral') {
        t.hermesState = 'neutral'; t.hermesReason = null; t.hermesTs = e.ts; t.hermesSuggestion = null;
      } else if (t.humanState !== 'neutral' || t.hermesInert) {
        t.hermesSuggestion = { state, reason: e.reason ?? null, ts: e.ts };
      } else {
        t.hermesState = state; t.hermesReason = e.reason ?? null; t.hermesTs = e.ts;
      }
    } else {
      // human: supersedes anything prior on this target
      t.humanState = state; t.humanReason = e.reason ?? null; t.humanTs = e.ts; t.humanBy = e.by ?? null;
      t.hermesState = 'neutral'; t.hermesReason = null; t.hermesTs = null; t.hermesSuggestion = null;
      t.hermesInert = state === 'neutral';   // reversal closes hermes authority; pin/park re-opens it
    }
    targets.set(key, t);
  }
  const out = new Map();
  for (const [key, t] of targets) {
    const v = t.humanState !== 'neutral'
      ? { state: t.humanState, by: t.humanBy, reason: t.humanReason, ts: t.humanTs }
      : t.hermesState !== 'neutral'
        ? { state: t.hermesState, by: AGENT_AUTHOR, reason: t.hermesReason, ts: t.hermesTs }
        : { state: 'neutral', by: null, reason: null, ts: null };
    if (t.hermesSuggestion) v.hermesSuggestion = t.hermesSuggestion;
    out.set(key, v);
  }
  return out;
}

// ---------- cross-level resolver (§3/§5 author-first rule) ----------
// A human action on either level (item or its project) beats any hermes action on the other;
// within the same author class, item-level beats project-level. The ordinal encodes the
// comparator's effective_pin_state rank directly (step 3 consumes it):
//   0 pinned-by-human, 1 pinned-by-hermes, 2 neutral, 3 parked (parked ranks last regardless of
//   author; the author split on parked is attribution only). Returns { state, by, level, ordinal,
//   reason } (reason = the governing entry's reason, null when absent or neutral).
export function effectivePinState(reduced, scope, projectId, itemHashPrefix) {
  const projectLevel = reduced.get(`${scope}/${projectId}`);
  const itemLevel = itemHashPrefix ? reduced.get(compositeItemKey(scope, projectId, itemHashPrefix)) : undefined;
  const live = (v) => v && v.state !== 'neutral';
  const candidates = [
    live(itemLevel) && itemLevel.by !== AGENT_AUTHOR ? { ...itemLevel, level: 'item' } : null,
    live(projectLevel) && projectLevel.by !== AGENT_AUTHOR ? { ...projectLevel, level: 'project' } : null,
    live(itemLevel) && itemLevel.by === AGENT_AUTHOR ? { ...itemLevel, level: 'item' } : null,
    live(projectLevel) && projectLevel.by === AGENT_AUTHOR ? { ...projectLevel, level: 'project' } : null,
  ].filter(Boolean);
  const governing = candidates[0] ?? null;
  if (!governing) return { state: 'neutral', by: null, level: null, ordinal: 2, reason: null };
  const ordinal = governing.state === 'parked' ? 3 : governing.by !== AGENT_AUTHOR ? 0 : 1;
  return { state: governing.state, by: governing.by, level: governing.level, ordinal, reason: governing.reason ?? null };
}

async function appendEntry(entry, dryRun) {
  const line = JSON.stringify(entry);
  if (dryRun) {
    console.log(`(--dry-run: nothing written)\n\n=== would append to ${LOG_PATH} ===\n${line}`);
    return;
  }
  let existing = '';
  try { existing = await readFile(LOG_PATH, 'utf8'); } catch { /* first entry ever */ }
  const updated = existing && !existing.endsWith('\n') ? `${existing}\n${line}\n` : `${existing}${line}\n`;
  const tmpPath = `${LOG_PATH}.tmp-${process.pid}`;
  await writeFile(tmpPath, updated, 'utf8');
  await rename(tmpPath, LOG_PATH);   // atomic on the same filesystem — no torn line on a crash
}

function usage(msg) {
  if (msg) console.error(`decisions: ${msg}`);
  console.error('usage: decisions.mjs defer <project-id> --until <YYYY-MM-DD>|--cond "<text>" [--note "..."] [--dry-run]\n' +
    '       decisions.mjs dismiss <project-id> [--note "..."] [--dry-run]\n' +
    '       decisions.mjs waiting <project-id> --on "<text>" [--note "..."] [--dry-run]\n' +
    `       decisions.mjs pin|park|unpin|unpark <project-id> --by ${AUTHORS_HINT} [--item "<match-text>"|--item-hash <16hex>] [--reason "..."] [--dry-run]`);
  if (!HUMAN_AUTHOR) console.error(`decisions: ${OWNER_UNSET_HINT}`);
  process.exit(1);
}

// scope from the project path: scopes/<scope>/projects/<id>.md under MEMORY_ROOT.
function scopeOfProjectPath(projectPath) {
  const parts = relative(MEMORY_ROOT, projectPath).split(sep);
  if (parts[0] !== 'scopes' || !parts[1]) throw new Error(`project path outside scopes/: ${projectPath}`);
  return parts[1];
}

// ---------- the pin-family transaction (§8 contract) ----------
async function runPinVerb(kind, id, projectPath, { by, reason, itemMatch, itemHashArg, dryRun }) {
  const scope = scopeOfProjectPath(projectPath);
  const entry = { kind, project: id, scope, ts: nowISO(), by };
  if (reason) entry.reason = reason;

  if (!(await tryAcquireLock())) {
    console.error('busy: another writer holds the lock, retry');
    process.exit(75);
  }
  try {
    // --item resolves against the project's OPEN (now+next) roadmap items, exactly one hit;
    // the entry carries the composite target with the canonical snapshot (rebind contract, §5).
    // Resolved UNDER the lock so item identity binds under the same serialization as the
    // append (a concurrent roadmap write cannot slip between resolve and append). Refusals go
    // through refuse() so the finally releases the lock.
    if (itemMatch !== null) {
      const roadmapPath = projectPath.replace(/\.md$/, '.roadmap.md');
      let text;
      try { text = await readFile(roadmapPath, 'utf8'); } catch { refuse(`no roadmap sidecar for "${id}" at ${roadmapPath}`); }
      const open = [...itemsIn(text, 'now'), ...itemsIn(text, 'next')].filter((it) => !it.done);
      const hits = open.filter((it) => it.text.includes(itemMatch));
      if (hits.length === 0) refuse(`--item "${itemMatch}" matched no open now/next item of ${id}`);
      if (hits.length > 1) refuse(`--item "${itemMatch}" matched ${hits.length} open items, be more specific`);
      const canonical = canonicalItemText(hits[0].raw);
      entry.item = { hash: itemHash(canonical), canonical };
    }

    // snapshot the log under the lock; the precondition below re-checks it before the rename.
    let logText = '';
    let logExists = true;
    try { logText = await readFile(LOG_PATH, 'utf8'); } catch { logExists = false; /* first entry ever */ }
    const snapshotHash = sha256(logText);
    const entries = logText.split('\n').filter(Boolean).map((l) => JSON.parse(l));

    // --item-hash is resolution-free (§5 orphan dismiss/rebind: the item may be gone from the
    // roadmap, so no open-item lookup). The entry carries the given hash with the canonical
    // snapshot recovered from the LATEST log entry holding that hash for this project (an
    // earlier pin/park recorded it), or null when no entry ever carried one.
    if (itemHashArg != null) {
      let canonical = null;
      for (const e of entries) {
        if (e.scope === scope && e.project === id && e.item?.hash === itemHashArg
          && typeof e.item.canonical === 'string') canonical = e.item.canonical;
      }
      entry.item = { hash: itemHashArg, canonical };
    }

    // effective-state idempotency (§8): if the target's current effective state already equals
    // what this verb would set for this author class, no-op success without appending.
    const reduced = reducePinEntries(entries);
    const key = entry.item ? compositeItemKey(scope, id, entry.item.hash) : `${scope}/${id}`;
    const cur = reduced.get(key) ?? { state: 'neutral', by: null };
    const wanted = kind === 'pin' ? 'pinned' : kind === 'park' ? 'parked' : 'neutral';
    let noop = false;
    if (wanted !== 'neutral') {
      // same state + same author class + same normalized reason → no-op; a changed reason is a
      // new fact and appends a fresh entry (reasons matter to the reader, never silently dropped).
      const wantedReason = normReason(reason);
      noop = by === AGENT_AUTHOR
        ? (cur.state === wanted && cur.by === AGENT_AUTHOR && normReason(cur.reason) === wantedReason)
          || (cur.hermesSuggestion?.state === wanted && normReason(cur.hermesSuggestion.reason) === wantedReason)
        : cur.state === wanted && cur.by !== AGENT_AUTHOR && normReason(cur.reason) === wantedReason;
    } else {
      // reversal: no-op when this author class holds nothing to clear
      noop = by === AGENT_AUTHOR
        ? !(cur.state !== 'neutral' && cur.by === AGENT_AUTHOR) && !cur.hermesSuggestion
        : !(cur.state !== 'neutral' && cur.by !== AGENT_AUTHOR);
    }
    if (noop) {
      // Heal the rename-landed-but-commit-missed crash window: a prior run may have appended
      // the log and died before its scoped commit, leaving durable uncommitted state a retry
      // (this no-op) would never touch. RESIDUE-PROOF: commit only when the working bytes are
      // exactly the HEAD log plus ONE appended JSON line equal to this verb's intended entry
      // (ignoring ts) — anything else is foreign uncommitted work, left untouched with a note.
      if (!dryRun && logExists) {
        let head = '';
        try { ({ stdout: head } = await gitAt(MEMORY_ROOT, ['show', `HEAD:${LOG_REL}`])); }
        catch { /* log not in HEAD: the interrupted run would have created it fresh, base = '' */ }
        if (logText !== head) {
          const base = head && !head.endsWith('\n') ? `${head}\n` : head;
          let provable = false;
          if (logText.startsWith(base)) {
            const tail = logText.slice(base.length);
            const tailLines = tail.split('\n').filter(Boolean);
            if (tail.endsWith('\n') && tailLines.length === 1) {
              try { provable = sameEntryIgnoringTs(JSON.parse(tailLines[0]), entry); }
              catch { /* not a JSON line: foreign */ }
            }
          }
          if (provable) {
            const healed = await scopedCommit(MEMORY_ROOT, `decisions: ${kind} ${id} (commit heal)`, [LOG_REL]);
            if (healed === 'committed') console.log(`decisions: healed an uncommitted ${LOG_REL}`);
          } else {
            console.error(`decisions: ${LOG_REL} has uncommitted changes this verb did not produce; left untouched`);
          }
        }
      }
      console.log(`decisions: ${key} already ${cur.state}${cur.by ? ` (by ${cur.by})` : ''} for ${by}, no-op`);
      return;
    }

    const line = JSON.stringify(entry);
    if (dryRun) {
      console.log(`(--dry-run: nothing written)\n\n=== would append to ${LOG_PATH} ===\n${line}`);
      return;
    }
    // stale-snapshot precondition (§8): re-read immediately before the rename. The lock already
    // serializes every system writer, so a mismatch here is a non-cooperating editor (the §8
    // consciously accepted residue) — refuse with exit 65, the stale-snapshot code.
    let current = '';
    try { current = await readFile(LOG_PATH, 'utf8'); } catch { /* still absent, fine */ }
    if (sha256(current) !== snapshotHash) {
      refuse(`conflict: ${LOG_PATH} changed on disk since this verb read it; nothing written, re-run`, 65);
    }
    const updated = logText && !logText.endsWith('\n') ? `${logText}\n${line}\n` : `${logText}${line}\n`;
    const tmpPath = `${LOG_PATH}.tmp-${process.pid}`;
    await writeFile(tmpPath, updated, 'utf8');
    await rename(tmpPath, LOG_PATH);   // atomic on the same filesystem
    await scopedCommit(MEMORY_ROOT, `decisions: ${kind} ${id}`, [LOG_REL]);
    console.log(`decisions: ${kind} recorded for ${key} (by ${by})${reason ? ` — reason: ${reason}` : ''}`);
  } finally {
    await releaseLock();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [verb, id] = args;
  if (!DECISIONS.includes(verb) && !PIN_KINDS.includes(verb)) {
    usage(`unknown decision "${verb || ''}" (must be defer|dismiss|waiting|pin|park|unpin|unpark)`);
  }
  if (!id || !KEBAB.test(id)) usage('need <project-id> as a kebab-slug');

  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    const v = i !== -1 ? args[i + 1] : null;
    return v != null && !v.startsWith('--') ? v : null;
  };
  const dryRun = args.includes('--dry-run');

  const projectPath = await findProjectPath(id);
  if (!projectPath) usage(`no project found with id "${id}"`);
  const { frontmatter: fm } = parseNode(await readFile(projectPath, 'utf8'), id);
  if (fm.state !== 'active') usage(`cannot record a decision for "${id}": state is "${fm.state}" (only active projects take attention decisions)`);

  if (PIN_KINDS.includes(verb)) {
    const by = flag('by');
    if (!by || !AUTHORS.includes(by)) usage(`${verb} needs --by ${AUTHORS_HINT}`);
    const itemMatch = flag('item');
    const itemHashArg = flag('item-hash');
    if (itemMatch !== null && itemHashArg !== null) usage(`${verb} takes at most one of --item or --item-hash, not both`);
    if (itemHashArg !== null && !HASH16.test(itemHashArg)) usage('--item-hash must be exactly 16 lowercase hex chars');
    await runPinVerb(verb, id, projectPath, { by, reason: flag('reason'), itemMatch, itemHashArg, dryRun });
    return;
  }

  const entry = { project: id, decision: verb, ts: nowISO() };
  const note = flag('note');
  if (note) entry.note = note;

  if (verb === 'defer') {
    const until = flag('until');
    const cond = flag('cond');
    if (!until && !cond) usage('defer needs --until <YYYY-MM-DD> or --cond "<text>"');
    if (until && cond) usage('defer takes exactly one of --until or --cond, not both');
    if (until) {
      if (!DATE_RE.test(until)) usage('--until must be YYYY-MM-DD');
      entry.until = until;
    } else {
      entry.cond = cond;
    }
  } else if (verb === 'waiting') {
    const on = flag('on');
    if (!on) usage('waiting needs --on "<text>"');
    entry.on = on;
  }

  await appendEntry(entry, dryRun);
  const suffix = entry.until ? ` (until ${entry.until})` : entry.cond ? ` (cond: ${entry.cond})` : entry.on ? ` (on: ${entry.on})` : '';
  console.log(`decisions: ${verb} recorded for ${id}${suffix}`);
}

// Run ONLY when invoked directly — importing this module (the Board does) must never trigger writes.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error('decisions failed:', e.message); process.exit(e.exitCode ?? 1); });
