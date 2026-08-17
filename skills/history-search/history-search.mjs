#!/usr/bin/env node
// history-search.mjs — cited search over past raw agent sessions (TOOL-8, v1.1).
//
// A disposable FTS5 cache (node:sqlite — zero deps, Node >= 22.5) over the raw agent
// histories, in ctx's sessions -> events -> citations shape:
//   Claude Code  ~/.claude/projects/**/*.jsonl   (indexed, allowlist-gated)
//   Codex        ~/.codex/sessions/**/*.jsonl    (indexed, allowlist-gated)
//   Hermes       ~/.hermes/state.db              (NOT indexed — queried read-only at
//                search time via the FTS5 tables Hermes itself maintains; SHARED home
//                only — a confidential venture's own HERMES_HOME is never touched)
//
// SURFACE ALLOWLIST (agreed 2026-07-03; mirrors the MEM-14 capture scope-gate):
//   a session enters the index ONLY if its recorded cwd maps to a live scope —
//   <repo> -> cockpit, or <repo>/scopes/<x> (deepest match first,
//   layout §6) with <x> present in memory/scopes.json.
//   * a scope-root <x> NOT in scopes.json (e.g. a confidential venture) -> HARD SKIP,
//     no sentinel override — absence from scopes.json is a deliberate wall (MEM-32).
//   * cwd outside both trees (scratch/vault/one-offs) -> skipped, UNLESS the session
//     text carries the #capture / #capture:<scope> opt-in sentinel (MEM-14 mirror).
//   Skips are remembered in the files table so unchanged files are never re-read.
//
// Freshness is FILE-level, never event checkpoints: a source file whose mtime+size
// changed is dropped and re-ingested whole — idempotent. The index is a cache:
// deleting it loses convenience, never knowledge (MEM-15/24). Full rebuild = --rebuild.
//
// Usage:
//   node history-search.mjs index [--rebuild]
//   node history-search.mjs search "<query>" [-n <max>] [--no-refresh] [--no-hermes]
//   node history-search.mjs list [-n 20] [--project <scope>]
//   node history-search.mjs show <file>[:<line>] [--around <turns>]
//   node history-search.mjs hook          Claude Code UserPromptSubmit hook (stdin JSON).
//     Silent unless the turn references past work (lexical gate or #history sentinel);
//     injects <=4 cited hits, current-project hits ranked first; a hit repeats within a
//     session as a one-line back-reference, not a re-injected snippet. Marked block,
//     killable (COCKPIT_HISTORY_RECALL=off), fail-safe (always exit 0, stderr muted).

import { DatabaseSync } from 'node:sqlite';
import {
  readFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync, realpathSync,
} from 'node:fs';
import { resolve, join, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { liveScopes, cwdScope } from './scope-gate.mjs';

export { liveScopes, cwdScope };   // re-exported for existing importers (DESIGN §6a.8)
const SCOPES = liveScopes();       // snapshot at load, same as scope-gate.mjs's own internal snapshot

const HOME = homedir();
const DB_PATH = process.env.HISTORY_INDEX_DB || resolve(HOME, '.cache', 'cockpit-history-index.db');
const ROOTS = [join(HOME, '.claude', 'projects'), join(HOME, '.codex', 'sessions')]
  .map((p) => resolve(p)).filter((p) => existsSync(p));
const HERMES_DB = resolve(HOME, '.hermes', 'state.db');

const RE_CAPTURE = /(?:^|\s)#capture(?::([a-z0-9][a-z0-9-]*))?\b/i;

// One-pass parse of a transcript: scope decision + extracted events together.
// SPOOF-RESISTANT (Codex review 2026-07-03): the cwd is read ONLY from a parsed record's
// top-level `cwd` (Claude) / `payload.cwd` (Codex session_meta) property — never from a raw
// regex over file text, which pasted message content could satisfy first. Likewise the
// #capture opt-in is matched only against extracted USER turns (MEM-14 semantics), and only
// after the walled check — a walled file can never opt itself in (fail-closed).
function analyzeFile(raw, path) {
  const extract = extractorFor(path);
  const lines = raw.split('\n');
  let cwd = null;
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let obj = null;
    try { obj = JSON.parse(lines[i]); } catch { continue; }  // malformed line — skip
    if (cwd === null) {
      const c = typeof obj.cwd === 'string' ? obj.cwd
        : (obj.payload && typeof obj.payload.cwd === 'string' ? obj.payload.cwd : null);
      if (c) cwd = c;
    }
    const e = extract(obj);
    if (e) events.push({ ...e, line: i + 1 });
  }
  let scope = cwdScope(cwd);
  if (scope === 'walled') return { scope: 'skip', events: [] };   // fail-closed — no override
  if (!scope) {
    const userText = events.filter((e) => e.role === 'user').map((e) => e.text).join('\n');
    const opt = userText.match(RE_CAPTURE);                       // MEM-14 opt-in for unmapped
    scope = opt ? (opt[1] || 'global').toLowerCase() : null;
  }
  return scope ? { scope, events } : { scope: 'skip', events: [] };
}

// ---------- per-provider event extractors (text turns only — tool plumbing is noise) ----------
function claudeEvent(obj) {
  if (obj.isMeta || (obj.type !== 'user' && obj.type !== 'assistant') || !obj.message) return null;
  const c = obj.message.content;
  const text = (typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '').trim();
  return text ? { role: obj.message.role || obj.type, text, ts: obj.timestamp || '', session: obj.sessionId || '' } : null;
}
function codexEvent(obj) {
  const p = obj.type === 'response_item' ? obj.payload : null;
  if (!p || p.type !== 'message' || p.role === 'developer') return null;
  const text = (Array.isArray(p.content) ? p.content : [])
    .filter((b) => b && (b.type === 'input_text' || b.type === 'output_text'))
    .map((b) => b.text).join('\n').trim();
  return text ? { role: p.role, text, ts: obj.timestamp || '', session: '' } : null;
}
const extractorFor = (path) => (path.includes(`${sep}.codex${sep}`) ? codexEvent : claudeEvent);

// ---------- index ----------
function openIndex() {
  mkdirSync(resolve(DB_PATH, '..'), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  try { db.prepare('SELECT scope FROM files LIMIT 1').all(); } catch {
    db.exec('DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS surfaced;'); // pre-v1.1 schema -> rebuild
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, scope TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS events USING fts5(
      text, role UNINDEXED, ts UNINDEXED, file UNINDEXED, line UNINDEXED, session UNINDEXED, scope UNINDEXED);
    CREATE TABLE IF NOT EXISTS surfaced(session TEXT, file TEXT, line INTEGER, PRIMARY KEY(session, file, line));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

// MEM-32 containment: a symlink under an allowed root must not smuggle in a file that
// really lives outside the allowlist — resolve every candidate and keep only true residents.
function listJsonl() {
  const out = [];
  for (const root of ROOTS) {
    const rootReal = realpathSync(root);
    for (const f of readdirSync(root, { recursive: true })) {
      if (!String(f).endsWith('.jsonl')) continue;
      const path = join(root, String(f));
      try {
        if (realpathSync(path).startsWith(rootReal + sep)) out.push(path);
      } catch { /* dangling symlink — skip */ }
    }
  }
  return out;
}

function refreshIndex(db, { quiet = false } = {}) {
  const t0 = Date.now();
  const seen = new Set();
  const known = new Map(db.prepare('SELECT path, mtime, size FROM files').all()
    .map((r) => [r.path, `${r.mtime}:${r.size}`]));
  // Allowlist versioning (Codex review 2026-07-03): remembered skip/scope decisions are only
  // valid for the scopes.json they were made under. If the allowlist changed, re-evaluate
  // EVERY file this pass (a scope added -> its history enters; removed -> its events leave).
  const allowNow = JSON.stringify([...SCOPES].sort());
  const allowRow = db.prepare("SELECT value FROM meta WHERE key = 'allowlist'").all()[0];
  const forceAll = !allowRow || allowRow.value !== allowNow;
  const delEvents = db.prepare('DELETE FROM events WHERE file = ?');
  const insEvent = db.prepare('INSERT INTO events(text, role, ts, file, line, session, scope) VALUES(?,?,?,?,?,?,?)');
  const upsertFile = db.prepare('INSERT OR REPLACE INTO files(path, mtime, size, scope) VALUES(?,?,?,?)');
  let changed = 0, events = 0, skipped = 0;

  for (const path of listJsonl()) {
    seen.add(path);
    const st = statSync(path);
    if (!forceAll && known.get(path) === `${st.mtimeMs}:${st.size}`) continue;   // unchanged (incl. remembered skips)
    db.exec('BEGIN');
    try {
      delEvents.run(path);
      const { scope, events: evs } = analyzeFile(readFileSync(path, 'utf8'), path);
      if (scope !== 'skip') {
        const fallbackSession = basename(path, '.jsonl');
        for (const e of evs) { insEvent.run(e.text, e.role, e.ts, path, e.line, e.session || fallbackSession, scope); events++; }
        changed++;
      } else skipped++;
      upsertFile.run(path, st.mtimeMs, st.size, scope);             // skips are remembered too
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`(skipped ${short(path)}: ${err.message})`);
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('allowlist', ?)").run(allowNow);
  // sources that disappeared take their events with them
  for (const [path] of known) {
    if (!seen.has(path)) {
      db.exec('BEGIN');
      delEvents.run(path);
      db.prepare('DELETE FROM files WHERE path = ?').run(path);
      db.exec('COMMIT');
    }
  }
  if (!quiet) console.log(`index: ${changed} file(s) ingested, ${skipped} outside the surface, ${events} events, ${Date.now() - t0} ms  [${DB_PATH}]`);
}

// ---------- search ----------
const ftsQuery = (q) => q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
const short = (p) => p.replace(HOME, '~');

// BM25-ranked, current-scope hits first (preference, not a wall — fallback is the rest).
// Local hits come from their own scoped query so cross-scope volume can never crowd them out.
const SEL = `SELECT snippet(events, 0, '>>', '<<', ' … ', 18) snip, role, ts, file, line, session, scope
    FROM events WHERE events MATCH ?`;
function searchIndex(db, query, limit, { localScope = null, or = false } = {}) {
  const q = or
    ? query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    : ftsQuery(query);
  if (!localScope) return db.prepare(`${SEL} ORDER BY rank LIMIT ?`).all(q, limit);
  const local = db.prepare(`${SEL} AND scope = ? ORDER BY rank LIMIT ?`).all(q, localScope, limit);
  if (local.length >= limit) return local;
  const rest = db.prepare(`${SEL} AND scope != ? ORDER BY rank LIMIT ?`).all(q, localScope, limit - local.length);
  return [...local, ...rest];
}

function searchHermes(query, limit) {
  if (!existsSync(HERMES_DB)) return [];
  let db = null;
  try {
    db = new DatabaseSync(HERMES_DB, { readOnly: true });
    const rows = db.prepare(`
      SELECT snippet(messages_fts, 0, '>>', '<<', ' … ', 18) snip, m.role, m.timestamp ts,
             m.session_id session, m.id
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery(query), limit);
    return rows.map((r) => ({ ...r, ts: new Date(r.ts * 1000).toISOString(), file: HERMES_DB, line: `msg${r.id}`, scope: 'hermes' }));
  } catch (err) { console.error(`(hermes search skipped: ${err.message})`); return []; }
  finally { try { db?.close(); } catch { /* already closed */ } }
}

function printGrouped(rows) {
  const bySession = new Map();
  for (const r of rows) {
    const key = `${r.session} · ${r.scope || '?'} · ${short(r.file)}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(r);
  }
  for (const [key, hits] of bySession) {
    console.log(`\n— session ${key}`);
    for (const h of hits) {
      console.log(`  ${short(h.file)}:${h.line} · ${h.role} · ${h.ts}`);
      console.log(`    ${h.snip.replace(/\s+/g, ' ').trim()}`);
    }
  }
}

// ---------- show / list — read past conversations without touching raw JSONL ----------
// show honors the surface wall: it only renders files inside the transcript roots whose
// scope decision is not 'skip' — a walled (confidential) transcript can't be rendered
// through the tool. (Raw filesystem access is outside this tool's threat model.)
function renderFile(path, { line = null, around = 5 } = {}) {
  const real = realpathSync(path);
  if (!ROOTS.some((r) => real.startsWith(realpathSync(r) + sep))) {
    console.log(`outside the transcript roots: ${short(path)}`); return;
  }
  const { scope, events: turns } = analyzeFile(readFileSync(path, 'utf8'), path);
  if (scope === 'skip') { console.log(`outside the search surface (walled or unscoped): ${short(path)}`); return; }
  let slice = turns;
  if (line !== null) {
    let idx = turns.findIndex((t) => t.line >= line);
    if (idx === -1) idx = turns.length - 1;
    slice = turns.slice(Math.max(0, idx - around), idx + around + 1);
  }
  console.log(`# ${short(path)}${line !== null ? ` (window around :${line})` : ''} — ${slice.length}/${turns.length} turns\n`);
  for (const t of slice) {
    console.log(`── ${t.role} · ${t.ts} · :${t.line}`);
    console.log(t.text.trim() + '\n');
  }
}

function listSessions(db, { limit = 20, project = null } = {}) {
  const where = project ? 'WHERE scope = ?' : '';
  const files = db.prepare(`
    SELECT file, scope, MIN(ts) start, COUNT(*) n FROM events ${where}
    GROUP BY file ORDER BY start DESC LIMIT ?`).all(...(project ? [project, limit] : [limit]));
  const firstUser = db.prepare(`
    SELECT text FROM events WHERE file = ? AND role = 'user' ORDER BY line LIMIT 1`);
  for (const f of files) {
    const u = firstUser.all(f.file)[0];
    const title = u ? u.text.replace(/\s+/g, ' ').trim().slice(0, 110) : '(no user turn)';
    console.log(`${String(f.start).slice(0, 10)} · ${f.scope} · ${f.n} turns · ${short(f.file)}`);
    console.log(`    ${title}`);
  }
  if (!files.length) console.log('(no sessions in the surface' + (project ? ` for scope ${project}` : '') + ')');
}

// ---------- ambient hook (Claude Code UserPromptSubmit) ----------
// FAIL-SAFE (load-bearing, same contract as recall-hook.mjs): a UserPromptSubmit hook that
// exits non-zero or prints to stderr BLOCKS the user's prompt. History recall is a
// non-essential enhancement — every error is swallowed, stderr is muted, always exit 0.
const PAST_REF = [
  /\b(?:last|previous|earlier|past|old|prior)\s+(?:sessions?|conversations?|chats?|discussions?)\b/i,
  /\blast\s+time\b/i,
  /\bwe\s+(?:discussed|talked\s+about|decided|agreed|tried|built|fixed|saw|already\s+did)\b/i,
  /\bwhich\s+session\b/i,
  /\bremember\s+(?:when|that|what|how)\b/i,
  /\bthat\s+(?:error|bug|command|failure|fix)\s+(?:we|from|again)\b/i,
];
const STOP = new Set(('the and that this with from have was were what when which where how why you your our are for not but can did does about into over under again then than them they there here just like some any all one two been being would could should session sessions conversation conversations chat chats discussion discussions last previous earlier past old prior time remember discussed talked decided agreed tried built fixed saw').split(' '));
const terms = (text) => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu) || []).filter((w) => !STOP.has(w)))].slice(0, 8);

function runHook() {
  console.error = () => {};                       // stderr blocks the prompt — mute it
  if (process.env.COCKPIT_HISTORY_RECALL === 'off') return;
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const prompt = String(hook.prompt || '').slice(0, 20000);   // bound regex/term work on huge pastes
  const force = prompt.match(/(?:^|\s)#history\b([^\n]*)/i);   // query = rest of THAT line only
  if (!force && !PAST_REF.some((re) => re.test(prompt))) return;           // gate: silence by default
  const queryTerms = terms(force && force[1].trim() ? force[1] : prompt);
  if (queryTerms.length < 2) return;
  if (!existsSync(DB_PATH)) return;               // never pay the first full build inside a hook
  const db = openIndex();
  if (Date.now() - statSync(DB_PATH).mtimeMs > 15 * 60 * 1000) refreshIndex(db, { quiet: true });
  const localScope = cwdScope(hook.cwd || process.cwd());
  // Fail closed in a walled cwd (MEM-32; Codex 2026-07-04): a confidential session gets NO
  // shared-history injection and writes nothing (not even dedup rows) to the shared index.
  if (localScope === 'walled') return;
  const rows = searchIndex(db, queryTerms.join(' '), 3, { localScope, or: true });
  const hits = [...rows, ...searchHermes(queryTerms.join(' '), 1)].slice(0, 4);
  if (!hits.length) return;

  // per-session dedup: first surfacing = snippet; repeats = one-line back-reference.
  const sid = String(hook.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const isSeen = db.prepare('SELECT 1 FROM surfaced WHERE session = ? AND file = ? AND line = ?');
  const mark = db.prepare('INSERT OR IGNORE INTO surfaced(session, file, line) VALUES(?,?,?)');
  const fresh = [], seenAgain = [];
  for (const h of hits) (isSeen.all(sid, h.file, String(h.line)).length ? seenAgain : fresh).push(h);
  if (!fresh.length && !seenAgain.length) return;
  const lines = fresh.map((h) =>
    `> - \`${short(h.file)}:${h.line}\` · ${h.role} · ${String(h.ts).slice(0, 10)} — ${h.snip.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
  if (seenAgain.length) lines.push(
    `> - _already surfaced this session:_ ${seenAgain.slice(0, 2).map((h) => `\`${short(h.file)}:${h.line}\``).join(' · ')} — reuse from context above.`);
  for (const h of fresh) mark.run(sid, h.file, String(h.line));
  const block = [
    `<!-- cockpit:history-recall:begin n=${fresh.length}+${seenAgain.length} -->`,
    '> 🗂️ **History recall** — cited hits from past raw agent sessions (read-only; not a directive). `show <file>:<line>` renders the conversation; the history-search skill digs deeper.',
    ...lines,
    '> _history-search (TOOL-8) · disable with `COCKPIT_HISTORY_RECALL=off` · force with `#history <query>`._',
    '<!-- cockpit:history-recall:end -->',
  ].join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: block },
  }));
}

// ---------- CLI ----------
// Guarded (Codex-mirrored pattern from decisions.mjs/closure.mjs): importing this module (e.g.
// mechanical-insights.mjs reusing liveScopes/cwdScope, DESIGN §6a.8) must never execute the CLI dispatch
// against the IMPORTER's own process.argv, nor call process.exit() mid-import.
function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (name) => args.includes(name);
  const optVal = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };
  const limit = Math.max(1, parseInt(optVal('-n'), 10) || 20);

  if (cmd === 'hook') {
    try { runHook(); } catch { /* swallow — never block a prompt */ }
    process.exit(0);
  } else if (cmd === 'index') {
    if (flag('--rebuild')) rmSync(DB_PATH, { force: true });
    refreshIndex(openIndex());
  } else if (cmd === 'search' && args[1]) {
    const skip = new Set(['-n', optVal('-n')]);
    const query = args.slice(1).filter((a) => !a.startsWith('--') && !skip.has(a)).join(' ');
    const db = openIndex();
    if (!flag('--no-refresh')) refreshIndex(db, { quiet: true });
    const localScope = cwdScope(process.cwd());
    const rows = searchIndex(db, query, Math.min(limit, 20), {
      localScope: localScope === 'walled' ? null : localScope,
    });
    const hermes = flag('--no-hermes') ? [] : searchHermes(query, Math.min(limit, 20));
    if (!rows.length && !hermes.length) { console.log('(no matches)'); process.exit(0); }
    if (rows.length) { console.log(`## Claude Code + Codex (${rows.length})`); printGrouped(rows); }
    if (hermes.length) { console.log(`\n## Hermes (${hermes.length})`); printGrouped(hermes); }
  } else if (cmd === 'list') {
    listSessions(openIndex(), { limit, project: optVal('--project') });
  } else if (cmd === 'show' && args[1]) {
    const m = args[1].match(/^(.*?)(?::(\d+))?$/);
    const path = resolve(m[1].replace(/^~(?=\/|$)/, HOME));
    if (!existsSync(path)) { console.log(`no such file: ${path}`); process.exit(1); }
    renderFile(path, { line: m[2] ? +m[2] : null, around: Math.max(1, parseInt(optVal('--around'), 10) || 5) });
  } else {
    console.log('usage: history-search.mjs index [--rebuild] | search "<query>" [-n <max>] [--no-refresh] [--no-hermes] | list [-n 20] [--project <scope>] | show <file>[:<line>] [--around <turns>]');
    process.exit(cmd ? 1 : 0);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runCli();
