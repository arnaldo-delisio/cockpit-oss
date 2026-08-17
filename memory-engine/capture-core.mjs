#!/usr/bin/env node
// capture-core.mjs — shared, brain-neutral capture pipeline (DESIGN §9, B1 / TOOL-6).
//
// The brain-agnostic core of session capture. Each brain has a thin reader that turns its
// own session record into a normalized entries[] and calls capture(); everything after that
// — scope gating, salience, cursor idempotency, staging frontmatter (incl. the brain stamp),
// append, and the fail-safe error log — lives here, identical for both brains:
//   capture.mjs         (Claude)  Stop/PreCompact/SessionEnd hook -> transcript JSONL
//   hermes-capture.mjs  (Hermes)  on_session_end hook -> state.db messages by session_id
//
// Input contract — capture({ entries, cwd, sessionId, event, provenance, brain }):
//   entries    normalized [{ role, text, errored, ts, via }] — the FULL ordered set, PRE-noise-filter.
//              The reader MUST emit one entry per source record (even empty ones) so the cursor
//              count stays stable across the per-turn re-fires; the noise filter here only decides
//              what gets WRITTEN, never what gets COUNTED. `via` is the optional per-turn
//              provenance channel (MEM-38 step 2); absent/unknown is meaningful, see viaToken().
//   cwd        session cwd — drives the scope gate.
//   sessionId  raw session id (sanitized here).
//   event      hook event name (cursor metadata only).
//   provenance value for the staging `transcript:` field (Claude: transcript path; Hermes: state.db ref).
//   brain      'claude' | 'hermes' — stamped in the staging frontmatter; B4's audience mint reads it.
//
// CAPTURE_DRY_RUN=1 -> compute + report to stdout, write nothing (proves a reader before wiring).

import {
  readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { ensureScope, MEMORY_ROOT } from './bootstrap.mjs';
import { mappedScope, isScopeSlug } from './paths.mjs';

const DRY = process.env.CAPTURE_DRY_RUN === '1';

// ---------- scope decision (DESIGN §9; unmapped = opt-in only, 2026-06-23) ----------
// A session is captured ONLY if it resolves to a REAL scope. Priority:
//   1. COCKPIT_SCOPE env  — explicit pre-launch override
//   2. mapped cwd         — paths.mjs mappedScope(): <repo>/scopes/<x> -> <x>, deepest match
//                           first; inside the repo but not under scopes/ -> cockpit
//   3. #capture opt-in    — the user typed #capture / #capture:<scope> in the session
//   else -> null = DO NOT CAPTURE. Unmapped cwds no longer fabricate a `global` scope, so
//   autonomous agents (Hermes, ex-paperclip) and incidental sessions never auto-enroll. The
//   same gate now fences the Hermes reader structurally (this is the paperclip protection).

// #capture / #capture:<scope> in the user's text opts an otherwise-unmapped session in.
// Collision-free like #good/#bad (MEM-22); bare #capture -> cockpit, #capture:<scope> -> that
// scope (`global` does not exist in the ported system; the shell layer replaced it).
const RE_CAPTURE = /(?:^|\s)#capture(?::([a-z0-9][a-z0-9-]*))?\b/i;
function captureOptIn(userText) {
  const m = userText.match(RE_CAPTURE);
  return m ? (m[1] || 'cockpit').toLowerCase() : null;
}

// ---------- salience (MEM-22): tier-1 sentinels + tier-2 regex over user text ----------
const SENTINEL = /(^|\s)#(good|bad)\b/i;
const RE_KEEP = /\b(remember|note this|important|keep this|don'?t forget)\b/i;
const RE_CORRECTION = /\b(wrong|incorrect|actually|revert|undo|misunderstood|that'?s not|not what i)\b/i;
const RE_LEADING_NO = /^\s*(no\b|nope\b|don'?t\b|stop\b)/i;
const RE_DECISION = /\b(decided|approved|let'?s go with|green ?light|ship it|go ahead|confirmed|locked)\b/i;

function userSalience(text) {
  const f = [];
  const m = text.match(SENTINEL); if (m) f.push('#' + m[2].toLowerCase());
  if (RE_KEEP.test(text)) f.push('keep');
  if (RE_CORRECTION.test(text) || RE_LEADING_NO.test(text)) f.push('correction');
  if (RE_DECISION.test(text)) f.push('decision');
  return f;
}

// ---------- provenance channel (MEM-38 step 2) ----------
// Each reader may stamp a turn with the CHANNEL it arrived through (`claude:typed`, `subagent`,
// `hermes:cli`, `hermes:telegram`). The channel is emitted as a THIRD `·` segment in the turn
// header, deliberately NOT inside the tag bracket: read-pass.mjs:149 gates digest inclusion on
// `t.tags.length`, so an always-present tag would mark every turn salient and collapse the MEM-22
// salience filter plus its neighbor expansion. The segment is omitted entirely when there is no
// token, so unstamped turns stay byte-identical to pre-MEM-38 staging.
//
// Absence is MEANINGFUL (assistant turns, hook/system injections, task notifications, tool errors,
// Hermes `[tool] ` traces all carry none) and step 3 resolves it into a provenance tier; there is
// deliberately no "unknown" token.
//
// Sanitized here, at the single emission site: the staging header is split naively on `·` and the
// tag regex is end-anchored on `]`, so a token carrying `·`, `[`, `]` or a newline would corrupt
// every downstream parse. A positive whitelist (the shape every real token has) drops it instead.
const RE_VIA = /^[A-Za-z0-9:_-]+$/;
export function viaToken(via) {
  return typeof via === 'string' && RE_VIA.test(via) ? via : null;
}

// ---------- turn-body escaping (MEM-38 step 4 gate; nominally step 9, pulled forward because it
// shares a root with the `provenance: authored` forgery route) ----------
// read-pass.mjs splits staging on `\n#### `, so a body line beginning with `#### ` (a pasted
// document, a quoted transcript, a tool-error snippet) used to split into a turn of its own, header
// segments and all, and could therefore forge a typed human turn. Ordinary reversible backslash
// escaping: a line of zero-or-more backslashes followed by `#### ` gets one more backslash, and
// parseStaging's unescapeTurnBody takes exactly one back off.
// The escaping is only reversible, and the resulting headers only trustworthy, if the reader KNOWS
// the writer applied it, so it ships with an explicit format marker: STAGING_SCHEMA_VERSION 2 in the
// frontmatter means "bodies are escaped, headers are trustworthy". Files declaring anything less (or
// nothing) are read verbatim and never yield a channel (read-pass.mjs, parseStaging).
const escapeTurnBody = (s) => String(s).replace(/^(\\*)#### /gm, '\\$1#### ');

// Staging-file format version, unrelated to nodes.mjs/reconcile.mjs's node SCHEMA_VERSION: 1 = the
// original near-raw format (unescaped bodies), 2 = escaped bodies + trustworthy headers.
export const STAGING_SCHEMA_VERSION = 2;

// ---------- error log (silent toward the session, traceable for us) ----------
export function logError(err) {
  try {
    const p = resolve(MEMORY_ROOT, 'scopes', 'cockpit', 'staging', '.capture-errors.log');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`, 'utf8');
  } catch { /* truly nothing we can do — stay silent */ }
}

// ---------- the shared pipeline ----------
export async function capture({ entries, cwd, sessionId, event, provenance, brain } = {}) {
  sessionId = String(sessionId || 'unknown-session').replace(/[^a-zA-Z0-9_-]/g, '');
  cwd = cwd || process.cwd();
  event = event || 'Unknown';
  brain = brain || 'unknown';
  provenance = provenance || '(none)';
  if (!Array.isArray(entries)) entries = [];

  // Decide scope. Unmapped + no #capture opt-in -> skip entirely (no fabricated `global`).
  // COCKPIT_SCOPE is validated as a slug (Codex finding 5): a value with separators or '..'
  // must never reach ensureScope's path resolution — invalid -> ignored, fall through.
  const envScope = process.env.COCKPIT_SCOPE ? process.env.COCKPIT_SCOPE.trim() : null;
  let scope = isScopeSlug(envScope) ? envScope : mappedScope(cwd);
  if (!scope) {
    const userText = entries.filter((e) => e && e.role === 'user').map((e) => e.text || '').join('\n');
    scope = captureOptIn(userText);
    if (!scope) return { scope: null, skipped: 'no-scope' };
  }

  await ensureScope(scope);                            // lazily materializes dormant scopes (OPEN-7)

  const stagingDir = resolve(MEMORY_ROOT, 'scopes', scope, 'staging');
  const cursorDir = resolve(stagingDir, '.cursors');
  const cursorFile = resolve(cursorDir, `${sessionId}.json`);

  // how many source records have we already captured for this session?
  let cursor = 0;
  try { cursor = JSON.parse(readFileSync(cursorFile, 'utf8')).count || 0; } catch { /* fresh */ }

  if (entries.length <= cursor) return { scope, skipped: 'nothing-new', cursor };

  const fresh = entries.slice(cursor);
  const date = new Date().toISOString().slice(0, 10);
  const outFile = resolve(stagingDir, `${date}__${sessionId}.md`);
  const isNew = !existsSync(outFile);

  let out = '';
  // Frontmatter (and therefore the format marker) is written ONCE, when the file is created; every
  // later call only appends turns. So a file created before the step 4 gate and appended to after it
  // keeps declaring schema_version 1, and its genuinely stamped later turns lose their channel on
  // read. That is deliberate: existing frontmatter is never rewritten (a rewrite would be a claim
  // about bytes we did not write), and losing a tier is the conservative direction, where minting an
  // `authored` tier out of an unverifiable file is not.
  if (isNew) {
    out += `---\ntype: staging\nscope: ${scope}\nbrain: ${brain}\nsession_anchor: ${sessionId}\n`
        +  `transcript: ${provenance}\nstarted: ${new Date().toISOString()}\nschema_version: ${STAGING_SCHEMA_VERSION}\n---\n\n`
        +  `_Near-raw capture (MEM-16). Raw record is the source of truth (\`transcript:\` above);\n`
        +  `huge tool outputs are not duplicated here. Salience tags are mechanical (MEM-22), not judgments._\n\n`;
  }

  let appended = 0;
  for (const e of fresh) {
    const role = (e && e.role) || 'unknown';
    const text = (e && e.text) || '';
    const errored = !!(e && e.errored);
    if (!text && !errored) continue;                   // mechanical noise filter (tool plumbing)

    const tags = [];
    if (role === 'user') tags.push(...userSalience(text));
    if (errored) tags.push('error');
    const tagStr = tags.length ? `  [${[...new Set(tags)].join(', ')}]` : '';

    const via = viaToken(e && e.via);                  // MEM-38 step 2; omitted when absent
    const viaStr = via ? ` · ${via}` : '';

    out += `#### ${role} · ${(e && e.ts) || ''}${viaStr}${tagStr}\n${text ? escapeTurnBody(text) : '(tool error — see transcript)'}\n\n`;
    appended++;
  }

  const result = { scope, brain, outFile: relative(MEMORY_ROOT, outFile), isNew, cursor, newCursor: entries.length, appended };

  if (DRY) {
    console.log('[capture dry-run] ' + JSON.stringify(result, null, 2));
    console.log('--- would append (first 800 chars) ---\n' + out.slice(0, 800) + (out.length > 800 ? '\n…[truncated]' : ''));
    return result;
  }

  if (appended > 0 || isNew) appendFileSync(outFile, out, 'utf8');
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(cursorFile, JSON.stringify({ count: entries.length, event, updated: new Date().toISOString() }), 'utf8');
  return result;
}
