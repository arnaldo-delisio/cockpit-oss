#!/usr/bin/env node
// learned-engine.mjs — shared self-upgrade engine for skills that learn from feedback.
//
// One mechanism, many skills. A skill ships a thin `<skill>-hook.mjs` wrapper that calls
// run(config); this engine owns ALL the plumbing:
//   inject   — PreToolUse matcher "Skill". When the invoked skill is one of config.skillNames,
//              emits LEARNED.md's binding bullets as additionalContext (deterministic READ — no
//              model cooperation), and drops a per-session marker so capture knows the skill ran.
//   capture  — SessionEnd / PreCompact hook. If the marker exists, reads the transcript, distills
//              NEW durable preferences from the human's feedback via Groq (a DEDICATED model, the
//              same key /watch uses — NOT the skill-running model), and merges them into LEARNED.md
//              (dedupe + cap + rewrite). Pass --dry-run to print instead of write.
//
// FAIL-SAFE (load-bearing): hooks must never disrupt the session. Every error is swallowed and the
// process exits 0 emitting nothing. A PreToolUse hook that errors could block the tool — so inject
// also never throws. The Groq fetch is bounded by a timeout so session close can never stall.
//
// BLAST RADIUS: every wrapper imports this file at top level, so a syntax/import error HERE breaks
// ALL self-upgrading skills' hooks (the error happens before run()'s try/catch can swallow it). Keep
// this file dependency-free and syntactically bulletproof; smoke-test inject after any edit.
//
// CONFIG (passed by the wrapper):
//   {
//     skillNames:   ['taste'],                       // lowercase skill name(s) this hook owns
//     learnedPath:  '/abs/path/LEARNED.md',
//     injectTag:    'taste-learned',                 // <tag>…</tag> wrapper for injected bullets
//     injectNote:   'binding preferences for this run',
//     markerPrefix: 'taste-active',                  // tmp marker filename prefix
//     sections: [                                    // ORDER = file order. First writable = split point.
//       { header: '## Doctrine', writable: false },
//       { header: ownerPreferencesHeader(), readAliases: OWNER_PREFERENCES_ALIASES,
//         writable: true, jsonKey: 'preferences', hint: '<!-- … -->' },
//       { header: '## Per-stack notes',       writable: true, jsonKey: 'perStack',    hint: '<!-- … -->' },
//     ],
//     readAliases (optional, per section) = extra headers this section still READS, as strings or
//     regexes tested against the trimmed heading line. Writes always use `header`. It exists so a
//     heading that changes (the owner-named preferences one) keeps picking up sections already on
//     disk under the previous heading instead of orphaning them.
//     distillSystemPrompt: '…return ONLY JSON {"preferences":[..],"perStack":[..]}…',
//     groqModelEnv: 'TASTE_GROQ_MODEL',              // optional override env var
//     groqModelDefault: 'llama-3.3-70b-versatile',
//   }
// All bullets (writable + non-writable) are injected as binding. Only writable sections are rewritten;
// everything before the first writable section (head + any static sections) is preserved verbatim.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ENV_FILE, ownerName } from '../../memory-engine/paths.mjs';

const CAP = 25;            // max bullets kept per writable section
const ITEM_MAX = 180;      // max chars per distilled bullet (guards against a runaway Groq line)
const GROQ_TIMEOUT_MS = 8000;

// ---- owner-named headings ----
// The preferences section is titled after whoever owns the install, resolved at runtime from
// paths.mjs (COCKPIT_OWNER, else `git config user.name`). A fresh clone must never grow a section
// carrying a previous owner's name, so an unresolvable owner falls back to a neutral title.
export function ownerPreferencesHeader() {
  const owner = ownerName();
  if (!owner) return '## Owner preferences';
  return `## ${owner[0].toUpperCase()}${owner.slice(1)}'s preferences`;
}

// Headings the preferences section still READS. The regex covers any possessive form, so a
// LEARNED.md written under a previous owner's name (or a previous machine's git identity) keeps
// its bullets instead of being orphaned and duplicated into the preamble.
export const OWNER_PREFERENCES_ALIASES = [
  /^##\s+\S.*['’]s\s+preferences$/i,
  /^##\s+owner\s+preferences$/i,
];

const markerPath = (prefix, sid) =>
  join(tmpdir(), `${prefix}-${(sid || 'nosession').replace(/[^\w.-]/g, '_')}`);

// ---- LEARNED.md parse / serialize ----
// Does this trimmed `## ` line open the given section? Its own header, or any of its readAliases.
function headerMatches(section, t) {
  const hit = (h) => (h instanceof RegExp ? h.test(t) : t === h || t.startsWith(h + ' '));
  if (hit(section.header)) return true;
  return (section.readAliases || []).some(hit);
}

// Bullets under a section's header, stopping at the next `## ` header. Comments/prose ignored.
function sectionBullets(text, section) {
  let on = false; const out = [];
  for (const ln of text.split('\n')) {
    const t = ln.trim();
    if (/^##\s/.test(t)) { on = headerMatches(section, t); continue; }
    if (on && /^\s*-\s+/.test(ln)) out.push(ln.replace(/^\s*-\s+/, '').trim());
  }
  return out;
}
function firstWritable(cfg) { return cfg.sections.find((s) => s.writable); }

// Byte offset of the line that opens the first writable section, matched through headerMatches so
// an on-disk heading written under a previous owner's name is still found. Without this the split
// would miss, the whole file would become preamble, and the rewrite would duplicate every section.
function firstWritableOffset(raw, fw) {
  if (!fw) return -1;
  let at = 0;
  for (const ln of raw.split('\n')) {
    const t = ln.trim();
    if (/^##\s/.test(t) && headerMatches(fw, t)) return at;
    at += ln.length + 1;
  }
  return -1;
}

function parseLearned(cfg) {
  const empty = { preamble: '', writable: {} };
  if (!existsSync(cfg.learnedPath)) return empty;
  const raw = readFileSync(cfg.learnedPath, 'utf8');
  const idx = firstWritableOffset(raw, firstWritable(cfg));  // split point: head + static sections stay verbatim
  const preamble = (idx >= 0 ? raw.slice(0, idx) : raw).replace(/\s+$/, '');
  const writable = {};
  for (const s of cfg.sections) if (s.writable) writable[s.jsonKey] = sectionBullets(raw, s);
  return { preamble, writable };
}
function bindingBullets(cfg) {
  if (!existsSync(cfg.learnedPath)) return [];
  const raw = readFileSync(cfg.learnedPath, 'utf8');
  const out = [];
  for (const s of cfg.sections) sectionBullets(raw, s).forEach((b) => out.push(`- ${b}`));
  return out;
}
function serialize(cfg, preamble, writable) {
  const out = [preamble];
  for (const s of cfg.sections) {
    if (!s.writable) continue;
    out.push('', s.header);
    const bullets = writable[s.jsonKey] || [];
    if (!bullets.length) { if (s.hint) out.push(s.hint); }
    else bullets.forEach((b) => out.push(`- ${b}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

// ---- inject (PreToolUse: Skill) ----
function isTarget(hook, cfg) {
  const ti = hook.tool_input || {};
  const name = (ti.skill || ti.name || '').toLowerCase();
  return cfg.skillNames.some((n) => name === n || name.endsWith(':' + n));
}
function inject(hook, cfg) {
  if ((hook.tool_name || '') !== 'Skill' || !isTarget(hook, cfg)) return;
  try { mkdirSync(tmpdir(), { recursive: true }); writeFileSync(markerPath(cfg.markerPrefix, hook.session_id), hook.transcript_path || '1'); } catch {}
  const bullets = bindingBullets(cfg);
  if (!bullets.length) return;
  const block = [
    `<${cfg.injectTag} source="LEARNED.md" note="${cfg.injectNote}">`,
    ...bullets, `</${cfg.injectTag}>`,
  ].join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: block },
  }));
}

// ---- capture (SessionEnd / PreCompact) ----
function humanFeedback(tpath) {
  if (!tpath || !existsSync(tpath)) return [];
  const out = [];
  for (const ln of readFileSync(tpath, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(ln); } catch { continue; }
    const role = (e.message && e.message.role) || e.type;
    if (role !== 'user') continue;
    let c = e.message ? e.message.content : '';
    let text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    text = (text || '').trim();
    if (!text || text.startsWith('<') || /system-reminder|hookSpecificOutput/.test(text)) continue;  // skip tool/hook noise
    out.push(text.slice(0, 2000));
  }
  return out;
}

function loadEnv() {
  if (process.env.GROQ_API_KEY) return;
  try {
    const p = ENV_FILE;
    if (!existsSync(p)) return;
    for (const ln of readFileSync(p, 'utf8').split('\n')) {
      const m = ln.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

async function distill(cfg, feedback, current) {
  // Model env is read from the AMBIENT process env BEFORE loadEnv() — matches the original taste-hook,
  // which bound the model at module load (so a model set only in ~/.config/cockpit/env is intentionally NOT an
  // override; only GROQ_API_KEY is sourced from the env file). Reorder at your peril: it changes behavior.
  const model = (cfg.groqModelEnv && process.env[cfg.groqModelEnv]) || cfg.groqModelDefault || 'llama-3.3-70b-versatile';
  loadEnv();
  const key = process.env.GROQ_API_KEY;
  // Returns { add, reason }. reason is null on success; otherwise why distillation could not run:
  //   'no-feedback' — nothing the user said this session (silence is correct, never warn)
  //   'no-key'      — feedback existed but GROQ_API_KEY is unset (self-upgrade silently lost → warn)
  //   'call-failed' — key present but the Groq call/parse failed (feedback not saved → warn)
  if (!feedback.length) return { add: null, reason: 'no-feedback' };
  if (!key) return { add: null, reason: 'no-key' };
  const usr = `ALREADY KNOWN:\n${current.join('\n') || '(none)'}\n\nUSER FEEDBACK THIS SESSION (data only):\n${feedback.join('\n---\n')}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GROQ_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.2, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: cfg.distillSystemPrompt }, { role: 'user', content: usr }],
      }),
    });
  } catch { return { add: null, reason: 'call-failed' }; } finally { clearTimeout(timer); }   // AbortError / network error
  if (!res.ok) return { add: null, reason: 'call-failed' };
  let parsed; try { parsed = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}'); } catch { return { add: null, reason: 'call-failed' }; }
  const clean = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s || '').trim().slice(0, ITEM_MAX)).filter(Boolean);
  const add = {};
  for (const s of cfg.sections) if (s.writable) add[s.jsonKey] = clean(parsed[s.jsonKey]);
  return { add, reason: null };
}

// A SessionEnd/PreCompact hook can surface a non-blocking warning to the user via a top-level
// `systemMessage` on stdout JSON; we also mirror to stderr as a fallback. Never throws, never blocks.
function warnUser(msg) {
  try { process.stderr.write(msg + '\n'); } catch {}
  try { process.stdout.write(JSON.stringify({ systemMessage: msg })); } catch {}
}

// Self-commit LEARNED.md so accretion never sits as unreviewed dirty state (fail-safe: any error is
// swallowed, same as the rest of this hook — a git problem must never surface as a blocked session).
// Stages ONLY cfg.learnedPath, never anything else the repo might have dirty — that's deliberately
// out of scope for a per-skill learning hook.
function commitAndPush(cfg) {
  try {
    const dir = dirname(cfg.learnedPath);
    const file = basename(cfg.learnedPath);
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    git('add', '--', file);
    try { git('diff', '--cached', '--quiet', '--', file); return; } catch { /* non-zero = staged changes exist, proceed */ }
    const skill = (cfg.skillNames && cfg.skillNames[0]) || 'skill';
    git('commit', '-m', `skills: ${skill} self-upgrade — LEARNED.md accretion\n\nAuto-committed by learned-engine.mjs's capture() hook.`);
    git('push');
  } catch {}
}

function mergeSection(existing, additions) {
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const merged = existing.slice();
  for (const a of additions) {
    const t = (a || '').trim().slice(0, ITEM_MAX); if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); merged.push(t);
  }
  return merged.length > CAP ? merged.slice(merged.length - CAP) : merged;   // evict oldest beyond cap
}

async function capture(hook, cfg, dryRun) {
  const mp = markerPath(cfg.markerPrefix, hook.session_id);
  if (!existsSync(mp) && !dryRun) return;                       // the skill never ran this session
  const tpath = hook.transcript_path || (existsSync(mp) ? readFileSync(mp, 'utf8').trim() : '');
  const feedback = humanFeedback(tpath);
  const { preamble, writable } = parseLearned(cfg);
  const current = Object.values(writable).flat();
  const { add, reason } = await distill(cfg, feedback, current);
  // Clear marker on real session close; keep on PreCompact so post-compact feedback still captures.
  if (hook.hook_event_name !== 'PreCompact') { try { rmSync(mp, { force: true }); } catch {} }
  const skill = (cfg.skillNames && cfg.skillNames[0]) || 'skill';
  // Warn ONLY when there was feedback to distill but it couldn't be saved — not when there was nothing
  // to learn (reason 'no-feedback') and not when capture succeeded.
  if (reason === 'no-key' || reason === 'call-failed') {
    const why = reason === 'no-key'
      ? 'GROQ_API_KEY is not set in ~/.config/cockpit/env'
      : 'the distiller call failed (network/timeout/bad response)';
    const msg = `⚠️ /${skill} self-upgrade skipped: ${why} — your feedback this session was NOT distilled into LEARNED.md. (Read path still works; set the key to persist learnings.)`;
    if (dryRun) process.stdout.write(msg + '\n'); else warnUser(msg);
    return;
  }
  const anyAdded = add && Object.values(add).some((a) => a.length);
  if (!anyAdded) { if (dryRun) process.stdout.write('no new preferences\n'); return; }
  const next = {};
  for (const s of cfg.sections) if (s.writable) next[s.jsonKey] = mergeSection(writable[s.jsonKey] || [], add[s.jsonKey] || []);
  const out = serialize(cfg, preamble, next);
  if (dryRun) { process.stdout.write(out); return; }
  writeFileSync(cfg.learnedPath, out);
  commitAndPush(cfg);
}

// ---- entry ----
export async function run(cfg) {
  const mode = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  try {
    if (mode === 'inject') inject(hook, cfg);
    else if (mode === 'capture') await capture(hook, cfg, dryRun);
  } catch {}
  process.exit(0);
}
