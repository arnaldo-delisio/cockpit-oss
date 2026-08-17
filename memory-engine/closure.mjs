#!/usr/bin/env node
// closure.mjs — the declare/revive/close/graduate/archive verbs over Project objects (WORK-1 B1;
// close/graduate/archive shipped in the closure/graduation spike).
//
//   node closure.mjs declare  <scope> <id> --kind <finite|practice> --body <file>
//                     [--started YYYY-MM-DD] [--declared YYYY-MM-DD] [--tags a,b] [--relates id,id]
//                     [--depends-on id,id] [--dry-run]
//   node closure.mjs revive   <scope> <new-id> --supersedes <old-id> --kind <finite|practice>
//                     --body <file> [--started YYYY-MM-DD] [--tags a,b] [--relates id,id]
//                     [--depends-on id,id] [--dry-run]
//   node closure.mjs close    <scope> <id> --outcome <o> --residue <file> [--closed YYYY-MM-DD] [--dry-run]
//   node closure.mjs graduate <scope> <id> --note "<judged depth>" [--dry-run]
//   node closure.mjs archive  <scope> <id> [--dry-run]
//
// Monotonic lifecycle (declare → active → closed → graduated → archived) on the canonical object
// memory/scopes/<scope>/projects/<id>.md — the file never moves (WORK-1: archive flips state;
// only bulky working artifacts relocate). `close` additionally emits the graduation residue
// summary into the scope's STAGING (the reconciler's one inlet, MEM-8/14) with a
// `graduation_of: <id>` frontmatter key — how the reconciler knows to stamp minted nodes with
// `source: closure:<id>` provenance. Graduation depth is the reconciler's judgment; `graduate`
// here only records that judgment in the object (zero minted nodes is a legitimate outcome and
// must be recorded, never silent). This verb never deletes, never touches knowledge/, never
// runs git — commits stay with the builder lane (single-lane writer, WORK-1).
//
// `declare`/`revive` mint the object; retro-declaration (WORK-1 amendment: born-closed) is just
// `declare` with a historical `--started` immediately followed by `close --closed <historical-date>`
// — no separate verb. Ids are root-unique (WORK-1 amendment) — both verbs refuse a collision
// anywhere under scopes/*/projects/, not just the target scope. Accepted gap: declare-then-close
// is two commands, not one transaction — a crash between them leaves a historically-finished
// Project sitting at `active`; self-correcting (just re-run `close`), so no combined verb is built.

import { readFile, writeFile, access, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump as yamlDump } from 'js-yaml';
import { MEMORY_ROOT, parseNode } from './nodes.mjs';

const OUTCOMES = ['shipped', 'abandoned', 'superseded', 'absorbed', 'retired'];
const KINDS = ['finite', 'practice'];
// Null-prototype: `verb` is argv, and `!TRANSITIONS[verb]` (line 201) is the unknown-verb guard. On a
// plain `{}` a verb of `toString`/`valueOf`/`constructor` reads a truthy inherited function, passes
// the guard, and then crashes at the `const [from, to] = TRANSITIONS[verb]` destructure instead of
// printing usage.
const TRANSITIONS = Object.assign(Object.create(null),
  { close: ['active', 'closed'], graduate: ['closed', 'graduated'], archive: ['graduated', 'archived'] });
const CREATE_VERBS = ['declare', 'revive'];
const CLOSED_OR_LATER = ['closed', 'graduated', 'archived'];
// Project ids are a strict kebab-slug (DESIGN.md §6a.6), stricter than the general scope/id SLUG below —
// this is the format newly-minted ids and relation references (relates/depends_on/supersedes) must match.
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Frontmatter order (diff-stable, like nodes.mjs FIELD_ORDER) — realizes DESIGN.md §6a.6 (WORK-1 B1).
const PROJECT_FIELDS = [
  'id', 'scope', 'state', 'outcome', 'kind', 'tags', 'supersedes', 'relates', 'depends_on',
  'declared', 'started', 'closed', 'graduated', 'archived', 'last_understanding_change', 'schema_version',
];

const nowISO = () => new Date().toISOString();
const today = () => nowISO().slice(0, 10);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const parseList = (v) => v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

// Enumerates every Project object across all scopes' projects/ trees, parsed — the one place that
// walks the pool. Shared by findProjectPath (id lookup) and the Board (decisions.mjs/board.mjs,
// WORK-1 decision-log + Board brick) so neither reimplements the directory walk.
export async function listAllProjects() {
  const scopesDir = resolve(MEMORY_ROOT, 'scopes');
  let scopeEntries;
  try { scopeEntries = await readdir(scopesDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of scopeEntries) {
    if (!entry.isDirectory()) continue;
    const projectsDir = resolve(scopesDir, entry.name, 'projects');
    let files;
    try { files = await readdir(projectsDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md') || f.endsWith('.roadmap.md')) continue;   // roadmap sidecars live alongside Project objects, not projects themselves
      const p = resolve(projectsDir, f);
      const { frontmatter, body } = parseNode(await readFile(p, 'utf8'), f.slice(0, -3));
      out.push({ scope: entry.name, path: p, frontmatter, body });
    }
  }
  return out;
}

// Ids are root-unique (WORK-1 amendment) — search by actual frontmatter `id:`, not filename, so a
// drifted/manual file (filename != its own id field) can't hide a collision.
export async function findProjectPath(id) {
  const hit = (await listAllProjects()).find((p) => p.frontmatter.id === id);
  return hit ? hit.path : null;
}

function serializeProject(fm, body) {
  // Null-prototype accumulator: `k in out` below walks the prototype chain, so on a plain `{}` a
  // frontmatter field named `toString`/`valueOf`/`constructor` reads as already present and is
  // dropped from the persisted project. yamlDump serializes a null-prototype object unchanged.
  const out = Object.create(null);
  for (const k of PROJECT_FIELDS) if (fm[k] !== undefined && fm[k] !== null) out[k] = fm[k];
  for (const k of Object.keys(fm)) if (!(k in out) && fm[k] != null) out[k] = fm[k];
  const dumped = yamlDump(out, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd();
  return `---\n${dumped}\n---\n\n${(body || '').trim()}\n`;
}

function residueStaging(scope, id, projectPath, residue) {
  const ts = nowISO();
  return `---
type: staging
scope: ${scope}
brain: claude
session_anchor: closure:${id}
transcript: ${projectPath}
graduation_of: ${id}
started: ${ts}
schema_version: 1
---

# closure residue · ${id}

_Graduation residue summary (WORK-1): emitted by the closure verb at close(outcome). The
reconciler judges depth — full nodes, a stub, or zero minted nodes are all judged outcomes
(MEM-14); the judgment is recorded back in the project object by \`graduate\`._

#### assistant · ${ts} [decision]
${residue.trim()}
`;
}

// Validates each id in a relation list is a well-formed, existing, non-self Project id.
async function checkRelationIds(ids, selfId, label) {
  for (const rid of ids) {
    if (!KEBAB.test(rid)) usage(`${label} id "${rid}" is not a valid kebab-slug`);
    if (rid === selfId) usage(`${label} cannot reference itself ("${rid}")`);
    if (!(await findProjectPath(rid))) usage(`${label} id "${rid}" does not match any existing project`);
  }
}

async function runCreate(verb, scope, id, projectPath, flag, dryRun) {
  if (!KEBAB.test(id)) usage(`"${id}" is not a valid kebab-slug (letters/digits, single hyphens, no leading/trailing/double hyphens)`);
  if (await exists(projectPath)) usage(`project already exists at ${projectPath}`);
  const dup = await findProjectPath(id);
  if (dup) usage(`id "${id}" already used at ${dup} — ids are unique across the whole memory root (WORK-1 amendment)`);

  const kind = flag('kind');
  if (!KINDS.includes(kind)) usage(`--kind must be one of ${KINDS.join('|')}`);
  const bodyFile = flag('body');
  if (!bodyFile) usage('--body <file> is required — declare/revive need real prose (purpose/end-state at minimum), not a bare skeleton');
  const body = await readFile(resolve(bodyFile), 'utf8');
  if (!body.trim()) usage(`body file ${bodyFile} is empty`);

  const declaredDate = flag('declared') || today();
  const startedDate = flag('started') || declaredDate;
  const fm = { id, scope, state: 'active', kind };

  if (verb === 'revive') {
    const supersedes = flag('supersedes');
    if (!supersedes) usage('--supersedes <old-id> is required for revive');
    const oldPath = await findProjectPath(supersedes);
    if (!oldPath) usage(`no project found with id "${supersedes}" to supersede`);
    const { frontmatter: oldFm } = parseNode(await readFile(oldPath, 'utf8'), supersedes);
    if (oldFm.id !== supersedes) usage(`id mismatch: ${oldPath} has id "${oldFm.id}", expected "${supersedes}"`);
    if (!CLOSED_OR_LATER.includes(oldFm.state)) usage(`cannot revive "${supersedes}": state is "${oldFm.state}" (needs closed/graduated/archived — no reopening an active project)`);
    fm.supersedes = supersedes;
  }

  const tags = parseList(flag('tags'));
  const relates = parseList(flag('relates'));
  const dependsOn = parseList(flag('depends-on'));
  if (relates) await checkRelationIds(relates, id, '--relates');
  if (dependsOn) await checkRelationIds(dependsOn, id, '--depends-on');
  if (tags) fm.tags = tags;
  if (relates) fm.relates = relates;
  if (dependsOn) fm.depends_on = dependsOn;
  fm.declared = declaredDate;
  fm.started = startedDate;
  fm.last_understanding_change = startedDate;
  fm.schema_version = 1;

  const serialized = serializeProject(fm, body);
  if (dryRun) {
    console.log(`(--dry-run: nothing written)\n\n=== would write ${projectPath} ===\n${serialized}`);
    return;
  }
  await mkdir(resolve(MEMORY_ROOT, 'scopes', scope, 'projects'), { recursive: true });
  const tmpPath = `${projectPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, serialized, 'utf8');
  await rename(tmpPath, projectPath);   // atomic on the same filesystem — no half-written object on a crash
  console.log(`closure: ${verb} ${id} → active${fm.supersedes ? ` (supersedes ${fm.supersedes})` : ''}`);
}

function usage(msg) {
  if (msg) console.error(`closure: ${msg}`);
  console.error('usage: closure.mjs declare <scope> <id> --kind <finite|practice> --body <file>\n' +
    '                 [--started YYYY-MM-DD] [--declared YYYY-MM-DD] [--tags a,b] [--relates id,id]\n' +
    '                 [--depends-on id,id] [--dry-run]\n' +
    '       closure.mjs revive <scope> <new-id> --supersedes <old-id> --kind <finite|practice> --body <file>\n' +
    '                 [--started YYYY-MM-DD] [--tags a,b] [--relates id,id] [--depends-on id,id] [--dry-run]\n' +
    '       closure.mjs close <scope> <id> --outcome <o> --residue <file> [--closed YYYY-MM-DD] [--dry-run]\n' +
    '       closure.mjs graduate <scope> <id> --note "<judged depth>" [--dry-run]\n' +
    '       closure.mjs archive <scope> <id> [--dry-run]');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const [verb, scope, id] = args;
  const isCreate = CREATE_VERBS.includes(verb);
  if (!isCreate && !TRANSITIONS[verb]) usage(`unknown verb "${verb || ''}"`);
  // scope/id must be plain slugs — they become path segments under MEMORY_ROOT/scopes (no traversal).
  const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
  if (!scope || !id || !SLUG.test(scope) || !SLUG.test(id) || scope.includes('..') || id.includes('..'))
    usage('need <scope> <id> as plain slugs (letters/digits/-/_/.; no path separators)');
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    const v = i !== -1 ? args[i + 1] : null;
    return v != null && !v.startsWith('--') ? v : null;   // a following flag is not a value
  };
  const dryRun = args.includes('--dry-run');
  const projectPath = resolve(MEMORY_ROOT, 'scopes', scope, 'projects', `${id}.md`);

  if (isCreate) return runCreate(verb, scope, id, projectPath, flag, dryRun);

  if (!(await exists(projectPath))) usage(`no project object at ${projectPath} — declare first`);
  const { frontmatter: fm, body } = parseNode(await readFile(projectPath, 'utf8'), id);

  const [from, to] = TRANSITIONS[verb];
  if (fm.state !== from) usage(`cannot ${verb}: state is "${fm.state}", needs "${from}" (lifecycle is monotonic — no reopening; use revive)`);

  let newBody = body;
  let stagingPath = null, stagingText = null;

  if (verb === 'close') {
    const outcome = flag('outcome');
    if (!OUTCOMES.includes(outcome)) usage(`--outcome must be one of ${OUTCOMES.join('|')}`);
    const residueFile = flag('residue');
    if (!residueFile) usage('--residue <file> is required — closing ALWAYS emits a residue summary (WORK-1: graduation is never skipped)');
    const residue = await readFile(resolve(residueFile), 'utf8');
    if (!residue.trim()) usage(`residue file ${residueFile} is empty — at minimum: outcome + one-line belief-delta`);
    const closedDate = flag('closed') || today();
    stagingPath = resolve(MEMORY_ROOT, 'scopes', scope, 'staging', `${today()}__closure-${id}.md`);
    if (await exists(stagingPath)) usage(`staging file already exists: ${stagingPath} — refusing to overwrite`);
    stagingText = residueStaging(scope, id, projectPath, residue);
    fm.state = 'closed'; fm.outcome = outcome; fm.closed = closedDate;
    fm.last_understanding_change = closedDate;  // closing is the terminal understanding-change
  } else if (verb === 'graduate') {
    const note = flag('note');
    if (!note) usage('--note "<judged depth>" is required — the reconciler\'s depth judgment must be recorded (zero-mint included), never silent');
    fm.state = 'graduated'; fm.graduated = today();
    newBody = `${body.trim()}\n\n## Graduation\n\n- judged: ${today()} — ${note.trim()}\n`;
  } else { // archive
    fm.state = 'archived'; fm.archived = today();
  }

  const serialized = serializeProject(fm, newBody);
  if (dryRun) {
    console.log(`(--dry-run: nothing written)\n\n=== would write ${projectPath} ===\n${serialized}`);
    if (stagingPath) console.log(`=== would write ${stagingPath} ===\n${stagingText}`);
    return;
  }
  if (stagingPath) {  // residue first: a crash after this loses nothing
    await mkdir(resolve(MEMORY_ROOT, 'scopes', scope, 'staging'), { recursive: true });
    await writeFile(stagingPath, stagingText, 'utf8');
  }
  await writeFile(projectPath, serialized, 'utf8');
  console.log(`closure: ${id} → ${to}${verb === 'close' ? ` (${fm.outcome}); residue → ${stagingPath}` : ''}`);
}

// Run ONLY when invoked directly — importing this module must never trigger writes.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error('closure failed:', e.message); process.exit(1); });
