#!/usr/bin/env node
// projection.mjs — CLAUDE.md projection (DESIGN §5 / §6a.4; MEM-20). Phase 4.
//
// The reconciler's SECOND output: after canonical nodes are durable, promote the few
// high-centrality BEHAVIORAL nodes (type ∈ {identity, feedback}) into the always-loaded
// layer — the fenced "managed region" of the scope-routed CLAUDE.md. Facts/`knowledge`
// stay retrieval-gated and never project (DESIGN §6a.4).
//
// Locked invariants this file must never break:
//   • behavioral-only      — only type ∈ {identity, feedback} project; knowledge never does.
//   • fence discipline      — read/replace ONLY the bytes between :begin and :end; the
//                             hand-authored skeleton (BUILD-2) outside the fence is untouched.
//   • scope routing         — a node projects ONLY into its own scope's CLAUDE.md
//                             (global→~/CLAUDE.md; cockpit→<repo>/CLAUDE.md; <x>→<repo>/scopes/<x>).
//   • cap (BUILD-4/MEM-38)  — ≤ cap rules (per-scope dial, default 12, human-raised only); a
//                             graduation at a full block is BLOCKED and carded, never silently sliced.
//   • the node is the home  — the block is a generated cache; each rule carries [[source-node]].
//
// The adversarial gate (decisions/claude-md-projection.md) is one batched judge('hard') call per
// scope, handed the candidates AND the already-always-loaded skeleton text, told to keep only
// durable always-load rules NOT already covered by the skeleton (drops duplicates + transient
// build-scaffolding). Under-promotion (even to zero rules) is a correct outcome, not a bug.
//
// THREE-LAYER MODEL (MEM-20 determinism amendment, 2026-06-23). The gate is an LLM call → its
// membership flips on borderline nodes. We contain that flip instead of letting `inputs=` freeze a
// coin-flip. A scope's CLAUDE.md now carries three layers:
//   • HAND SKELETON  — outside the fence; human-authored; the reconciler NEVER writes it.
//   • DURABLE rules  — inside the fence; rules the gate has kept GRADUATE_AFTER reconciles in a row
//                      auto-graduate here and are HELD by a counter + node-state (not re-judged each
//                      run), so they stop flickering. Auto-demoted when their source node is
//                      superseded or drops below the centrality floor. State is the home; git is undo.
//   • EMERGING rules — inside the fence; the gate's volatile pick, made STICKY: last run's set is fed
//                      back so the gate keeps it unless there's a clear reason to change (hysteresis,
//                      not a fresh coin-flip). Survives N runs → graduates to DURABLE.
// "AI judgment" drives promotion (the gate's repeated keeping); a counter decides *when* it has earned
// the durable box — no second LLM boundary, no human gate. Quorum/best-of-N is the reserved escalation
// if a future multi-scope load makes the emerging boundary flip again (DECISIONS MEM-20).
//
// Projection state (streaks · graduated set · last emerging set · gate signature, per scope) lives in
// `memory/.reconciler/projection-state.json` (committed, sibling of the reconciler's state.json). The
// CLAUDE.md file is a pure render of that state, so its diff only moves when membership actually moves.
//
// Damping: the gate signature (gate candidates + skeleton + last emerging set) is stored per scope. If
// it is unchanged we REUSE last run's emerging set instead of re-calling the gate — but streak
// bookkeeping still advances (stickiness guarantees the gate would re-select it), so stable scopes keep
// graduating cheaply. The gate runs only when its inputs actually change.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, basename, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { dump as yamlDump } from 'js-yaml';
import { judge } from './judge.mjs';
import { commitAt } from './scoped-commit.mjs';   // shared commit path, incl. the no-identity fallback
import { composeFields } from './compose-insights.mjs';
import { contentHash, embed, dot } from './retrieval.mjs';
import { writeNode, NODES_DIR, poolOf } from './nodes.mjs';
import { loadInsights } from './mechanical-insights.mjs';
import { MEMORY_ROOT, IS_ISOLATED_ROOT, generateSoul } from './bootstrap.mjs';
import { REPO_ROOT, isScopeSlug, registeredScopes } from './paths.mjs';

const execFileP = promisify(execFile);

// --- tunables (grey-area picks; tune after real runs) ---
const CENTRALITY_FLOOR = 0.6;   // below this, a behavioral node is not "high-centrality" enough to always-load
const DEFAULT_CAP = 12;         // ≤ BUILD-4's 10–15 cap on the always-load ## Rules block (durable + emerging).
                                // MEM-38 step 5 decision 4: the live cap is a per-scope dial persisted in
                                // projection-state.json (`sc.cap`, human-set only, never raised automatically);
                                // this constant is only the default for scopes that never negotiated one.
const PROSE_CHARS = 500;        // per-candidate truncation handed to the gate
const GRADUATE_AFTER = 3;       // consecutive reconciles a rule must survive the gate before it auto-graduates
                                // to DURABLE (at on-demand cadence ≈ 3 runs; revisit when the nightly timer lands)
const SUPPRESS_COS = 0.6;       // AR-3 direction 3: embedding suppression threshold. Picked empirically
                                // (2026-07-18, MiniLM on the audit's known duplicate clusters): near-verbatim
                                // restatements score ≥ 0.75, non-duplicate rule pairs ≤ 0.40; semantic
                                // paraphrases (the adversarial-review cluster) score 0.30-0.56 and are NOT
                                // separable by embedding — those are caught by the LLM gate seeing the full
                                // load-stack, not by this backstop.
const CHUNK_MIN_WORDS = 5;      // stack lines shorter than this are headers/noise, not doctrine to dedup against

const HOME = homedir();
const COCKPIT_ROOT = REPO_ROOT;
const GLOBAL_SKELETON = resolve(COCKPIT_ROOT, 'shells', 'CLAUDE.md'); // canonical global builder shell (~/CLAUDE.md just imports it)
const GLOBAL_SOUL = resolve(COCKPIT_ROOT, 'shells', 'SOUL.md');       // canonical global operator shell (~/.hermes/SOUL.md symlinks it)
const PROJ_STATE_FILE = resolve(MEMORY_ROOT, '.reconciler', 'projection-state.json'); // committed (sibling of state.json)

const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
// MEM-38: pool identity comes from the one chokepoint (nodes.mjs poolOf, fail-closed to library);
// liveness is a separate question and stays composed here, never folded into poolOf.
const isBehavioral = (n) => poolOf(n) === 'behavioral' && !n.frontmatter?.superseded;

// ---------- OPEN-18: durable-rule staleness/contradiction check ----------
// Surface (c) — sticky cache: a durable rule's cached wording is held (not re-judged) once
// graduated (see GRADUATION below), so if its source node's body is later edited in place
// (this repo's supersession convention — confirmed 2026-07-17, the node stays the same id, only
// its prose/updated timestamp change), the cache silently keeps quoting the old wording. Detected
// here as a plain contentHash diff against the hash recorded at graduation time — no LLM, no cost.
// Surface (a) — node vs. a newer decision: gated behind (c) actually firing (a hash-diff is real
// evidence something moved; running a judge() call on every durable rule every reconcile, most of
// which never change, would be pure waste for no signal). When the source node did change, ask
// judge() whether the durable rule's CACHED wording now contradicts/is narrower-than the node's
// CURRENT body or the scope's DECISIONS.md — flag only (OPEN-10 precedent: draft/finding, never
// auto-rewrites the fence). Findings land in the same insights/ store mechanical-insights.mjs and
// semantic-insights.mjs already own (detector: 'durable-rule-drift').
const INSIGHTS_DIR = resolve(MEMORY_ROOT, 'insights');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const today = () => new Date().toISOString().slice(0, 10);

async function nextInsightId(slug) {
  let id = `${today()}-${slug}`;
  let i = 2;
  while (await exists(resolve(INSIGHTS_DIR, `${id}.md`))) id = `${today()}-${slug}-${i++}`;
  return id;
}

function serializeInsight(fm, body) {
  const dumped = yamlDump(fm, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd();
  return `---\n${dumped}\n---\n\n${(body || '').trim()}\n`;
}

// step 7 preconditions: accept.mjs recomputes expected_node_hash as sha256 of the node FILE
// bytes and expected_status via its superseded > ratified > claim derivation; the mint must
// match both or the card refuses on first accept. Hash comes off the live file, status off the
// frontmatter this run already parsed (same file, same run).
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
async function nodePreconditions(id, frontmatter) {
  const bytes = await readFile(resolve(NODES_DIR, `${id}.md`));
  const status = frontmatter.superseded ? 'superseded'
    : frontmatter.ratified ? 'ratified'
      : frontmatter.claim ?? 'unknown';
  return { expected_node_hash: sha256(bytes), expected_status: status };
}

async function writeInsightFile(fm, body) {
  await mkdir(INSIGHTS_DIR, { recursive: true });
  const path = resolve(INSIGHTS_DIR, `${fm.id}.md`);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, serializeInsight(fm, body), 'utf8');
  await rename(tmp, path);
}

// best-effort: cockpit scope reads the public ledger; a data scope reads its own if it has one;
// no DECISIONS.md is not an error, the contradiction half of the check just degrades to "flag the
// drift, skip the ledger comparison" rather than failing the reconcile.
async function decisionsForScope(scope) {
  const path = scope === 'cockpit' || scope === 'global'
    ? resolve(COCKPIT_ROOT, 'DECISIONS.md')
    : resolve(MEMORY_ROOT, 'scopes', scope, 'DECISIONS.md');
  return readFile(path, 'utf8').catch(() => '');
}

function driftPrompt(rule, cachedWording, currentProse, decisions) {
  return `A durable always-loaded operating rule was cached with the wording below. Either its source memory \
node's body was edited in place (this repo supersedes nodes in place rather than minting new ones), or the \
scope's decision ledger changed since this rule was last checked — possibly both, possibly the ledger alone \
with the node body unchanged.

The cached rule is DELIBERATELY a short, compressed one-liner (≤ ~20 words) — it is NORMAL and CORRECT for it \
to omit detail, qualifiers, dates, or phrasing present in the fuller node body. Being "narrower" or a looser \
paraphrase is NOT staleness; do not flag on that basis alone.

Flag ONLY a genuine substantive break: the cached wording asserts something the CURRENT node body or a \
DECISIONS.md entry now explicitly contradicts, reverses, or narrows the scope/conditions of (the OPEN-18 \
incident this guards against: a node said "approval required every time," a later decision narrowed that to \
"only for production-deploy repos," and the cached rule kept the old blanket requirement). If the cached rule \
and the current source still agree in substance, even if worded differently, that is NOT stale.

CACHED RULE (what is currently always-loaded):
"""
${cachedWording}
"""

SOURCE NODE — CURRENT body:
"""
${truncate(currentProse, PROSE_CHARS)}
"""

SCOPE DECISIONS.md (may be empty if none is reachable):
"""
${truncate(decisions, 2000) || '(none reachable)'}
"""

Reply ONLY JSON: { "stale": <bool>, "summary": "<one sentence: what changed and why the cached wording is now wrong, or empty if not stale>" }`;
}

// runs for every durable rule in a scope where EITHER the source node's content hash no longer
// matches the hash recorded at graduation time, OR the scope's DECISIONS.md changed since the last
// check (Codex review, 2026-07-17: gating solely on the node-hash diff misses a ledger entry that
// narrows/reverses a rule whose own node body never moved — the more common shape of surface (a)).
// Writes a flag-only insight; never touches the fence/cache itself.
async function checkDurableDrift({ scope, rule, node, cachedHash, currentHash, decisionsText, nodeMoved, ledgerMoved, insightsPool }) {
  // open-finding skip (mechanical-insights.mjs:316-318, truth-pass.mjs:490 precedent): a card already
  // open on this exact rule means a human hasn't reviewed yet, so re-judging before the judge() call
  // is pure waste. Match BOTH the pattern (rule.source) AND the family (source/detector), because
  // ratified-rule-retirement and proposed-rule also stash a node id in `pattern` and a cross-family
  // collision on that id must never suppress a drift mint.
  const openPrior = insightsPool.some((n) => n.frontmatter.status === 'new'
    && n.frontmatter.pattern === rule.source
    && (n.frontmatter.source === 'projection:durable-rule-drift' || n.frontmatter.detector === 'durable-rule-drift'));
  if (openPrior) return null;
  let verdict;
  try {
    verdict = await judge(driftPrompt(rule.rule, rule.rule, node.prose, decisionsText), { tier: 'hard', json: true });
  } catch { verdict = { stale: true, summary: '(judge call failed — source node or scope ledger changed since this rule graduated; flagging on the diff alone)' }; }
  if (!verdict || !verdict.stale) return null;
  const id = await nextInsightId(`durable-rule-drift-${rule.source}`);
  const fm = {
    id, claim: `Durable rule [[${rule.source}]] may be stale: ${verdict.summary || 'source node body changed since this rule was cached.'}`,
    evidence: [`cached: ${rule.rule}`,
      // name the gate(s) that actually fired — a ledger-only trigger leaves the node hash unchanged,
      // and claiming a hash move there would misdirect the review.
      nodeMoved && ledgerMoved ? `both gates fired: source node body changed (sourceHash was ${cachedHash}, now ${currentHash}) AND the scope's DECISIONS.md ledger changed`
        : nodeMoved ? `node-hash gate fired: sourceHash was ${cachedHash}, now ${currentHash}`
          : cachedHash ? `ledger-hash gate fired: the scope's DECISIONS.md changed since the last check (node body unchanged, sourceHash ${currentHash})`
            : `ledger-hash gate fired: the scope's DECISIONS.md changed since the last check (no prior node hash recorded; current sourceHash ${currentHash})`],
    suggested_fix: 'Review the source node and the cached rule; if the node was superseded, resupersede/update the cache and reproject.',
    // step 7 ruling: drift is always a REVIEW task, never an op (the fix is conditional on what
    // actually drifted). The line lands verbatim on a roadmap row, so it must stay single-line.
    on_accept: {
      kind: 'task', project: '',
      line: `Review durable rule [[${rule.source}]]: ${truncate((verdict.summary || 'source moved since the rule was cached').replace(/\s+/g, ' ').trim(), 160)}`,
    },
    source: 'projection:durable-rule-drift', pattern: rule.source, scope, status: 'new', detected: new Date().toISOString(), detector: 'durable-rule-drift',
  };
  await writeInsightFile(fm, `Relates: OPEN-18 (DECISIONS.md).`);
  return id;
}

// projection-state key for a route: builder keeps the BARE scope key (back-compat — existing
// projection-state.json survives B4); operator routes get a `<scope>::operator` suffix.
const routeKey = (scope, audience) => (audience === 'operator' ? `${scope}::operator` : scope);
const parseRouteKey = (key) => (key.endsWith('::operator') ? [key.slice(0, -'::operator'.length), 'operator'] : [key, 'builder']);

// (scope × audience) → CANONICAL projection target (B4 audience axis). The reconciler writes ONLY its
// own two repos; project/client load-points (scopes/<x>/CLAUDE.md) are thin hand-written loaders
// that @-import these canonicals, so foreign repos stay pristine. System scopes project public (cockpit
// repo); data scopes project private (memory repo, riding the same commit as the nodes they derive from).
//   builder/global   → shells/CLAUDE.md      — public cockpit repo; ~/CLAUDE.md (loader) @-imports it.
//   builder/cockpit  → <repo>/CLAUDE.md  — public cockpit repo; load-point already in-repo, no loader.
//   builder/<x>      → memory/scopes/<x>/CLAUDE.md — PRIVATE memory repo; scopes/<x>/CLAUDE.md loader imports it.
//   operator/global  → shells/SOUL.md        — public cockpit repo; ~/.hermes/SOUL.md symlinks it.
//   operator/<x>     → null (NO route) — audience routing is scope-naive (GA2); non-global operator nodes
//                      don't project until a scope-aware route exists, and must NOT fall back to the
//                      builder shell (that would leak operator rules into the always-loaded builder root).
function targetFor(scope, audience) {
  if (audience === 'operator') return scope === 'global' ? GLOBAL_SOUL : null;
  if (scope === 'global') return GLOBAL_SKELETON;                 // shells/CLAUDE.md (the canonical root shell)
  if (scope === 'cockpit') return resolve(COCKPIT_ROOT, 'CLAUDE.md');
  return resolve(MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');      // private memory repo (data scopes)
}

// The SYSTEM scopes: the only ones whose target can land inside the cockpit repo. Every other scope
// is a data scope and routes into memory/ by the last line of targetFor().
const SYSTEM_SCOPES = ['global', 'cockpit'];
const AUDIENCES = ['builder', 'operator'];

// Repo-relative paths of every projection target that lives inside the cockpit repo itself.
// Consumed by publish/publish.sh, which must reset the managed region in exactly these files before
// the export commit. Derived from targetFor() rather than listed by name, so adding a system route
// cannot leave the export walking by basename and rewriting a documentation file that happens to be
// called CLAUDE.md. Data-scope targets are absent by construction: they live in memory/, which never
// ships (pinned by a test).
export function repoProjectionPaths() {
  const out = new Set();
  for (const audience of AUDIENCES) {
    for (const scope of SYSTEM_SCOPES) {
      const t = targetFor(scope, audience);
      if (t && t.startsWith(COCKPIT_ROOT + sep)) out.add(relative(COCKPIT_ROOT, t));
    }
  }
  return [...out].sort();
}

// ---------- load-stack map (AR-3 direction 3) ----------
// For each (scope × audience) route: the OTHER always-loaded files that stack with the target in a
// live session, i.e. inherited context the projected rules must never restate. FULL text (hand
// skeleton + managed fence): an ancestor's projected durable rules are just as always-loaded as its
// hand doctrine, so both count as coverage. Builder sessions stack shells/CLAUDE.md under every
// scope; operator (Hermes) sessions load SOUL.md alone and never see the builder shell, so the two
// audiences have disjoint stacks and must not suppress across each other.
function stackFilesFor(scope, audience) {
  if (audience === 'operator') return [];                 // SOUL.md is its own root
  if (scope === 'global') return [];                      // shells/CLAUDE.md is the root
  return [GLOBAL_SKELETON];                               // every non-global builder scope inherits the shell
}

// ---------- @-import expansion (port regression fix) ----------
// A load-point may hold its doctrine inline OR point at it with Claude Code's `@path` import
// directive; both are equally always-loaded, so both must count as coverage. The port split the
// builder shell into a 19-line loader (`shells/CLAUDE.md`, whose first directive is `@doctrine.md`)
// plus `shells/doctrine.md`, which silently shrank this corpus by ~90% and disarmed both dedup
// consumers (the SUPPRESS_COS backstop and the LLM gate's STANDING POLICY). Semantics kept to
// exactly what the shells use: a whole-line `@path` directive, resolved relative to the importing
// file's directory (`~` expanded), the imported text substituted in place. Fail-open by
// construction: a missing/unreadable/cyclic/non-regular/oversized import contributes no text and
// never throws, and a non-string `text` at the seam is coerced to '' (projection runs
// unattended in the nightly; a shell edit must not crash it, and must not hang it either). Two
// guards make that literally true rather than aspirational (Codex review 2026-07-25): the target
// must be a regular file (a FIFO with no writer would hang the read forever, and a hang in an
// unattended nightly is worse than a crash because nothing reports it) and under IMPORT_MAX_BYTES
// (a huge file would exhaust memory before the .catch() could fail open).
// The depth limit is the one case that is not literally text-free: at `depth >= IMPORT_MAX_DEPTH`
// expansion just stops and the text is returned as-is, so the unexpanded `@path` directive line
// survives into the coverage text. Harmless, and deliberately not stripped: a bare `@path` line is
// one word, and stackChunks() drops any line under CHUNK_MIN_WORDS (5), so it can never become a
// coverage chunk for either dedup consumer. It can still reach the LLM gate's prompt, which is
// handed the raw stack text, but a lone file path restates no doctrine and so covers nothing.
const IMPORT_RE = /^[ \t]*@(\S+)[ \t]*$/;
const IMPORT_MAX_DEPTH = 5;
// generous by ~30x: real doctrine files are 1 to 10 KB, so this can only ever reject a pathology.
const IMPORT_MAX_BYTES = 256 * 1024;

async function expandImports(text, baseDir, seen = new Set(), depth = 0) {
  if (!text || depth >= IMPORT_MAX_DEPTH || !text.includes('@')) return text || '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = IMPORT_RE.exec(lines[i]);
    if (!m) continue;
    const spec = m[1].startsWith('~') ? resolve(HOME, m[1].slice(1).replace(/^\//, '')) : resolve(baseDir, m[1]);
    let key = spec;
    try { key = realpathSync(spec); } catch { /* unresolvable: dedupe on the literal path */ }
    if (seen.has(key)) { lines[i] = ''; continue; }         // cycle: drop the directive, keep going
    let ok = false;
    try { const st = lstatSync(key); ok = st.isFile() && st.size <= IMPORT_MAX_BYTES; } catch { /* unstattable: no text */ }
    const raw = ok ? await readFile(spec, 'utf8').catch(() => '') : '';
    lines[i] = raw ? await expandImports(raw, dirname(spec), new Set([...seen, key]), depth + 1) : '';
  }
  return lines.join('\n');
}

// the one seam every coverage text goes through: `text` as loaded from `file`, with its imports
// resolved. Seeds the cycle guard with `file` itself so a shell that imports something importing it
// back terminates on the first revisit.
export async function coverageText(text, file) {
  let key = file;
  try { key = realpathSync(file); } catch { /* unwritten route: guard on the literal path */ }
  return expandImports(typeof text === 'string' ? text : '', dirname(file), new Set([key]));
}

// rule-sized chunks of always-loaded doctrine: non-empty lines, markdown furniture stripped.
function stackChunks(text) {
  return text.split('\n')
    .map((l) => l.replace(/^[\s>*+-]*(#+\s*)?(\d+\.\s*)?/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l && !l.startsWith('<!--') && l.split(/\s+/).length >= CHUNK_MIN_WORDS);
}

// max cosine of `vec` against pre-embedded chunk vectors; returns { cos, chunk } of the best match.
function bestMatch(vec, chunkVecs, chunks) {
  let cos = -1, chunk = null;
  for (let i = 0; i < chunkVecs.length; i++) {
    const d = dot(vec, chunkVecs[i]);
    if (d > cos) { cos = d; chunk = chunks[i]; }
  }
  return { cos, chunk };
}

// record a suppressed-by trail on the source node (the node is the home; the trail explains why the
// rule is always-loaded nowhere despite qualifying). Append-only, deduped by covering text.
// Committed immediately: a node write left dirty would wedge the next reconcile, which aborts on a
// dirty knowledge/ tree (Codex review 2026-07-18, finding 1).
async function recordSuppression(node, coveredBy, cos, routeKeyStr) {
  const trail = { by: truncate(coveredBy, 160), cosine: Number(cos.toFixed(3)), route: routeKeyStr, date: today() };
  const list = Array.isArray(node.frontmatter.suppressed_by) ? node.frontmatter.suppressed_by : [];
  if (list.some((t) => t.by === trail.by && t.route === trail.route)) return;
  node.frontmatter.suppressed_by = [...list, trail];
  await writeNode(node);
  await commitFile(resolve(NODES_DIR, `${node.id}.md`));
}

// ---------- fence (DESIGN §6a.4) ----------
const FENCE_RE = /[ \t]*<!-- managed:reconciler:begin\b[^>]*-->[\s\S]*?<!-- managed:reconciler:end -->\n?/;

const renderRule = (r) => `- ${r.rule}${r.source ? ` [[${r.source}]]` : ''}${r.ratified ? ' (ratified)' : ''}`;

// render the managed fence from the two computed layers (durable = graduated/held, emerging = volatile).
function renderFence(durable, emerging, gateSig) {
  // The empty state renders `inputs=none`, not the run's gate signature: with no rule in either
  // layer there is nothing for the signature to identify, and pinning the real hash there would
  // rewrite the region on every scope that has nothing to project. `none` is also the exact empty
  // region bootstrap.mjs seeds for a new scope and publish/reset-managed-region.mjs ships in the
  // export, so an empty projection over either is a byte-identical no-op instead of a spurious diff.
  const empty = !durable.length && !emerging.length;
  let body = `<!-- managed:reconciler:begin schema=2 inputs=${empty ? 'none' : gateSig} -->\n`
    + `## Rules (projected from memory: do not edit; edit the source node)\n`;
  if (empty) {
    body += `_(no rules currently meet the always-load bar; see retrieval-gated memory)_\n`;
  } else {
    if (durable.length) {
      // the header must not claim "survived N reconciles" for a rule a human ratified in one turn
      // (MEM-38 step 5): with any ratified member, the lane split is stated and marked per rule.
      body += (durable.some((r) => r.ratified)
        ? `### Durable (held until superseded; "(ratified)" = human-ratified, the rest auto-graduated: survived ${GRADUATE_AFTER}+ reconciles)\n`
        : `### Durable (auto-graduated: survived ${GRADUATE_AFTER}+ reconciles; held until superseded)\n`)
        + durable.map(renderRule).join('\n') + '\n';
    }
    if (emerging.length) {
      body += `### Emerging (volatile: promotes to Durable after ${GRADUATE_AFTER} consecutive reconciles)\n`
        + emerging.map(renderRule).join('\n') + '\n';
    }
  }
  body += `<!-- managed:reconciler:end -->\n`;
  return body;
}

// replace the existing fence in place, else append one at EOF after a blank line (§6a.4).
function spliceFence(text, fence) {
  if (FENCE_RE.test(text)) return text.replace(FENCE_RE, fence);
  const base = text.trimEnd();
  return base ? `${base}\n\n${fence}` : fence;
}

// strip the managed fence from a file's text -> the hand-authored skeleton only (for dedup context).
function skeletonOf(text) { return text.replace(FENCE_RE, '').trim(); }

// ---------- projection state (streaks / graduated / last-emerging / gate-sig, per scope) ----------
// The home for the durable lifecycle; the CLAUDE.md fence is a pure render of it. Shape:
//   { "<scope>": { streaks: { "<sourceId>": <n> }, graduated: { "<sourceId>": { rule, source } },
//                  emerging: [{ rule, source }], gateSig: "<sha8>" } }
// Scope names and source node ids are untrusted keys, so every map here is null-prototype, on load as
// well as on construction: a plain `{}` rehydrated from JSON would make an id like `__proto__` or
// `toString` behave differently after a reload than it does on a fresh run.
const nullMap = (o) => Object.assign(Object.create(null), o);
async function loadProjState() {
  let raw;
  try { raw = JSON.parse(await readFile(PROJ_STATE_FILE, 'utf8')); } catch { return Object.create(null); }
  const state = Object.create(null);
  for (const [scope, sc] of Object.entries(raw || {})) {
    state[scope] = {
      ...sc, streaks: nullMap(sc && sc.streaks), graduated: nullMap(sc && sc.graduated),
      // MEM-38 step 5: cap-blocked graduations and gate-passed-over proposed-rule candidates are
      // id-keyed persisted maps too, so they get the same null-prototype rehydration.
      capBlocked: nullMap(sc && sc.capBlocked), proposed: nullMap(sc && sc.proposed),
      retireProposed: nullMap(sc && sc.retireProposed),
    };
  }
  return state;
}
async function saveProjState(state) {
  await mkdir(dirname(PROJ_STATE_FILE), { recursive: true });
  // tmp + rename: this file carries ratification lifecycle and the human-set cap dial, so a torn
  // write loses human decisions. Entropy is randomUUID, not pid alone: two same-process callers
  // share a pid and would clobber each other's tmp file mid-write.
  const tmp = `${PROJ_STATE_FILE}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, PROJ_STATE_FILE);
}
const scopeState = (state, scope) => (state[scope] ||= {
  streaks: nullMap(), graduated: nullMap(), emerging: [], gateSig: '',
  capBlocked: nullMap(), proposed: nullMap(), retireProposed: nullMap(),
});
// decision 4: the cap is negotiable but only a human names a new number (written into `sc.cap`);
// anything unset or malformed falls back to the default, never to "unlimited".
const capOf = (sc) => (Number.isInteger(sc.cap) && sc.cap > 0 ? sc.cap : DEFAULT_CAP);

// ---------- the adversarial gate (judge, hard tier) ----------
// `sticky` = last run's emerging picks. Fed back so the gate keeps them unless there is a clear reason
// to change (hysteresis): this is what turns the borderline coin-flip into a stable set run-to-run.
function gatePrompt(scope, audience, candidates, skeleton, sticky, cap) {
  const cand = candidates.map((n) =>
    `[${n.id}] (centrality ${n.frontmatter.centrality}) ${n.frontmatter.title}\n  ${truncate(n.prose.replace(/\s+/g, ' '), PROSE_CHARS)}`
  ).join('\n\n');
  const prior = (sticky || []).filter((r) => r && r.rule).map((r) => `- ${r.rule}${r.source ? ` [[${r.source}]]` : ''}`).join('\n');
  const shell = audience === 'operator'
    ? `the "${scope}" OPERATOR shell (SOUL.md — Hermes the operator's always-loaded identity)`
    : `the "${scope}" scope's CLAUDE.md`;
  return `You curate the ALWAYS-LOADED behavioral rules for ${shell} — the few \
operating rules worth putting in front of the model in EVERY session (not retrieval-gated). Below are \
candidate behavioral memory nodes, the rules ALREADY hand-written in the always-loaded skeleton, and the \
set you selected on the PREVIOUS run.

Pick ONLY the candidates that genuinely deserve always-loading, applying an adversarial lens:
- STABILITY FIRST: keep each previously-selected rule whose candidate is still present, UNLESS there is a
  clear reason to drop it (it is now covered by the skeleton, became transient, or a better candidate
  supersedes it). Add or drop only on a clear basis — do not churn the set for cosmetic rewording.
- STANDING POLICY: projected rules ADD doctrine, they never RESTATE it. DROP anything already covered
  anywhere in the always-loaded stack below (hand-authored doctrine or already-projected rules), even
  loosely paraphrased — restating always-loaded text is pure bloat.
- DROP transient / build-in-progress scaffolding ("we are currently on phase X") — keep only DURABLE rules
  that will still matter after the current work ships.
- DROP vague platitudes and aspirational identity statements ("use the systems lens"); keep only rules a
  model could act on.
- Rephrase each survivor as ONE tight imperative line (≤ ~20 words) in operational do-X-when-Y form: name
  the trigger condition and the action, not a value or a vibe. Keep its source node id; reuse the
  previous wording verbatim when the rule is unchanged (stable diffs).
- Write plain prose: never use em or en dashes as punctuation (commas, colons, parentheses instead).
- Hard cap ${cap}. Prefer FEW. Returning an EMPTY array is a correct, common outcome.

Reply ONLY a JSON array (possibly empty): [{ "rule": "<imperative one-liner>", "source": "<candidate node id>" }]

ALREADY-LOADED SKELETON (do not duplicate these):
"""
${skeleton || '(none)'}
"""

PREVIOUSLY SELECTED (keep unless clearly wrong):
"""
${prior || '(none — first run)'}
"""

CANDIDATES (eligible for selection; graduated rules are excluded and must not be re-listed):
${cand}`;
}

// ---------- git (auto-commit, scoped to the cockpit repo only) ----------
async function repoRoot(dir) {
  try { return (await execFileP('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).stdout.trim(); }
  catch { return null; }
}
// commit a single touched file IFF it belongs to a repo the reconciler OWNS (cockpit public or memory
// private); a foreign project/client repo / no repo -> write only. Returns 'committed' | 'written' | 'nochange'.
async function commitFile(file) {
  const root = await repoRoot(dirname(file));
  // Defense-in-depth for MEM-32 (layer 2, at the write boundary): the normal cockpit run owns both the
  // public cockpit repo and its memory repo; an ISOLATED run owns only its own root, so it may never
  // commit into the repo root even if a route slipped past the addRoute guard above.
  const ownRoots = IS_ISOLATED_ROOT ? [MEMORY_ROOT] : [COCKPIT_ROOT, MEMORY_ROOT];
  if (!ownRoots.includes(root)) return 'written';   // never commit a foreign / out-of-boundary repo
  const rel = relative(root, file);
  await execFileP('git', ['-C', root, 'add', '--', rel]);
  try {
    await commitAt(root, ['-m', `reconcile: project memory -> ${rel}`, '--quiet', '--', rel]);
    return 'committed';
  } catch (e) {
    // pathspec-scoped commit with no diff for `rel`: "nothing to commit" (clean tree), "no changes
    // added to commit" (other files unstaged), or "nothing added to commit but untracked files
    // present" (clean index, untracked files in tree) — all mean this file is unchanged, not a
    // real failure.
    if (/nothing (added )?to commit|no changes added to commit/i.test(e.stderr || e.stdout || '')) return 'nochange';
    throw e;
  }
}

// ============================================================ main entry
// project(pool, { dryRun }) -> audit array. Called by reconcile.mjs after PHASE-1 node commit.
export async function project(pool, { dryRun = false } = {}) {
  const globalSkeleton = await readFile(GLOBAL_SKELETON, 'utf8').catch(() => '');
  const state = await loadProjState();

  // Read scopes from memory/scopes.json (same source as reconcile.mjs). Fallback to safe minimum.
  let knownScopes = ['global', 'cockpit'];
  try {
    const raw = JSON.parse(await readFile(resolve(MEMORY_ROOT, 'scopes.json'), 'utf8'));
    if (Array.isArray(raw) && raw.length) knownScopes = raw.filter(isScopeSlug);   // slug gate (Codex 2nd-round finding 4)
  } catch { /* use defaults */ }
  // KNOWN routes to sweep for a now-empty fence to clear: every builder scope + the global operator shell.
  const knownRoutes = [...knownScopes.map((s) => [s, 'builder']), ['global', 'operator']];

  // ROUTES (B4 audience axis): the unit of projection is a (scope × audience) route, not a scope — one
  // scope (global) hosts both a builder route (→ CLAUDE.md) and an operator route (→ SOUL.md). Consider:
  // any route with behavioral candidates; any route with existing projection-state (so demotion/cleanup
  // runs); any KNOWN route whose target already carries a fence (clear a now-empty one). operator+non-global
  // routes have no target (null) and are dropped here (GA2) — the node simply doesn't project.
  const routes = new Map();   // routeKey -> { scope, audience, key, file }
  // MEM-32: an isolated (walled) root may only write targets inside itself. targetFor() resolves the
  // system routes (global/operator→SOUL.md, global→CLAUDE.md, cockpit→<repo>/CLAUDE.md) from the
  // hardcoded COCKPIT_ROOT regardless of MEMORY_ROOT — so without this guard a walled-scope run would rewrite the
  // shared cockpit shells (emptying their rules) and commit into the repo root. Path-containment, not a
  // per-file blacklist, so it covers every out-of-root target uniformly. No-op on the normal cockpit run.
  // REALPATH-based, not lexical: a symlink under MEMORY_ROOT pointing into the repo root would pass a lexical
  // check yet the write follows it out (Codex review, 2026-07-03). Containment holds only if BOTH (a) the
  // target's real parent dir is inside the real root — catches a symlinked path component / symlinked dir —
  // AND (b) the final component is not itself a symlink — catches a symlinked (or dangling-symlink) file
  // that writeFile would follow out. The file itself need not exist yet (its dir always does for real
  // routes); a missing final component is a fresh regular write, allowed. Fail-closed on any resolve error.
  const realRoot = IS_ISOLATED_ROOT ? realpathSync(MEMORY_ROOT) : null;
  const insideRoot = (f) => {
    try {
      const rel = relative(realRoot, realpathSync(dirname(f)));                 // (a) real parent inside root?
      if (rel !== '' && (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) return false;
      try { if (lstatSync(f).isSymbolicLink()) return false; } catch { /* (b) missing = fresh regular write */ }
      return true;
    } catch { return false; }                           // unresolvable parent → not provably inside → drop
  };
  const addRoute = (scope, audience) => {
    // Scope gate (Codex 2nd-round finding 4): scope names arrive from node frontmatter,
    // projection-state keys, and scopes.json — validate the slug (no path escapes) and require
    // registration before any filesystem resolution ('global' is the operator route,
    // 'demo' the OSS seed scope).
    if (!isScopeSlug(scope)) { console.warn(`projection: skipping route with invalid scope ${JSON.stringify(scope)}`); return; }
    if (!['global', 'demo'].includes(scope) && !registeredScopes().includes(scope)) {
      console.warn(`projection: skipping route for unregistered scope ${JSON.stringify(scope)}`);
      return;
    }
    const file = targetFor(scope, audience);
    if (!file) return;                                  // operator+non-global: no route (GA2)
    if (IS_ISOLATED_ROOT && !insideRoot(file)) {
      console.warn(`projection: skipping route ${JSON.stringify(routeKey(scope, audience))}: target ${JSON.stringify(file)} not provably inside the isolated root (MEM-32)`);
      return;
    }
    const key = routeKey(scope, audience);
    if (!routes.has(key)) routes.set(key, { scope, audience, key, file });
  };
  // audience 'both' (AR-3 item 11 twin-family merge): one node serving both disjoint stacks — routes
  // to the builder AND operator targets instead of maintaining twin builder/operator node families.
  for (const n of pool) if (isBehavioral(n)) {
    const aud = n.frontmatter.audience || 'builder';
    for (const a of aud === 'both' ? ['builder', 'operator'] : [aud]) addRoute(n.frontmatter.scope, a);
  }
  for (const key of Object.keys(state)) { const [s, a] = parseRouteKey(key); addRoute(s, a); }
  for (const [s, a] of knownRoutes) {
    const t = await readFile(targetFor(s, a), 'utf8').catch(() => null);
    if (t && FENCE_RE.test(t)) addRoute(s, a);
  }

  // loaded once per run (not once per rule): checkDurableDrift's open-finding skip needs the
  // insights pool, and re-reading the store for every durable rule in every scope would be waste.
  const insightsPool = await loadInsights();

  const audit = [];
  for (const { scope, audience, key, file } of [...routes.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const existing = await readFile(file, 'utf8').catch(() => '');
    const sc = scopeState(state, key);

    // candidates: behavioral, THIS route (scope × audience; pre-B4 nodes default to builder), above the
    // centrality floor, strongest first.
    const candidates = pool
      .filter((n) => isBehavioral(n) && n.frontmatter.scope === scope
        && ['both', audience].includes(n.frontmatter.audience || 'builder')
        && n.frontmatter.claim !== 'reported'   // MEM-37: a source attribution never graduates into always-load doctrine
        && (n.frontmatter.centrality || 0) >= CENTRALITY_FLOOR)
      .sort((a, b) => (b.frontmatter.centrality || 0) - (a.frontmatter.centrality || 0));
    const candById = new Map(candidates.map((n) => [n.id, n]));

    // --- RATIFIED LANE SOURCES (MEM-38 step 5, decision 1): a human-ratified behavioral node
    //     bypasses the centrality floor and the MEM-37 reported filter above, so it can sit
    //     OUTSIDE candById; every source-id resolution below must also look here. Superseded
    //     nodes are excluded by isBehavioral, which is exactly the ratified lane's demotion gate.
    const ratById = new Map(pool
      .filter((n) => isBehavioral(n) && n.frontmatter.scope === scope
        && ['both', audience].includes(n.frontmatter.audience || 'builder')
        && n.frontmatter.ratified)
      .map((n) => [n.id, n]));
    const nodeOf = (id) => candById.get(id) || ratById.get(id);
    const centOf = (id) => (nodeOf(id)?.frontmatter.centrality || 0);
    // durable orderings are ratified-first (a ratified rule never lands in silent overflow),
    // centrality within a lane.
    const laneOf = (id) => (ratById.has(id) ? 1 : 0);
    const byLaneThenCent = (a, b) => laneOf(b.source) - laneOf(a.source) || centOf(b.source) - centOf(a.source);

    // --- DEMOTION, two lanes (decision 2). Unratified: candidate membership, exactly as before
    //     (superseded / below floor / reported / gone). Ratified: the rule sits outside candById
    //     by design, so it demotes only when its source node is superseded or gone from the pool
    //     (both of which empty its ratById entry). Deterministic, never an LLM guess.
    const demoted = [];
    for (const id of Object.keys(sc.graduated)) {
      if (!candById.has(id) && !ratById.has(id)) { demoted.push(id); delete sc.graduated[id]; delete sc.streaks[id]; }
    }
    const graduatedIds = new Set(Object.keys(sc.graduated));

    // --- LOAD STACK (AR-3 direction 3): the inherited always-loaded context for this route, FULL
    //     text (an ancestor's projected fence is inherited coverage too — using skeletonOf() here was
    //     the mechanism behind the audit's 5x duplication: cockpit's gate never saw global's projected
    //     rules). Own file stays skeletonOf(): its fence is the output being recomputed.
    const ancestorTexts = [];
    for (const f of stackFilesFor(scope, audience)) {
      const t = f === GLOBAL_SKELETON ? globalSkeleton : await readFile(f, 'utf8').catch(() => '');
      const expanded = await coverageText(t, f);   // @-imported doctrine is inherited coverage too
      if (expanded.trim()) ancestorTexts.push(expanded);
    }

    // this route's own hand skeleton (its fence is the output being recomputed, so it is stripped),
    // imports resolved. Computed once: both dedup consumers below must see the same corpus.
    const ownSkeleton = await coverageText(skeletonOf(existing), file);

    // --- EMBEDDING SUPPRESSION GATE (deterministic backstop, threshold SUPPRESS_COS): a rule already
    //     covered near-verbatim by hand doctrine or another projected rule anywhere in the inherited
    //     stack is suppressed, with a suppressed-by trail recorded on its source node. Durable rules
    //     are checked every run against (a) the stack + own hand skeleton and (b) higher-centrality
    //     durable siblings — so a restatement that slipped in is auto-demoted, not held forever.
    //     Runs BEFORE the drift check so a rule about to be suppressed doesn't emit a stale drift
    //     insight. The try holds MEASUREMENT ONLY (embed + cosines + decisions): embed() failure
    //     skips suppression for the route (fail-open: nothing demoted, nothing lost); the side
    //     effects (suppressed_by trail, then state deletion) apply after the try, so a trail-write
    //     failure throws and fails the route loudly BEFORE the rule leaves state, never persisting
    //     a removal with no trail (Codex reviews 2026-07-18 findings 2+4, step-5 round 3).
    const suppressed = [];
    const retireProposals = [];
    const suppressDecisions = [];     // measured inside the try, side effects applied after it
    let suppressionMeasured = true;   // embed() failure flips this: no cosines = no evidence either way
    let covStackVecs = null;          // stack chunk vectors, kept for the proposed-rule coverage check below
    const coverage = stackChunks([...ancestorTexts, ownSkeleton].join('\n'));
    const durableEntries = Object.values(sc.graduated).sort(byLaneThenCent);
    if (coverage.length && durableEntries.length) {
      try {
        const vecs = await embed([...coverage, ...durableEntries.map((r) => r.rule)]);
        const covVecs = covStackVecs = vecs.slice(0, coverage.length);
        const durVecs = vecs.slice(coverage.length);
        const keptDurVecs = [], keptDurRules = [];
        for (let i = 0; i < durableEntries.length; i++) {
          const r = durableEntries[i];
          const vsStack = bestMatch(durVecs[i], covVecs, coverage);
          const vsSibling = keptDurVecs.length ? bestMatch(durVecs[i], keptDurVecs, keptDurRules) : { cos: -1 };
          const hit = vsStack.cos >= vsSibling.cos ? vsStack : { ...vsSibling, chunk: `projected sibling: ${vsSibling.chunk}` };
          if (hit.cos >= SUPPRESS_COS && !ratById.has(r.source)) {
            // decision only: the deletion + trail write happen after the try. A rule decided
            // suppressed here never joins keptDurVecs, so it cannot count as sibling coverage
            // for a later rule in this same pass.
            suppressDecisions.push({ rule: r.rule, source: r.source, by: hit.chunk, cos: hit.cos });
          } else {
            // decision 3: the backstop never auto-deletes a RATIFIED rule (a human decision is
            // reversed only by a human); over the threshold it proposes retirement via a card
            // instead, and the rule stays durable, still counting as sibling coverage.
            if (hit.cos >= SUPPRESS_COS) retireProposals.push({ rule: r.rule, source: r.source, by: hit.chunk, cos: hit.cos });
            keptDurVecs.push(durVecs[i]); keptDurRules.push(r.rule);
          }
        }
      } catch (e) { suppressionMeasured = false; console.log(`  ! ${key}: embedding suppression skipped — ${e.message}`); }
    }
    // OUTSIDE the embed try (Codex step-5 review, round 3): apply the suppression side effects
    // per rule, trail FIRST, deletion second. recordSuppression failing throws uncaught (the
    // module's write-failure convention) and fails the route before the durable rule is deleted,
    // so state never persists a removal whose suppressed_by trail was not recorded. Guarded on
    // suppressionMeasured: no cosines = no decisions to apply.
    if (suppressionMeasured) for (const d of suppressDecisions) {
      const node = candById.get(d.source);
      if (node && !dryRun) await recordSuppression(node, d.by, d.cos, key);
      delete sc.graduated[d.source]; delete sc.streaks[d.source]; graduatedIds.delete(d.source);
      suppressed.push(d);
    }
    // dedupe ledger for the retirement cards: one card per ratified rule while it stays over the
    // threshold. The clear distinguishes "we measured and nothing is over" (empty coverage corpus,
    // no durables, or every cosine under threshold: clear the records so a later re-cover
    // re-mints) from "we could not measure" (embed() threw: keep the records, that run produced
    // no evidence either way).
    if (suppressionMeasured) {
      const over = new Set(retireProposals.map((p) => p.source));
      for (const id of Object.keys(sc.retireProposed)) if (!over.has(id)) delete sc.retireProposed[id];
    }
    // OUTSIDE the embed try (Codex step-5 review, finding A): a card-persistence failure is a
    // write failure, not an embed failure; like the cap-card and proposed-rule mints below it
    // throws and fails the route loudly instead of flipping suppressionMeasured. Guarded on
    // suppressionMeasured so a mid-loop failure above never mints from a partial proposal set.
    if (!dryRun && suppressionMeasured) for (const p of retireProposals) {
      if (sc.retireProposed[p.source] !== undefined) continue;
      const iid = await nextInsightId(`ratified-rule-retirement-${p.source}`);
      await writeInsightFile({
        id: iid,
        claim: `Ratified rule [[${p.source}]] is near-verbatim covered elsewhere in the always-loaded stack (cosine ${p.cos.toFixed(2)}); propose retiring it.`,
        evidence: [`rule: ${p.rule}`, `covered by: ${truncate(p.by, 160)}`],
        suggested_fix: 'If the coverage is real, retire the rule (supersede its source node); the backstop will never remove a ratified rule on its own.',
        // step 7 ruling: accept reverses the human ratification (unratify graph-op). Preconditions
        // are REQUIRED for unratify; a moved node must refuse and re-mint, never apply stale.
        // project: true asks accept.mjs for the detached projection refresh that corrects the
        // durable roster (card.frontmatter.project === true, accept.mjs).
        on_accept: { kind: 'unratify', node: p.source },
        ...(await nodePreconditions(p.source, ratById.get(p.source).frontmatter)),
        project: true,
        source: 'projection:ratified-rule-retirement', pattern: p.source, scope, status: 'new',
        detected: new Date().toISOString(), detector: 'ratified-rule-retirement',
      }, 'Relates: MEM-38 step 5, decision 3 (the suppression backstop reports instead of deleting on the ratified lane).');
      sc.retireProposed[p.source] = { insight: iid, at: today() };
    }

    // --- OPEN-18 drift check: a durable rule is held (never re-judged) once graduated, so nothing
    //     re-examines it against either (c) its own source node's body OR (a) the scope's decision
    //     ledger. Two independent triggers, either one re-checks EVERY durable rule in this scope
    //     (a ledger change can narrow/reverse a rule whose own node never moved — Codex review,
    //     2026-07-17: gating solely on the node-hash diff misses exactly that case, the more common
    //     shape of surface (a)). Skipped entirely on dry-run (no insight writes).
    const drifted = [];
    if (!dryRun) {
      const decisionsText = await decisionsForScope(scope);
      const decisionsHash = sha8(decisionsText);
      const ledgerMoved = sc.decisionsHash && sc.decisionsHash !== decisionsHash;
      sc.decisionsHash = decisionsHash;
      for (const id of graduatedIds) {
        const node = nodeOf(id);   // ratified sources live outside candById; they drift-check too
        if (!node) continue;
        const g = sc.graduated[id];
        const currentHash = contentHash(node.prose);
        const nodeMoved = g.sourceHash && g.sourceHash !== currentHash;
        if (nodeMoved || ledgerMoved) {
          const found = await checkDurableDrift({ scope, rule: g, node, cachedHash: g.sourceHash, currentHash, decisionsText, nodeMoved, ledgerMoved, insightsPool });
          if (found) drifted.push(found);
        }
        g.sourceHash = currentHash;   // backfill (first run) or advance (after flagging) — never re-fires same diff
      }
    }

    // the gate only ever sees NOT-yet-graduated candidates — durable rules are held, not re-judged.
    // Ratified candidates are excluded too: they graduate this run through their own door below,
    // so letting the gate pick one would spend an emerging slot on a rule already durable-bound.
    const gateCandidates = candidates.filter((n) => !graduatedIds.has(n.id) && !ratById.has(n.id));

    // dedup context handed to the LLM gate = the full inherited stack + this route's own hand
    // skeleton + its durable rules (already always-loaded, so the gate never re-proposes one).
    // Operator routes inherit nothing (disjoint stack — see stackFilesFor).
    const durableText = Object.values(sc.graduated).map((r) => `- ${r.rule}`).join('\n');
    const skeleton = [...ancestorTexts, ownSkeleton, durableText]
      .filter(Boolean).join('\n\n');

    // --- GATE (sticky), skipped when its inputs are unchanged: reuse last emerging set, no judge call.
    const gateSig = sha8(JSON.stringify([
      gateCandidates.map((n) => [n.id, contentHash(n.prose), n.frontmatter.centrality]),
      sha8(skeleton),
      (sc.emerging || []).map((r) => [r.rule, r.source]),
    ]));
    let emerging, gated;
    if (gateCandidates.length && gateSig !== sc.gateSig) {
      try {
        const got = await judge(gatePrompt(scope, audience, gateCandidates, skeleton, sc.emerging, capOf(sc)), { tier: 'hard', json: true });
        emerging = Array.isArray(got) ? got : [];
        gated = true;
      } catch (e) { audit.push({ scope, audience, key, file, error: e.message }); continue; }
    } else {
      emerging = sc.emerging || [];   // reuse — stickiness guarantees the gate would re-select it
      gated = false;
    }
    sc.gateSig = gateSig;

    // validate + resolve source against the gate candidates; order by centrality; backlink known ids only.
    emerging = emerging
      .filter((r) => r && typeof r.rule === 'string' && r.rule.trim())
      .map((r) => ({ rule: r.rule.trim(), source: gateCandidates.some((n) => n.id === r.source) ? r.source : null }))
      .sort((a, b) => centOf(b.source) - centOf(a.source));

    // embedding backstop on the gate's picks: the LLM gate is told not to restate, this enforces the
    // near-verbatim end of it deterministically (same corpus + durable survivors as coverage).
    if (emerging.length) {
      const emCoverage = [...coverage, ...Object.values(sc.graduated).map((r) => r.rule)];
      if (emCoverage.length) {
        try {
          const vecs = await embed([...emCoverage, ...emerging.map((r) => r.rule)]);
          const covVecs = vecs.slice(0, emCoverage.length);
          const kept = [];
          for (let i = 0; i < emerging.length; i++) {
            const r = emerging[i];
            const hit = bestMatch(vecs[emCoverage.length + i], covVecs, emCoverage);
            if (hit.cos >= SUPPRESS_COS) {
              suppressed.push({ rule: r.rule, source: r.source, by: hit.chunk, cos: hit.cos });
              if (r.source) { delete sc.streaks[r.source]; const node = candById.get(r.source); if (node && !dryRun) await recordSuppression(node, hit.chunk, hit.cos, key); }
            } else kept.push(r);
          }
          emerging = kept;
        } catch (e) { console.log(`  ! ${key}: emerging suppression skipped — ${e.message}`); }
      }
    }

    // --- STREAK: a survival = the rule is still selected (or reused while gate inputs hold). Consecutive.
    const keptIds = new Set(emerging.map((r) => r.source).filter(Boolean));
    for (const id of keptIds) sc.streaks[id] = (sc.streaks[id] || 0) + 1;
    for (const id of Object.keys(sc.streaks)) if (!keptIds.has(id)) delete sc.streaks[id];

    // --- RATIFIED GRADUATION (MEM-38 step 5): ratify -> durable immediately, no streak (the streak
    //     accumulates confidence in the ABSENCE of human input; ratification is that input arriving
    //     first-hand). Runs before the streak loop: this is the durable set's second door, and the
    //     cap below gates BOTH doors. Wording: keep the gate's wording where one exists (this run's
    //     pick, else last run's sticky set), otherwise fall back to the node title, the one
    //     deterministic one-liner every node carries (first non-empty prose line if title is absent).
    const cap = capOf(sc);
    const capBlocked = [];
    const ratifiedIn = [];
    const oneLinerFor = (id, node) => {
      const prior = emerging.find((r) => r.source === id) || (sc.emerging || []).find((r) => r.source === id);
      return prior ? prior.rule
        : String(node.frontmatter.title || node.prose.split('\n').map((l) => l.trim()).find(Boolean) || id);
    };
    for (const [id, node] of ratById) {
      if (sc.graduated[id] !== undefined) continue;
      const rule = oneLinerFor(id, node);
      // decision 4: a full block BLOCKS the graduation and mints the three-door card below; it
      // never silently slices whoever sorts lowest.
      if (Object.keys(sc.graduated).length >= cap) { capBlocked.push({ rule, source: id, door: 'ratified' }); continue; }
      sc.graduated[id] = { rule, source: id, sourceHash: contentHash(node.prose) };
      delete sc.streaks[id];
      ratifiedIn.push(id);
    }
    emerging = emerging.filter((r) => !r.source || sc.graduated[r.source] === undefined);

    // --- GRADUATION: survived GRADUATE_AFTER consecutive runs -> move to the durable layer (leaves emerging).
    const graduated = [];
    for (const r of emerging) {
      if (r.source && (sc.streaks[r.source] || 0) >= GRADUATE_AFTER) {
        // decision 4 covers this door too: blocked keeps the rule emerging (its streak holds, so it
        // retries every run until a human opens a door via the card).
        if (Object.keys(sc.graduated).length >= cap) { capBlocked.push({ rule: r.rule, source: r.source, door: 'streak' }); continue; }
        sc.graduated[r.source] = { rule: r.rule, source: r.source, sourceHash: contentHash(candById.get(r.source).prose) };
        delete sc.streaks[r.source];
        graduated.push(r.source);
      }
    }
    emerging = emerging.filter((r) => !graduated.includes(r.source));
    sc.emerging = emerging;

    // --- CAP CARD (decision 4): one card per blocked rule while it stays blocked, offering the
    //     three doors; the record clears when the block resolves so a later re-block re-mints.
    for (const id of Object.keys(sc.capBlocked)) if (!capBlocked.some((b) => b.source === id)) delete sc.capBlocked[id];
    // audit-only truthfulness (Codex step-5 review, finding B): each blocked entry records what
    // actually happened to its card, so printProjection never claims a mint the dedupe skipped.
    for (const b of capBlocked) {
      const carded = sc.capBlocked[b.source] !== undefined;
      b.status = dryRun ? (carded ? 'would-skip' : 'would-mint') : (carded ? 'already-carded' : 'minted');
      if (dryRun || carded) continue;
      const roster = Object.values(sc.graduated).sort(byLaneThenCent);
      const iid = await nextInsightId(`cap-blocked-${b.source}`);
      await writeInsightFile({
        id: iid,
        claim: `The ${key} always-load block is full (${roster.length}/${cap}), so "${b.rule}" [[${b.source}]] (${b.door === 'ratified' ? 'human-ratified' : 'streak-graduated'}) is BLOCKED from graduating until you pick a door.`,
        evidence: [
          `cost: these rules load into EVERY ${key} session (~${roster.reduce((n, r) => n + r.rule.length, 0)} chars of always-loaded text today)`,
          `current roster:`,
          ...roster.map((r) => `- ${r.rule} [[${r.source}]]${ratById.has(r.source) ? ' (ratified)' : ''}`),
        ],
        suggested_fix: `Three doors: retire a named rule (supersede its source node), raise the cap to a number you name (set "cap" for "${key}" in memory/.reconciler/projection-state.json), or leave the rule emerging (do nothing). The cap is never raised automatically.`,
        source: 'projection:cap-blocked', pattern: b.source, scope, status: 'new',
        detected: new Date().toISOString(), detector: 'cap-blocked-graduation',
      }, 'Relates: MEM-38 step 5, decision 4 (the cap is a negotiable dial covering both graduation doors).');
      sc.capBlocked[b.source] = { insight: iid, at: today(), door: b.door };
    }

    // --- PROPOSED-RULE CARDS (understanding-pass item 5): rule-shaped candidates the gate passed
    //     over are the fallback ratification surface (the in-session ask is primary). The gate
    //     discards them, so a persisted per-candidate record (keyed by node id, re-minting only
    //     when the node's content moves) keeps cards from re-minting every run.
    const keptNow = new Set(emerging.map((r) => r.source).filter(Boolean));
    const passedOver = gateCandidates.filter((n) => !keptNow.has(n.id) && sc.graduated[n.id] === undefined);
    for (const id of Object.keys(sc.proposed)) if (!passedOver.some((n) => n.id === id)) delete sc.proposed[id];
    // doctrine-coverage check before carding: the LLM gate deliberately drops candidates the
    // always-loaded stack already covers (its STANDING POLICY), so carding those invites ratifying
    // a duplicate into the harness. Same deterministic backstop as the suppression gate (stack
    // chunks vs SUPPRESS_COS), fail-open: embed() failure = no coverage evidence = the card mints
    // as today. A covered candidate leaves NO sc.proposed record, so the card mints normally if
    // doctrine later stops covering it.
    const coveredByStack = new Map();   // node id -> best stack hit over the threshold
    if (!dryRun && coverage.length && passedOver.length) {
      try {
        if (!covStackVecs) covStackVecs = await embed(coverage);
        const candVecs = await embed(passedOver.map((n) => n.prose));
        for (let i = 0; i < passedOver.length; i++) {
          const hit = bestMatch(candVecs[i], covStackVecs, coverage);
          if (hit.cos >= SUPPRESS_COS) coveredByStack.set(passedOver[i].id, hit);
        }
      } catch (e) { console.log(`  ! ${key}: proposed-rule coverage check skipped — ${e.message}`); }
    }
    if (!dryRun) for (const n of passedOver) {
      const cov = coveredByStack.get(n.id);
      if (cov) {
        delete sc.proposed[n.id];
        console.log(`  ~ ${key}: proposed-rule card for [[${n.id}]] skipped, covered by stack (cos ${cov.cos.toFixed(2)})`);
        continue;
      }
      const hash = contentHash(n.prose);
      if (sc.proposed[n.id] !== undefined && sc.proposed[n.id].hash === hash) continue;
      const iid = await nextInsightId(`proposed-rule-${n.id}`);
      const fm = {
        id: iid,
        claim: `Behavioral node "${n.frontmatter.title}" [[${n.id}]] qualifies for always-load (centrality ${n.frontmatter.centrality}) but the gate passed it over; an explicit ratification would graduate it immediately.`,
        evidence: [
          `candidate: ${truncate(n.prose.replace(/\s+/g, ' '), PROSE_CHARS)}`,
          `streak ${sc.streaks[n.id] || 0}/${GRADUATE_AFTER} (gate-selected runs in a row)`,
        ],
        suggested_fix: `node ~/cockpit/memory-engine/ratify.mjs ${n.id} --via dashboard --turn <session>:<turn>`,
        // step 7 ruling: accept ratifies the source node. Preconditions are optional for ratify,
        // minted anyway: a card executing against a moved node must refuse and re-mint.
        on_accept: { kind: 'ratify', node: n.id },
        ...(await nodePreconditions(n.id, n.frontmatter)),
        source: 'projection:proposed-rule', pattern: n.id, scope, status: 'new',
        detected: new Date().toISOString(), detector: 'proposed-rule',
      };
      // composed at mint like the other card minters, same fail-soft {}: this card IS the fallback
      // ratification surface, so it must not render degraded on the dashboard.
      await writeInsightFile({ ...fm, ...(await composeFields(fm)) },
        'Relates: MEM-38 step 5 (fallback ratification surface; ratify -> durable immediately, no streak).');
      sc.proposed[n.id] = { hash, insight: iid, at: today() };
    }

    // --- CAP render slice (durable + emerging ≤ cap): both doors are blocked at a full block, so
    //     durable can never exceed the cap here; the slice stays as a last-resort guard and the
    //     ratified-first order guarantees a ratified rule is never the one sliced.
    const durable = Object.values(sc.graduated)
      .map((r) => ({ ...r, ratified: ratById.has(r.source) }))
      .sort(byLaneThenCent);
    const durableShown = durable.slice(0, cap);
    const emergingShown = emerging.slice(0, Math.max(0, cap - durableShown.length));
    // named, not counted: a silent tally hides WHICH rule fell off the block.
    const dropped = [...durable.slice(durableShown.length), ...emerging.slice(emergingShown.length)]
      .map((r) => ({ rule: r.rule, source: r.source }));

    // nothing to show AND no fence to clear -> don't create an empty file; drop any vestigial state.
    if (!durableShown.length && !emergingShown.length && !FENCE_RE.test(existing)) {
      // vestigial-state cleanup must not drop live step-5 bookkeeping (pending cards, a human-set cap)
      if (!Object.keys(sc.streaks).length && !Object.keys(sc.capBlocked).length
        && !Object.keys(sc.proposed).length && !Object.keys(sc.retireProposed).length
        && sc.cap === undefined) delete state[key];
      audit.push({ scope, audience, key, file, skipped: 'no-candidates', graduated, ratified: ratifiedIn, capBlocked, demoted, drifted, suppressed, retireProposals });
      continue;
    }

    const fence = renderFence(durableShown, emergingShown, gateSig);
    const next = spliceFence(existing, fence);

    if (dryRun) {
      audit.push({ scope, audience, key, file, durable: durableShown, emerging: emergingShown, graduated, ratified: ratifiedIn, capBlocked, demoted, drifted, suppressed, retireProposals, dropped, gated, preview: fence, wrote: false });
      continue;
    }

    let commit = 'nochange';
    if (next !== existing) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, next, 'utf8');
      commit = await commitFile(file);
      // Hermes reads the CONCAT (shells/SOUL.generated.md, layout §4), not SOUL.md itself:
      // regenerate it whenever the SOUL fence changes so drift stays impossible. A concat
      // failure is a ROUTE failure (Codex 2nd-round finding 3): Hermes would keep loading a
      // stale generated file, so it must not be reported as a successful write.
      if (file === GLOBAL_SOUL) {
        try { await generateSoul(); } catch (e) {
          console.error('projection: SOUL concat regeneration FAILED — shells/SOUL.generated.md is stale:', e.message);
          audit.push({ scope, audience, key, file, durable: durableShown, emerging: emergingShown, graduated, ratified: ratifiedIn, capBlocked, demoted, drifted, suppressed, retireProposals, dropped, gated, wrote: true, commit, error: `soul-concat-failed: ${e.message}` });
          continue;
        }
      }
    }
    audit.push({ scope, audience, key, file, durable: durableShown, emerging: emergingShown, graduated, ratified: ratifiedIn, capBlocked, demoted, drifted, suppressed, retireProposals, dropped, gated, wrote: next !== existing, commit });
  }

  // persist + commit projection state (no-op commit if unchanged, e.g. a fully-settled scope).
  if (!dryRun) { await saveProjState(state); await commitFile(PROJ_STATE_FILE); }
  return audit;
}

// pretty-print an audit (shared by reconcile + direct run).
export function printProjection(audit, dryRun) {
  console.log(`\n=== CLAUDE.md projection ${dryRun ? '(dry-run)' : ''} ===`);
  if (!audit.length) { console.log('  (no scopes considered)'); return; }
  // wording per entry from the recorded card outcome, never from dryRun alone: the persisted
  // dedupe skips minting on a repeat block, live or dry (Codex step-5 review, finding B).
  const CAP_CARD_LABEL = {
    minted: 'card minted', 'already-carded': 'already carded',
    'would-mint': 'card would be minted', 'would-skip': 'already carded, would skip',
  };
  const capLabel = (blocked) => {
    const counts = new Map();
    for (const b of blocked) {
      const l = CAP_CARD_LABEL[b.status] || (dryRun ? 'card would be minted' : 'card minted');
      counts.set(l, (counts.get(l) || 0) + 1);
    }
    return [...counts].map(([l, n]) => (blocked.length > 1 ? `${n} ${l}` : l)).join(', ');
  };
  const lifecycle = (a) => [a.graduated?.length ? `+${a.graduated.length} graduated` : '',
    a.ratified?.length ? `+${a.ratified.length} ratified` : '',
    a.capBlocked?.length ? `⛔ ${a.capBlocked.length} cap-blocked (${capLabel(a.capBlocked)})` : '',
    a.demoted?.length ? `-${a.demoted.length} demoted` : '',
    a.suppressed?.length ? `⌫ ${a.suppressed.length} suppressed (already covered in stack)` : '',
    a.retireProposals?.length ? `⚠ ${a.retireProposals.length} ratified retirement proposed` : '',
    a.drifted?.length ? `⚠ ${a.drifted.length} drift-flagged` : ''].filter(Boolean).join(', ');
  for (const a of audit) {
    const label = a.key || a.scope;   // operator routes show as "<scope>::operator"
    if (a.skipped) { const lc = lifecycle(a); console.log(`  · ${label}: skipped (${a.skipped})${lc ? ` [${lc}]` : ''}`); continue; }
    if (a.error) { console.log(`  ✗ ${label}: gate failed — ${a.error}`); continue; }
    const where = a.commit ? `[${a.commit}]` : (dryRun ? '[preview]' : '');
    const tags = [a.gated ? 'gated' : 'reused', lifecycle(a), a.dropped?.length ? `${a.dropped.length} over cap` : ''].filter(Boolean).join(', ');
    console.log(`  → ${label}: ${a.durable.length} durable / ${a.emerging.length} emerging (${tags}) ${where}  ${a.file}`);
    for (const s of a.suppressed || []) console.log(`      ⌫ suppressed: ${s.rule}  ← "${truncate(s.by, 80)}" (cos ${s.cos.toFixed(2)})`);
    for (const b of a.capBlocked || []) console.log(`      ⛔ cap-blocked (${b.door}): ${b.rule}  [[${b.source}]]`);
    for (const d of a.dropped || []) console.log(`      ✂ dropped over cap: ${d.rule}${d.source ? `  [[${d.source}]]` : ''}`);
    for (const r of a.durable) console.log(`      ★ ${r.rule}${r.source ? `  [[${r.source}]]` : ''}${r.ratified ? ' (ratified)' : ''}`);
    for (const r of a.emerging) console.log(`      · ${r.rule}${r.source ? `  [[${r.source}]]` : ''}`);
    if (dryRun && a.preview) console.log(a.preview.split('\n').map((l) => '      | ' + l).join('\n'));
  }
}

// Direct run for debugging / the detached refresh:  node projection.mjs [--dry-run]
// Takes the reconciler's single-writer lock (shared with reconcile.mjs and accept.mjs) so a
// direct/detached projection can never overlap a nightly reconcile: busy → exit 75 (the same
// contract accept.mjs speaks; its --refresh-projection wrapper retries on it). When called from
// reconcile.mjs via import, project() runs under reconcile's own lock and this foot never runs.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { loadPool } = await import('./nodes.mjs');
  const { tryAcquireLock, releaseLock } = await import('./locks.mjs');
  const dryRun = process.argv.includes('--dry-run');
  if (!(await tryAcquireLock())) {
    console.error('busy: another writer holds the reconciler lock, retry');
    process.exit(75);
  }
  try {
    const audit = await project(await loadPool(), { dryRun });
    printProjection(audit, dryRun);
  } finally {
    await releaseLock();
  }
}
