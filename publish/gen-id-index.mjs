#!/usr/bin/env node
// gen-id-index.mjs, the public index of internal decision identifiers.
//
// Shipped source comments and design docs cite decision IDs (MEM-38, WORK-1,
// DOC-3, OPEN-9). The ledger those IDs live in is private and never travels, so
// on a public clone the citations resolve to nothing. This generator reads the
// private ledger and writes one public file that maps each ID to a short title,
// and to nothing else: no decision, no reasoning, no relations, no depth links.
//
// Titles are scrubbed against publish/private-terms.txt, because a title can
// carry a venture, client, or person name the ledger exclusion exists to hold
// back. If any private term survives the scrub, the run fails and writes nothing.
//
// Usage:
//   node publish/gen-id-index.mjs                 write <repo>/DECISIONS-INDEX.md
//   node publish/gen-id-index.mjs --out PATH      write PATH instead
//   node publish/gen-id-index.mjs --stdout        print, write nothing
//   node publish/gen-id-index.mjs --check PATH    compare PATH, exit 1 on drift
//
// Deterministic: the same ledger produces the same bytes on every run.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LEDGERS = ['DECISIONS.md', 'DECISIONS-ARCHIVE.md'];
const TERMS_FILE = resolve(HERE, 'private-terms.txt');
const TITLE_MAX = 90;

// ── Arguments ─────────────────────────────────────────────────────────────────
let outPath = resolve(REPO, 'DECISIONS-INDEX.md');
let mode = 'write';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') outPath = resolve(argv[++i] ?? '');
  else if (a === '--stdout') mode = 'stdout';
  else if (a === '--check') { mode = 'check'; outPath = resolve(argv[++i] ?? ''); }
  else die(`unknown argument: ${a}`);
}

function die(msg) {
  process.stderr.write(`gen-id-index: ${msg}\n`);
  process.exit(1);
}

// ── Private terms ─────────────────────────────────────────────────────────────
// Longest first, so a compound rule is applied before the bare name inside it.
export function parseTerms(text) {
  const terms = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let body = line;
    let soft = false;
    if (body.startsWith('~')) { soft = true; body = body.slice(1).trim(); }
    const eq = body.indexOf('=');
    const term = (eq === -1 ? body : body.slice(0, eq)).trim();
    const placeholder = eq === -1 ? 'a private name' : body.slice(eq + 1).trim();
    if (!term) continue;
    terms.push({ term, placeholder, soft });
  }
  terms.sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
  return terms;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A term matches only where neither neighbour is a letter or a digit, so a short
// term never matches inside a longer ordinary word.
export function termRegex(term) {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, 'gi');
}

export function scrub(title, terms) {
  let out = title;
  for (const t of terms) out = out.replace(termRegex(t.term), t.placeholder);
  return out;
}

// ── Ledger parsing ────────────────────────────────────────────────────────────
// Two entry families are present, and the archive file uses both:
//   ### ID · Title  [Status date]        locked, superseded, designed, built
//   - **ID · Title** — body              open questions, live and resolved
// A third, flatter form appears in the live ledger's resolved-open pointer list:
//   - ID · Title → resolved into ...
// Bodies, Why, Rejected, Relates, and Depth lines are never read.
const HEADING = /^#{3}\s+([A-Z]+-\d+)\s+·\s+(.*)$/;
const BULLET_BOLD = /^-\s+\*\*([A-Z]+-\d+)\s+·\s+(.*?)\*\*(.*)$/;
const BULLET_PLAIN = /^-\s+([A-Z]+-\d+)\s+·\s+(.*)$/;

const STATUS_WORDS = [
  'locked', 'superseded', 'designed', 'built', 'shipped',
  'published', 'resolved', 'open', 'amended',
];

// The trailing [ ... ] of a heading carries the status trail. Only the first
// status word is kept: `Superseded` is useful to a reader and leaks nothing,
// while the dates and amendment history belong to the private ledger.
export function splitHeading(rest) {
  let title = rest.trim();
  let status = '';
  const open = title.lastIndexOf('[');
  if (open !== -1 && title.endsWith(']')) {
    const bracket = title.slice(open + 1, -1);
    title = title.slice(0, open).trim();
    const first = (bracket.trim().split(/[\s,;:]+/)[0] || '').toLowerCase();
    if (STATUS_WORDS.includes(first)) status = first;
  }
  return { title, status };
}

// An open-question bullet declares its own resolution in the body it precedes,
// in a handful of shapes: `— **RESOLVED → X**`, `**Status: RESOLVED ...**`, or
// a `→ resolved into X` pointer. Anything else is still open.
export function bulletStatus(tail) {
  return /\bresolved\b/i.test(tail) ? 'resolved' : 'open';
}

export function stripMarkup(s) {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Titles run long in the ledger. The index wants a short name, not a sentence,
// so a long title is cut at the last clause or word boundary that fits.
export function shorten(title) {
  let t = title;
  const cut = t.search(/\s+[—–-]{1,2}\s+/);
  if (cut > 20) t = t.slice(0, cut).trim();
  const sep = t.indexOf(';');
  if (sep > 20) t = t.slice(0, sep).trim();
  t = t.replace(/[.,;:·\s]+$/, '');
  if (t.length <= TITLE_MAX) return t;
  const head = t.slice(0, TITLE_MAX + 1);
  const space = head.lastIndexOf(' ');
  return `${(space > 20 ? head.slice(0, space) : t.slice(0, TITLE_MAX)).replace(/[.,;:·\s]+$/, '')}…`;
}

export function parseLedger(text) {
  const found = [];
  for (const line of text.split('\n')) {
    let m;
    if ((m = HEADING.exec(line))) {
      const { title, status } = splitHeading(m[2]);
      found.push({ id: m[1], title: stripMarkup(title), status });
    } else if ((m = BULLET_BOLD.exec(line))) {
      found.push({ id: m[1], title: stripMarkup(m[2]), status: bulletStatus(m[3]) });
    } else if ((m = BULLET_PLAIN.exec(line))) {
      const arrow = m[2].indexOf('→');
      const head = arrow === -1 ? m[2] : m[2].slice(0, arrow);
      found.push({ id: m[1], title: stripMarkup(head), status: bulletStatus(m[2]) });
    }
  }
  return found;
}

// One ID appears more than once: a live tombstone plus the archived body, or a
// pointer line plus the entry itself. The richest title wins, and a decided
// status beats a bare `open`, so the merge does not depend on file order.
export function merge(entries) {
  const byId = new Map();
  for (const e of entries) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, { ...e }); continue; }
    if (e.title.length > prev.title.length) prev.title = e.title;
    if (!prev.status || (prev.status === 'open' && e.status && e.status !== 'open')) {
      prev.status = e.status;
    }
  }
  return [...byId.values()].sort((a, b) => {
    const [ap, an] = a.id.split('-');
    const [bp, bn] = b.id.split('-');
    return ap.localeCompare(bp) || Number(an) - Number(bn);
  });
}

const HEADER = `# Cockpit decision index

An index of the internal decision identifiers this codebase cites. Source
comments and design documents refer to decisions in shorthand, as \`MEM-38\`,
\`WORK-1\`, \`DOC-3\`, or \`OPEN-9\`. This file says what each shorthand names, so a
reader who meets one is not left guessing.

It carries titles only. The reasoning behind each decision, the alternatives
weighed, and the trail of amendments live in a private ledger that is not part
of this repository. An engine ships the ledger mechanism; the entries belong to
whoever runs it.

Generated by \`publish/gen-id-index.mjs\`. Do not edit by hand.
`;

const LABEL = {
  locked: 'Locked', superseded: 'Superseded', designed: 'Designed',
  built: 'Built', shipped: 'Shipped', published: 'Published',
  resolved: 'Resolved', open: 'Open', amended: 'Amended',
};

export function render(entries, terms) {
  let scrubbed = 0;
  const lines = [HEADER, '| ID | Title | Status |', '| --- | --- | --- |'];
  for (const e of entries) {
    const title = scrub(shorten(e.title), terms);
    if (title !== shorten(e.title)) scrubbed++;
    const status = LABEL[e.status] || '';
    lines.push(`| \`${e.id}\` | ${title.replace(/\|/g, '\\|')} | ${status} |`);
  }
  lines.push('');
  return { text: lines.join('\n'), scrubbed };
}

// ── Run ───────────────────────────────────────────────────────────────────────
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// This generator ships inside the public export, because DECISIONS-INDEX.md names it as
// its source and a reader should be able to see how that file was produced. It cannot
// run there: both of its inputs, the scrub list and the private ledger, are held back by
// publish/manifest.txt. Say that plainly rather than dying on an ENOENT stack trace.
const termsText = readIfPresent(TERMS_FILE);
if (termsText === null) {
  process.stderr.write(
    'gen-id-index: nothing to generate here.\n' +
      '  This is a public export of the cockpit engine. The index it would write is\n' +
      '  derived from the owner\'s private decision ledger and scrubbed against the\n' +
      '  term list below, and neither of those travels (publish/manifest.txt). The\n' +
      '  shipped DECISIONS-INDEX.md is the finished output; regenerating it needs the\n' +
      '  source tree. Nothing was written, and nothing is wrong with this clone.\n' +
      `  missing: ${TERMS_FILE}\n`,
  );
  process.exit(0);
}
const terms = parseTerms(termsText);
if (terms.length === 0) die(`no terms parsed from ${TERMS_FILE}; refusing to run`);

// Past the gate this is the owner's tree, so a missing ledger is a real fault, not a
// clone. DECISIONS-ARCHIVE.md is optional: a young ledger has not archived anything yet.
const ledgers = LEDGERS.map((f) => [f, readIfPresent(resolve(REPO, f))]);
if (ledgers.every(([, text]) => text === null)) {
  die(`no decision ledger found in ${REPO} (looked for ${LEDGERS.join(', ')}); refusing to run`);
}
const entries = merge(
  ledgers.flatMap(([, text]) => (text === null ? [] : parseLedger(text))),
);
if (entries.length === 0) die('no ledger entries parsed; refusing to write an empty index');

const { text, scrubbed } = render(entries, terms);

// The load bearing check. Nothing is written until the output is clean, and a
// surviving term is a failure whether it is soft or hard: soft only softens how
// the export sweep grades OTHER files.
const survivors = [];
for (const t of terms) {
  const hits = text.match(termRegex(t.term));
  if (hits) survivors.push(`${t.term} (${hits.length}x)`);
}
if (survivors.length > 0) {
  process.stderr.write('gen-id-index: private terms survived the scrub. Nothing written.\n');
  for (const s of survivors) process.stderr.write(`  ${s}\n`);
  process.stderr.write('  Fix publish/private-terms.txt, or the title, then rerun.\n');
  process.exit(1);
}

if (mode === 'stdout') {
  process.stdout.write(text);
} else if (mode === 'check') {
  let current = null;
  try { current = readFileSync(outPath, 'utf8'); } catch { current = null; }
  if (current !== text) {
    process.stderr.write(`gen-id-index: ${outPath} is out of date with the ledger.\n`);
    process.stderr.write('  Run: node publish/gen-id-index.mjs, then commit the result.\n');
    process.exit(1);
  }
} else {
  writeFileSync(outPath, text);
}

process.stderr.write(
  `gen-id-index: ${entries.length} id(s), ${scrubbed} title(s) scrubbed, ${terms.length} term(s) loaded.\n`,
);
