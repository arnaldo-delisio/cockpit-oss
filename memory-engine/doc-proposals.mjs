#!/usr/bin/env node
// doc-proposals.mjs — the draft-only doc/graph-change store (ATT-2; was kept separate by design
// from the skills/config-only harness-proposals store, since removed per ATT-3 — doc edits, typed
// links, node promotions, and project-thread suggestions are NOT harness changes).
//
//   node doc-proposals.mjs list    [--status new|applied|dismissed]
//   node doc-proposals.mjs show    <id>
//   node doc-proposals.mjs apply   <id> [--dry-run]
//   node doc-proposals.mjs dismiss <id> [--dry-run]
//
// Two-state lifecycle (`new -> applied|dismissed`) with a draft-only boundary:
// `apply` marks a draft resolved and prints it for the human/builder lane to place by hand — this
// file NEVER writes a doc, a Project object, a knowledge node, or a link. That is what keeps the
// inbox's `promote` verb suggestion-only (WORK-1: only human + in-session builder write Projects).

import { readFile, writeFile, readdir, mkdir, rename, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump as yamlDump } from 'js-yaml';
import { MEMORY_ROOT, parseNode, slugify } from './nodes.mjs';

const DOC_PROPOSALS_DIR = resolve(MEMORY_ROOT, 'doc-proposals');
const STATUSES = ['new', 'applied', 'dismissed'];
// on_accept/project/expected_node_hash/expected_status: MEM-38 step 6 (ATT-3 execution contract).
// serialize() below is strict and silently drops unlisted keys, so listing them here is what lets
// the store CARRY them at all. No producer mints them yet (step 7); accept.mjs honors them.
const FIELDS = ['id', 'claim', 'evidence', 'source', 'target', 'scope', 'status', 'detected', 'resolved', 'insight_id', 'on_accept', 'project', 'expected_node_hash', 'expected_status', 'expected_target_hash'];

const nowISO = () => new Date().toISOString();
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

function serialize(fm, body) {
  const out = {};
  for (const k of FIELDS) if (fm[k] !== undefined && fm[k] !== null) out[k] = fm[k];
  const dumped = yamlDump(out, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd();
  return `---\n${dumped}\n---\n\n${(body || '').trim()}\n`;
}

// exported for accept.mjs (MEM-38 step 7): the doc-edit kind flips a proposal to applied through
// the store's own serializer/writer, never a duplicate copy.
export async function writeProposal(path, fm, body, dryRun) {
  const serialized = serialize(fm, body);
  if (dryRun) { console.log(`(--dry-run: nothing written)\n\n=== would write ${path} ===\n${serialized}`); return; }
  await mkdir(DOC_PROPOSALS_DIR, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, serialized, 'utf8');
  await rename(tmp, path);
}

export async function loadDocProposals() {
  let files = [];
  try { files = (await readdir(DOC_PROPOSALS_DIR)).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const id = f.slice(0, -3);
    const path = resolve(DOC_PROPOSALS_DIR, f);
    const { frontmatter, body } = parseNode(await readFile(path, 'utf8'), id);
    out.push({ id, path, frontmatter, body });
  }
  return out;
}

// Writer for programmatic callers (inbox promote today; B4/B5 semantic detectors later). Mints a
// draft FILE and nothing else. The draft body is the suggested edit as fenced markdown.
export async function mintDocProposal({ claim, evidence, source, target, scope, draft, dryRun, insight_id }) {
  const day = nowISO().slice(0, 10);
  let id = `${day}-${slugify(claim).slice(0, 60)}`;
  let i = 2;
  while (await exists(resolve(DOC_PROPOSALS_DIR, `${id}.md`))) id = `${day}-${slugify(claim).slice(0, 60)}-${i++}`;
  const fm = { id, claim, evidence, source, target, scope, status: 'new', detected: nowISO(), insight_id };
  const body = `\`\`\`markdown\n${(draft || '').trim()}\n\`\`\`\n`;
  await writeProposal(resolve(DOC_PROPOSALS_DIR, `${id}.md`), fm, body, dryRun);
  return id;
}

function findById(pool, id) { return pool.find((n) => n.id === id) || null; }

async function setStatus(id, status, dryRun) {
  const proposal = findById(await loadDocProposals(), id);
  if (!proposal) usage(`no doc proposal found with id "${id}"`);
  if (proposal.frontmatter.status !== 'new') usage(`cannot ${status === 'applied' ? 'apply' : 'dismiss'} "${id}": status is "${proposal.frontmatter.status}"`);
  await writeProposal(proposal.path, { ...proposal.frontmatter, status, resolved: nowISO() }, proposal.body, dryRun);
  console.log(`doc-proposals: ${status} ${id}`);
  if (status === 'applied') {
    console.log('  draft (not auto-applied — doc-proposals.mjs never writes docs, Projects, nodes, or links):');
    console.log(proposal.body.trim());
  }
}

function usage(msg) {
  if (msg) console.error(`doc-proposals: ${msg}`);
  console.error('usage: doc-proposals.mjs list [--status new|applied|dismissed]\n'
    + '       doc-proposals.mjs show <id>\n'
    + '       doc-proposals.mjs apply <id> [--dry-run]\n'
    + '       doc-proposals.mjs dismiss <id> [--dry-run]');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dryRun = args.includes('--dry-run');
  if (cmd === 'list') {
    const i = args.indexOf('--status');
    const status = i !== -1 ? args[i + 1] : null;
    if (status && !STATUSES.includes(status)) usage(`--status must be one of ${STATUSES.join('|')}`);
    const pool = (await loadDocProposals()).filter((n) => !status || n.frontmatter.status === status);
    if (!pool.length) { console.log('(no doc proposals)'); return; }
    pool.sort((a, b) => (b.frontmatter.detected || '').localeCompare(a.frontmatter.detected || ''));
    for (const n of pool) console.log(`${n.id}  [${n.frontmatter.status}] target=${n.frontmatter.target || '—'}\n  ${n.frontmatter.claim}`);
  } else if (cmd === 'show' && args[1]) {
    const p = findById(await loadDocProposals(), args[1]);
    if (!p) usage(`no doc proposal found with id "${args[1]}"`);
    console.log(p.body.trim());
  } else if (cmd === 'apply' && args[1]) {
    await setStatus(args[1], 'applied', dryRun);
  } else if (cmd === 'dismiss' && args[1]) {
    await setStatus(args[1], 'dismissed', dryRun);
  } else {
    usage(args.length ? `unknown command "${cmd || ''}"` : null);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error('doc-proposals failed:', e.message); process.exit(1); });
