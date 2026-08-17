#!/usr/bin/env node
// read-pass.mjs — the shared nightly read pass (MEM-34 step 1; decisions/harness-self-upgrade.md,
// DESIGN §6a.8d). Pure extraction of code that already existed in reconcile.mjs (staging ingestion)
// and mechanical-insights.mjs (raw transcript occurrences + skill enumeration) — no behavior change. Both
// engines import from here instead of each defining their own copy.
//
// The live knowledge graph (loadPool()) is already shared via nodes.mjs and is NOT duplicated here.

import { readFile, readdir, stat } from 'node:fs/promises';
import {
  readFileSync, readdirSync, existsSync, realpathSync,
} from 'node:fs';
import { resolve, join, basename, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load as yamlLoad } from 'js-yaml';
import { MEMORY_ROOT, parseNode } from './nodes.mjs';
import { viaToken, STAGING_SCHEMA_VERSION } from './capture-core.mjs';
import { cwdScope, COCKPIT_DIR } from '../skills/history-search/scope-gate.mjs';

const execFileP = promisify(execFile);

// ============================================================ staging ingestion (from reconcile.mjs)
// capture writes turns as:  #### <role> · <ts>  [tag, tag]\n<text>\n\n
const DIGEST_TURN_CAP = 80;          // bound judge cost: at most this many turns per work-unit digest
const TURN_CHARS = 600;              // per-turn truncation in the digest

export const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

// ---------- harness-block stripping (§6a.8g item 1) ----------
// Removes harness-injected wrapper blocks a #bad turn's own text can carry (system reminders,
// ambient-recall context, slash-command envelopes) so the corrections ledger captures what the
// human actually wrote, not the harness's own scaffolding around it. Robust to an unclosed block
// (a truncated/partial capture): strips to end of text rather than leaving a dangling open tag.
function stripBetween(text, openTag, closeTag) {
  let out = text;
  for (;;) {
    const start = out.indexOf(openTag);
    if (start === -1) break;
    const closeIdx = out.indexOf(closeTag, start + openTag.length);
    if (closeIdx === -1) { out = out.slice(0, start); break; }
    out = out.slice(0, start) + out.slice(closeIdx + closeTag.length);
  }
  return out;
}

export function stripHarnessBlocks(text) {
  if (typeof text !== 'string' || !text) return text || '';
  let out = text;
  out = stripBetween(out, '<system-reminder>', '</system-reminder>');
  out = stripBetween(out, '<!-- cockpit:recall:begin', '<!-- cockpit:recall:end -->');
  // The whole <local-command-*> family is harness output (stdout echoes, caveats), content and all;
  // wildcard match per the spec (§6a.8g names the FAMILY, not a fixed tag list — Codex review
  // 2026-07-23, major: a fixed subset let unlisted harness tags survive capture/embedding/evidence).
  // Unclosed block: strip to end of text (a truncated capture must not leak a dangling wrapper).
  out = out.replace(/<local-command-[a-z-]+>[\s\S]*?(?:<\/local-command-[a-z-]+>|$)/g, '');
  // command-name/command-message are boilerplate (the invocation echo), content dropped.
  out = out.replace(/<command-(name|message)>[\s\S]*?(?:<\/command-\1>|$)/g, '');
  // Any remaining <command-*> wrapper (command-args today, future variants alike) keeps its content
  // (mirrors effectiveOpenerText's intent: a slash command WITH real args is genuine task text) —
  // only the wrapper tags themselves are stripped.
  out = out.replace(/<\/?command-[a-z-]+>/g, '');
  return out.trim();
}

// ---------- turn-header integrity (MEM-38 step 4 gate; nominally step 9, pulled forward because it
// shares a root with the `provenance: authored` forgery route: a `#### role · ts · claude:typed` line
// inside a turn BODY, a pasted document or a tool-error snippet used to split into a turn of its own
// and parse as a genuine typed human turn) ----------
// Two layers, and they protect DIFFERENT things:
//   (a) capture-core.mjs escapes `#### `-leading body lines on the WRITE side. This is the only thing
//       that closes FORGERY, and it therefore only holds for files the new writer created. Header
//       shape validation cannot help here: a forged header is byte-identical to a real one.
//   (b) this side validates header SHAPE, unconditionally. That closes the ACCIDENTAL phantom turn (an
//       ordinary `#### Summary` in pasted prose splitting a real turn in two) in EVERY format, legacy
//       included. It is not a forgery defence. Shape, not a role whitelist: roles come from per-brain
//       readers, so the check is "short single token" + "a real timestamp".
// The bridge between them is the frontmatter FORMAT MARKER (`schema_version`, capture-core's
// STAGING_SCHEMA_VERSION). Only a file that declares the escaped format may be unescaped or yield a
// channel; everything else is read verbatim with `via: null` on every turn. Fail-closed is the point:
// legacy staging can never mint `authored` or `relayed` from a channel, so a forged legacy header buys
// nothing, and the trust multiplier built over `provenance` rests on files whose writer we know.
const RE_TURN_ROLE = /^[a-z0-9_-]{1,32}$/i;
// Reverses capture-core's escaping: exactly one backslash comes off a line of the escaped form. Gated
// on the format marker, because on a legacy body there is no proof the backslash came from the writer:
// a literal `\#### heading` someone actually typed would be silently rewritten to `#### heading`.
const unescapeTurnBody = (s) => s.replace(/^\\(\\*#### )/gm, '$1');

export function parseStaging(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = Object.create(null);   // keys come from the file's frontmatter lines: never a plain `{}`
  if (fmMatch) for (const ln of fmMatch[1].split('\n')) {
    const i = ln.indexOf(':'); if (i > 0) fm[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
  }
  // The format marker. `>=` rather than `===` so a future version 3 keeps the guarantee rather than
  // silently reverting to legacy handling; anything unparseable is legacy by construction (NaN).
  const escapedFormat = Number(fm.schema_version) >= STAGING_SCHEMA_VERSION;
  // Split first, then keep only the parts whose header really is a header. A part that fails the
  // shape check is not a turn boundary: it is body text that happened to start with `#### `, so it is
  // re-joined into the PREVIOUS turn's body with the literal `\n#### ` separator restored, and no
  // captured text is lost or altered. A failing part before the FIRST valid turn has no previous turn
  // to attach to and is dropped, matching what `.slice(1)` already did to pre-first-header text.
  const parts = [];
  for (const part of text.split(/\n#### /).slice(1)) {
    const nl = part.indexOf('\n');
    const header = nl === -1 ? part : part.slice(0, nl);
    const segs = header.split('·');
    const roleSeg = (segs[0] || '').trim();
    const tsSeg = (segs[1] || '').replace(/\[([^\]]+)\]\s*$/, '').trim();
    // The `·` separator must be PRESENT, its ts value may be empty. Both readers default `ts` to ''
    // when a source record carries no timestamp (capture.mjs:69, hermes-capture.mjs:148) while
    // capture-core always writes the separator itself (`#### ${role} · ${ts}`), so an empty value is
    // a genuine header and rejecting it would silently merge a real turn into its predecessor.
    // Requiring the separator is what keeps a bare markdown heading out: `#### Summary` has no `·` at
    // all, and a single word passes the role check, so allowing a MISSING segment let a heading open
    // a phantom turn that stole the tail of the real turn's body (and, for `#### user`, landed with a
    // role the safety-net sweep selects on). Found by the test pass, not by the implementation pass.
    if (!RE_TURN_ROLE.test(roleSeg) || segs.length < 2 || !(tsSeg === '' || Number.isFinite(Date.parse(tsSeg)))) {
      if (parts.length) parts[parts.length - 1].body += `\n#### ${part}`;
      continue;
    }
    parts.push({ header, body: nl === -1 ? '' : part.slice(nl + 1) });
  }
  const turns = parts.map(({ header, body: rawBody }) => {
    const body = (escapedFormat ? unescapeTurnBody(rawBody) : rawBody).trim();
    const tagM = header.match(/\[([^\]]+)\]\s*$/);
    // ts (MEM-34 step 2, additive — reconcile.mjs's distill path never read this field, so this
    // doesn't change its behavior): the header's middle segment, between the two "·" splits, minus
    // the trailing tag bracket. recurring-correction needs a real per-turn timestamp for its
    // resurfacing rule (candidatesForNamespace's "fresh occurrences since resolved" filter), which
    // no existing consumer needed before. Unparseable/missing -> null, handled as "not fresh" by
    // callers (a conservative default, never over-mints on missing data).
    const tsRaw = header.split('·')[1] || '';
    const tsParsed = Date.parse(tsRaw.replace(/\[([^\]]+)\]\s*$/, '').trim());
    // via (MEM-38 step 2): the OPTIONAL third segment, the capture-time provenance channel
    // (capture-core.mjs viaToken). Absent on every pre-MEM-38 header and on every unstamped turn,
    // which is meaningful, not an error — step 3 resolves absence, so this stays null rather than
    // inventing an "unknown" value. A third segment leaves `role` (segment 0) and `ts` (segment 1)
    // untouched, and the tag regex stays end-anchored on the bracket, so old 2-segment staging in
    // the same directory parses exactly as before.
    // MEM-38 step 4 gate: validated at READ time with capture-core's own whitelist (viaToken), not a
    // second copy of the regex — one home for the vocabulary. Fails closed to null exactly as the
    // write side does, so an invalid/forged token becomes "no channel", never a tier (there is
    // deliberately no `unknown` tier). And the whole segment is honored ONLY in the escaped format:
    // in a legacy file a body line can still be a byte-perfect header, so a channel read out of one
    // is unverifiable and is dropped rather than turned into a tier.
    const viaRaw = escapedFormat ? (header.split('·')[2] || '').replace(/\[([^\]]+)\]\s*$/, '').trim() : '';
    return {
      role: header.split('·')[0].trim(),
      tags: tagM ? tagM[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
      text: body,
      ts: Number.isFinite(tsParsed) ? tsParsed : null,
      via: viaToken(viaRaw),
    };
  });
  return { anchor: fm.session_anchor || 'unknown', scope: fm.scope, transcript: fm.transcript, brain: fm.brain,
    graduationOf: fm.graduation_of || null, turns };   // set by the closure verb's residue summary (WORK-1)
}

export async function stagingFiles(scope) {
  const dir = resolve(MEMORY_ROOT, 'scopes', scope, 'staging');
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .map((f) => resolve(dir, f));
  } catch { return []; }
}

// ============================================================ sources ingestion (MEM-36; decisions/ingestion-and-curation.md)
// Source writers (skills/watch/watch.py, record's transcribe.py — machine-local, outside the repo) stamp each sources/ file with `distilled_into: []` — an empty
// array means "not yet read by the reconciler." Mirrors stagingFiles/parseStaging's shape so reconcile.mjs can
// treat a source file as just another work-unit input alongside staging.
export async function sourceFiles(scope) {
  const dir = resolve(MEMORY_ROOT, 'scopes', scope, 'sources');
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .map((f) => resolve(dir, f)).sort();
  } catch { return []; }
}

export function parseSource(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
  // a malformed frontmatter block must degrade gracefully, never throw — one bad sources/ file must not
  // abort the whole reconcile run. `frontmatter: null` (vs a valid `{}`) tells the caller parsing FAILED,
  // so it must skip the file rather than risk writing back an empty frontmatter over real fields.
  let frontmatter = {};
  if (fmMatch) { try { frontmatter = yamlLoad(fmMatch[1]) || {}; } catch { frontmatter = null; } }
  const body = fmMatch ? text.slice(fmMatch[0].length) : text;
  return { frontmatter, body: body.trim() };
}

// ---------- scope enumeration (moved from reconcile.mjs, MEM-34 step 2 — mechanical-insights.mjs's
// recurring-correction detector now also needs "which scopes have staging," the same question
// reconcile.mjs already answered). Deliberately MEMORY_ROOT-relative (relocatable via
// COCKPIT_MEMORY_ROOT for an isolated test/venture run) — NOT scope-gate.mjs's liveScopes(), which
// is deliberately HOME-relative because it governs the raw-transcript wall, a different surface
// (see scope-gate.mjs's own header comment). Staging lives under MEMORY_ROOT, so its scope list must
// follow MEMORY_ROOT too, or an isolated-root test would silently read the real scopes.json.
const DEFAULT_SCOPES = ['global', 'cockpit'];

export async function loadScopes() {
  try {
    const raw = JSON.parse(await readFile(resolve(MEMORY_ROOT, 'scopes.json'), 'utf8'));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch { /* fall through to defaults */ }
  console.log(`read-pass: no memory/scopes.json — using defaults ${JSON.stringify(DEFAULT_SCOPES)}. Create it to add scopes.`);
  return DEFAULT_SCOPES;
}

// Build a compact digest from UNCONSUMED turns: salience-flagged turns (MEM-22) + their neighbors
// for context, plus an unmarked sample as the safety-net sweep. Returns { digest, turnIndex }.
export function buildDigest(turns) {
  // MEM-38 step 4 gate: the digest path now strips harness blocks, at the same grain
  // mechanical-insights.mjs's gatherBadGoodTurns already strips them. Without this the graph's own
  // ambient-recall prose (and system reminders, slash-command envelopes) rode back in INSIDE a turn
  // stamped `claude:typed`, i.e. the harness's own scaffolding read as human-authored material.
  // Stripped BEFORE selection, so a turn whose entire body was scaffolding drops out of the digest
  // AND out of turnIndex, and therefore cannot back a node at all.
  const stripped = turns.map((t) => stripHarnessBlocks(t.text));
  const keep = new Set();
  turns.forEach((t, i) => {
    if (t.tags.length) { keep.add(i); if (turns[i - 1]) keep.add(i - 1); if (turns[i + 1]) keep.add(i + 1); }
  });
  if (keep.size < 3) turns.forEach((t, i) => { if (t.role === 'user' && stripped[i]) keep.add(i); }); // safety net
  const idx = [...keep].sort((a, b) => a - b).filter((i) => stripped[i]).slice(0, DIGEST_TURN_CAP);
  const turnIndex = {};
  const digest = idx.map((i) => {
    // MEM-38 step 2: entries carry { text, via }, not bare text — the mint path (reconcile.mjs's
    // deriveCitation / step 3's provenance derivation) sees the turn only through turnIndex, so a
    // capture-time stamp is invisible to it otherwise. `text` is the HARNESS-STRIPPED turn text as of
    // the step 4 gate (it used to be the raw text): deriveCitation hashes it into every `stg:`
    // citation, so citation hashes shift for any turn that carried a harness block. Acceptable on a
    // fresh graph, and nothing re-derives a citation from staging text to COMPARE against a stored
    // one. Tags are deliberately NOT carried (no consumer, YAGNI).
    turnIndex[i] = { text: stripped[i], via: turns[i].via || null };
    const tag = turns[i].tags.length ? ` {${turns[i].tags.join(',')}}` : '';
    return `[T${i}] (${turns[i].role})${tag}: ${truncate(stripped[i], TURN_CHARS)}`;
  }).join('\n\n');
  return { digest, turnIndex };
}

// ============================================================ skill enumeration (from mechanical-insights.mjs)
// Deliberately scoped to THIS repo's own skills/ tree, not plugin-provided skills (codex:*,
// telegram:*, context-mode:*, ...) — a v1 scoping choice: a plugin skill isn't something the owner
// authored or can retire/promote via this store.
const SKILLS_DIR = resolve(COCKPIT_DIR, 'skills');

// skillGitDates: the same `git log --follow --format=%aI` call enumerateSkills already makes,
// isolated as its own pure(ish) helper parametrized by an explicit gitRoot (so tests never touch
// the real cockpit repo — same testability precedent workCommitsSince established in
// semantic-insights.mjs). ageDays comes from the OLDEST commit (dates.at(-1), enumerateSkills'
// existing semantics); lastChangedDays is the companion NEW signal, from the NEWEST commit
// (dates[0]) — how recently the file was actually touched, independent of how old it is. Never
// throws: an untracked path or an unusable repo both degrade to { ageDays: null, lastChangedDays:
// null } rather than the old 0-default (0 meant "too new to judge," which is wrong for "unknown").
export async function skillGitDates(relPath, gitRoot) {
  try {
    const { stdout } = await execFileP('git', ['-C', gitRoot, 'log', '--follow', '--format=%aI', '--', relPath]);
    const dates = stdout.trim().split('\n').filter(Boolean);
    if (!dates.length) return { ageDays: null, lastChangedDays: null };
    const oldest = Date.parse(dates.at(-1));
    const newest = Date.parse(dates[0]);
    return {
      ageDays: Number.isFinite(oldest) ? (Date.now() - oldest) / 86_400_000 : null,
      lastChangedDays: Number.isFinite(newest) ? (Date.now() - newest) / 86_400_000 : null,
    };
  } catch { return { ageDays: null, lastChangedDays: null }; }
}

export async function enumerateSkills() {
  let entries = [];
  try { entries = await readdir(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const relPath = `skills/${d.name}/SKILL.md`;
    let raw;
    try { raw = await readFile(resolve(SKILLS_DIR, d.name, 'SKILL.md'), 'utf8'); } catch { continue; } // no SKILL.md -> not a skill dir (lib/, references/)
    const { frontmatter } = parseNode(raw, d.name);
    const name = frontmatter.name || d.name;
    const description = frontmatter.description || '';
    // Unknown age (git unavailable, or the file is untracked/uncommitted) defaults to 0 — treated
    // as brand new, so it's EXCLUDED from underused-skill until real git history proves otherwise
    // (Codex code review 2026-07-07, major: defaulting to Infinity made an unknown-age skill
    // trivially "old enough," risking a false "underused" finding for a skill that just landed).
    const { ageDays: rawAgeDays, lastChangedDays: rawLastChangedDays } = await skillGitDates(relPath, COCKPIT_DIR);
    const ageDays = rawAgeDays ?? 0;
    const lastChangedDays = rawLastChangedDays ?? 0;
    // LEARNED.md presence + size (§6a.8g item 3, additive): underused-skill needs real material for
    // the judge beyond age/description — a skill accreting LEARNED.md content is actively maintained
    // even if invocation counts are low, a fact the judge should see, not this module's call to make.
    let hasLearned = false;
    let learnedBytes = 0;
    try {
      const st = await stat(resolve(SKILLS_DIR, d.name, 'LEARNED.md'));
      hasLearned = true;
      learnedBytes = st.size;
    } catch { /* no LEARNED.md — defaults stand */ }
    out.push({ name, description, ageDays, lastChangedDays, hasLearned, learnedBytes });
  }
  return out;
}

// ============================================================ raw transcript occurrences (from mechanical-insights.mjs)
const CLAUDE_ROOT = resolve(process.env.HOME || '', '.claude', 'projects');
const MIN_OPENER_LEN = 40;    // chars — filters "yes"/"continue"-style non-openers
const ERROR_SNIPPET_LEN = 300;   // truncation for raw tool_result content captured on failure (§6a.8c)

// Shape heuristic (a documented judgment call): fewer-permission-prompts is a built-in prompt
// skill, not an importable module, so this reimplements its extraction TARGET (common Bash + MCP
// tool calls) rather than borrowing its exact code. Bash commands normalize to their first two
// whitespace tokens (binary + subcommand, e.g. "git status", "npm test") — the same grain Claude
// Code's own permission-rule prefixes use; MCP tool calls normalize to the full tool name
// (heterogeneous params make arg-level normalization not worth it for v1). Everything else
// (Read/Edit/Grep/...) is out of scope for v1 — not the noisy permission-prompt surface.
function normalizeBash(command) {
  return String(command).trim().split(/\s+/).slice(0, 2).join(' ');
}

// MEM-32 containment mirror (history-search's listJsonl): resolve symlinks, keep only true
// residents of CLAUDE_ROOT so a symlink can't smuggle in a file that lives outside it.
export function listClaudeJsonl() {
  if (!existsSync(CLAUDE_ROOT)) return [];
  const rootReal = realpathSync(CLAUDE_ROOT);
  const out = [];
  for (const f of readdirSync(CLAUDE_ROOT, { recursive: true })) {
    if (!String(f).endsWith('.jsonl')) continue;
    const path = join(CLAUDE_ROOT, String(f));
    try { if (realpathSync(path).startsWith(rootReal + sep)) out.push(path); } catch { /* dangling symlink */ }
  }
  return out;
}

// content may be a bare string or an array of content blocks ({type:'text', text}) — same shape
// ambiguity for tool_result.content as for message.content, extracted the same way (§6a.8c).
function extractText(c) {
  return (typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '').trim();
}

// A bare slash-command invocation (e.g. /model, /compact) is recorded as a synthetic XML wrapper,
// not real user prose: <command-name>/x</command-name><command-message>x</command-message>
// <command-args>...</command-args>. When command-args is empty, that wrapper is boilerplate
// byte-identical across any two invocations of the same command — long enough to clear
// MIN_OPENER_LEN, so left unfiltered it trivially cosine-matches at ~1.0 and false-positives
// duplicate-parallel-effort (found in the first real nightly run, 2026-07-08: five findings were
// just "ran /model twice" or "ran /codex:setup twice," not actual duplicate work). A slash command
// WITH real args (e.g. `/watch <url> and explain...`) is genuine task text and must not be
// filtered — only the wrapper tags are stripped, the args content becomes the effective text.
// Tag order (name -> message -> args) is hard-coded, verified against real transcript samples
// (Codex code review 2026-07-08, minor: a differently-ordered wrapper variant, if one ever exists,
// would fail this match and fall back to using the raw boilerplate as opener text — the pre-fix
// behavior, not a new regression).
const SLASH_COMMAND_RE = /^<command-name>.*?<\/command-name>\s*<command-message>.*?<\/command-message>\s*<command-args>([\s\S]*?)<\/command-args>\s*$/;
function effectiveOpenerText(text) {
  // Harness-injected turns are not conversation: a first "user" record carrying local-command
  // output (`/model`, `/clear`, ... stdout echoes) or a command-name envelope describes the
  // harness, not the session's intent. Returning '' fails MIN_OPENER_LEN, so the scan keeps
  // looking for the first REAL user turn — this is the at-source fix for the duplicate-work
  // detector's "Set model to Opus" false-positive family (ATT-2 B4 noise fix).
  // Order matters (Codex-flagged): a slash-command wrapper carries the real intent in its
  // <command-args>, so extract those FIRST — only turns with no extractable args (bare /model,
  // /clear stdout echoes, caveat envelopes) are harness noise and drop to ''.
  const m = text.match(SLASH_COMMAND_RE);
  if (m) return m[1].trim();
  if (/<local-command-stdout>|<local-command-caveat>|<command-name>/.test(text)) return '';
  return text;
}

// One-pass parse: scope decision (via the shared gate) + extracted tool-call occurrences
// (bash/mcp/skill) + the session's opening user turn (>= MIN_OPENER_LEN chars, within window) —
// shared infra #2 (§6a.8b): all detectors read each transcript file exactly once per scan().
export function analyzeTranscript(path, sinceMs) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return { occ: [], opener: null }; }
  const lines = raw.split('\n');
  let cwd = null;
  let sessionId = null;
  const occ = [];
  let opener = null;
  // tool_use id -> occurrence (bash/mcp only, in-window) — for tool_result error correlation
  // (recurring-failure, §6a.8c). Populated as occurrences are pushed below; consulted here as
  // tool_result records arrive later in the same forward pass (tool_use always precedes its
  // tool_result in a transcript).
  const byToolUseId = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let obj = null;
    try { obj = JSON.parse(lines[i]); } catch { continue; }   // malformed line — skip
    if (cwd === null && typeof obj.cwd === 'string') cwd = obj.cwd;
    if (sessionId === null && typeof obj.sessionId === 'string') sessionId = obj.sessionId;
    if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const target = byToolUseId.get(block.tool_use_id);
        if (!target) continue;   // not one of our tracked bash/mcp occurrences (out of window, or a different tool kind)
        target.error = !!block.is_error;
        if (target.error) target.errorSnippet = extractText(block.content).slice(0, ERROR_SNIPPET_LEN);
      }
    }
    if (opener === null && !obj.isMeta && obj.type === 'user' && obj.message) {
      const text = effectiveOpenerText(extractText(obj.message.content));
      if (text.length >= MIN_OPENER_LEN) {
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (Number.isFinite(ts) && ts >= sinceMs) opener = { text, ts };
      }
    }
    if (obj.type !== 'assistant' || !obj.message || !Array.isArray(obj.message.content)) continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    for (const block of obj.message.content) {
      if (!block || block.type !== 'tool_use') continue;
      let o = null;
      if (block.name === 'Bash' && block.input && typeof block.input.command === 'string') {
        o = { kind: 'bash', shape: normalizeBash(block.input.command), ts, file: path, line: i + 1 };
      } else if (block.name === 'Skill' && block.input && typeof block.input.skill === 'string') {
        occ.push({ kind: 'skill', shape: block.input.skill, ts, file: path, line: i + 1 });
        continue;   // skill occurrences don't correlate to tool_result error state (§6a.8c: bash/mcp only)
      } else if (typeof block.name === 'string' && block.name.startsWith('mcp__')) {
        o = { kind: 'mcp', shape: block.name, ts, file: path, line: i + 1 };
      }
      if (!o) continue;
      occ.push(o);
      if (typeof block.id === 'string') byToolUseId.set(block.id, o);
    }
  }
  if (!occ.length && !opener) return { occ: [], opener: null };
  const scope = cwdScope(cwd);
  if (scope === 'walled' || !scope) return { occ: [], opener: null };   // hard-skip — no opt-in override for an automated scan
  return {
    occ: occ.map((o) => ({ ...o, scope })),
    opener: opener ? { ...opener, scope, file: path, session: sessionId || basename(path, '.jsonl') } : null,
  };
}
