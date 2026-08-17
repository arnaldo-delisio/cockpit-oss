#!/usr/bin/env node
// recall.mjs — ambient-recall read-path CORE (DESIGN §8 mode 1; OPEN-9). Brain-neutral.
//
// The READ half of memory: query-time recall of the graph INTO a live session, automatically.
// Complement of capture (write) + projection (always-load behavioral fence). Behavioral nodes
// always-load via MEM-20; KNOWLEDGE/FACT nodes never project — this is their ONLY route back
// into a session. Given a user's prompt + scope context, returns a small, MARKED recall block
// of the few genuinely-relevant nodes, or null (silence beats noise — MEM-27/precision-bias).
//
// Each brain has a thin reader that turns its own per-turn event into a recall() call:
//   recall-hook.mjs   (Claude)  UserPromptSubmit hook -> additionalContext
//   (Hermes)          a pre-turn injection seam, if/when one exists (OPEN-9 / TOOL-6)
//
// LOCKED INVARIANTS (this file must never break):
//   • READ-ONLY graph        — NEVER writes a canonical node (single-writer = reconciler, MEM-8/9).
//   • decoupled from capture  — recall never captures/distills (no native write+recall coupling, TOOL-6).
//   • cache is read-only here — uses cached vecs, never embeds-and-saves (no write contention with
//                               the reconciler; the only state it writes is an ephemeral per-session
//                               recall cursor under staging/.recall/, the analogue of capture's
//                               .cursors/ — NOT the graph, and dot-prefixed so reconcile skips it).
//   • PRECISION over recall   — an absolute cosine FLOOR; below it we inject NOTHING (cosine is noisy
//                               on short text, MEM-27). Empirically calibrated: on the live pool,
//                               on-topic hits land 0.40-0.59, off-topic noise tops out ~0.21 — a clean
//                               empty band at 0.35.
//   • TWO SLATES, one pass    — behavioral and library are scored and slotted SEPARATELY (MEM-38
//                               step 4), so neither pool can starve the other unseen; eligibility
//                               stays on raw cosine, ranking is cosine × trust × relevance.
//   • TOKEN-disciplined       — titles + one-liners only (agent expands on demand via [[id]]); cap
//                               MAX_NODES; do NOT recreate native memory's per-session tax (TOOL-6).
//   • dedup the fence         — never re-inject a node already in the always-load projection (MEM-20);
//                               never re-inject within a session (a node surfaces once, then is quiet).
//   • cheap gate / inject rarely — evaluate cheaply EVERY turn (regex + ripgrep, no model load),
//                               pull (load embedder + cosine) only when the cheap gate trips.
//   • MARKED + KILLABLE       — visibly fenced (greppable `cockpit:recall`); COCKPIT_RECALL=off disables.
//
// Usage (testing):
//   node recall.mjs --scope <s> "the user prompt"        # one-shot: print the block (or "(silent)")
//   node recall.mjs --scope <s> --score "the prompt"     # show raw cosine scores (floor calibration)

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readFile as _r } from 'node:fs';

import { MEMORY_ROOT, NODES_DIR, loadPool, poolOf } from './nodes.mjs';
import { mappedScope, isScopeSlug } from './paths.mjs';
import { EmbeddingCache, syncCache, embed, cosineTopK, dot, contentHash, ripgrepSearch, CACHE_FILE, FLOOR, MAX_NODES } from './retrieval.mjs';
import { DOSSIERS_DIR, loadDossiers, dossierOneLiner } from './dossiers.mjs';
import { loadFenceIds, loadSidecar } from './relevance.mjs';

// --- tunables (the relevance gate; calibrated against the live pool 2026-06-25) ---
// FLOOR (the raw-cosine eligibility cutoff) and MAX_NODES (the injection budget) are the read path's
// two SHARED constants: relevance.mjs's calibration view has to rank against the same numbers, and
// one calibrated constant with two copies is a drift bug waiting for its first dial move (it already
// happened to MAX_NODES: 6 here, 4 there, for every shadow measurement taken since MEM-33). They
// live in retrieval.mjs — see the note there for why the import goes that direction — and are
// re-exported here so recall.mjs stays the documented face of the read path.
export { FLOOR, MAX_NODES };
// SURFACE_FLOOR (MEM-30 amendment, 2026-07-15): a materially higher bar than FLOOR — FLOOR decides
// what's worth injecting into the model's context at all; SURFACE_FLOOR decides which of those
// injected hits are worth rendering to the HUMAN as a visible footer. Kept separate on purpose: most
// context-worthy hits are still too marginal to interrupt the user about (same anti-ossification
// concern as always — surfacing something too readily reinforces it whether or not it's actually
// useful this turn).
const SURFACE_FLOOR = 0.45;
// EXPAND_FLOOR (AR-3 direction 2, 2026-07-19, amends MEM-30): the recall-tiering bar. Hits at or
// above it are confident enough to auto-expand the FULL node body into the injection (no more
// expand-on-demand round trip); hits between FLOOR and EXPAND_FLOOR stay one-liners with a
// read-if-load-bearing directive. Recalibrated against the observed hit distribution: all real
// hits score 0.35-0.55, so the old 0.6 was never reached and nothing ever auto-expanded
// (source: recall-hits.jsonl analysis 2026-07-21).
const EXPAND_FLOOR = 0.5;
// MEM-38 step 4: the budget is split PER POOL, and the split happens in the scoring, not after a
// single flat top-K — a flat fetch lets library hits starve the behavioral slate invisibly, and you
// cannot see the starvation because the behavioral candidates never reach the ranking at all.
// Soft slots: unused seats in either pool spill over to the other (an empty behavioral slate yields
// all 6 to the library). Behavioral rules mostly reach a session through the always-load projection
// block, so these 2 seats are a SUPPLEMENT: a view onto the unratified, emerging and niche
// behavioral memory that the fence filter (below) deliberately leaves out of the always-load layer.
const POOL_SLOTS = { library: 4, behavioral: 2 };
const MIN_TERMS = 3;         // <3 significant terms = a trivial ack ("ok", "go ahead") -> no pull. This is
                             // a COST gate (skip model load), NOT precision — the cosine FLOOR is precision,
                             // so keep it loose enough not to silence real short questions.
const ONELINER = 200;        // per-node one-liner truncation (chars)

// --- the ranking product (MEM-38 step 4): score = cosine × trust(provenance) × relevance(node).
// Eligibility and ranking are deliberately different questions. ELIGIBILITY (FLOOR, and the
// SURFACE_FLOOR/EXPAND_FLOOR tiers above) stays on RAW COSINE: all three numbers were calibrated
// against the observed raw-cosine hit distribution, and cosine is scale-stable, so they keep meaning
// the same thing. A floor on the product would silently redefine what is eligible every time a dial
// moves, and could never be recalibrated on a fresh graph. RANKING and slot selection use the full
// product. So a hit carries BOTH numbers, and logHits records both, because the next recalibration
// needs to read them side by side.

// Trust dials. Trust does a RANKING job here, not a safety job (the safety job is the pool split
// above): a genuinely on-point library node should still be able to beat a tangential authored one.
// Aggressive suppression (0.6/0.3) was explicitly rejected — it buries the library deliberately
// built. `provenance` arrives off a node file on disk, so the lookup has TWO holes to close, not one:
//   1. INHERITED KEYS. On a plain object literal `constructor`, `toString`, `valueOf`,
//      `hasOwnProperty` and `__proto__` all resolve TRUTHY off Object.prototype. That exact shape
//      (CHANNEL_TIER/TIER_RANK, MEM-38 step 3) turned a node's provenance into a FUNCTION and
//      aborted a nightly reconcile mid-write. Closed by the null prototype below.
//   2. KEY COERCION. A property read string-coerces its key, so a NON-STRING provenance can still
//      land on a rung: `['authored']`, `new String('authored')`, or any object whose toString()
//      returns a rung name would all read 1.0, the TOP of the ladder. `provenance: [authored]` in
//      YAML (a one-item list — a plausible hand-edit, or a distiller emitting an array) parses to
//      exactly that. A null prototype does nothing about this one. The ratified rule is "absent OR
//      off-ladder gets TRUST_DEFAULT", and a non-string is off-ladder BY SHAPE, so trustOf() rejects
//      on typeof before it ever indexes the map.
const TRUST = Object.assign(Object.create(null), { authored: 1.0, relayed: 0.8, inferred: 0.5 });
// Absent or off-ladder provenance gets 0.8, the same as `relayed`. bootstrap.mjs seeds its pool
// nodes (the identity stub, the demo seed) with schema_version 1 and NO provenance field, and the
// port starts on a fresh graph, so absence is the COMMON case on day one, not an edge case. 0.8 is
// the honest middle: absence is not evidence of authorship, so it must not get 1.0; it is not
// evidence of inference either, so burying it at 0.5 would penalize the whole day-one graph for a
// field that had simply not been written yet.
export const TRUST_DEFAULT = 0.8;
export function trustOf(provenance) {
  if (typeof provenance !== 'string') return TRUST_DEFAULT;   // off-ladder by shape (see hole 2 above)
  const t = TRUST[provenance];
  return typeof t === 'number' ? t : TRUST_DEFAULT;
}

// Relevance = the nightly sidecar (relevance.mjs): decay, importance and structure already folded
// into one number, so recall adds NO separate recency or importance term (that would double-count
// it). Read, never recomputed: computeRelevance() does a full pool load, link graph, projection-state
// parse and an all-scope cursor scan, uncached, which is not viable on a per-prompt hook. Defaults to
// 1 for a node with no entry AND for a totally absent sidecar (the cold start on a fresh graph), so
// an unwritten sidecar degrades to plain cosine × trust rather than to silence. hasOwnProperty-gated
// for the same untrusted-key reason as TRUST: node ids come off filenames.
export function relevanceOf(sidecar, id) {
  const nodes = sidecar && sidecar.nodes;
  if (!nodes || !Object.prototype.hasOwnProperty.call(nodes, id)) return 1;
  const r = nodes[id] && nodes[id].relevance;
  return typeof r === 'number' && Number.isFinite(r) ? r : 1;
}

// Score one already-retrieved candidate. Pure: no embeddings, no I/O — the retrieval that produces
// `cosine` is separated from the scoring on purpose, so the ranking and the slot allocation stay
// exercisable in a suite where the embedding model is disabled.
export function scoreCandidate({ id, cosine, node, sidecar }) {
  const trust = trustOf(node?.frontmatter?.provenance);
  const relevance = relevanceOf(sidecar, id);
  return { id, cosine, trust, relevance, score: cosine * trust * relevance, pool: poolOf(node) };
}

// Allocate the injection budget across the two pools. Pure. Input is the already-scored, already
// floor-passed, already session-deduped candidate set; output is the ranked selection.
//   1. per-pool ranking on the PRODUCT (id as the tie-break, so a tie is stable across runs)
//   2. each pool takes its base slots
//   3. spillover: whatever seats neither pool claimed go to the best remaining candidates of either
// NOT SCALE-INVARIANT, deliberately unfixed: the anti-starvation property holds at the live budget
// (maxNodes 6 = 4+2 exactly) and degrades below it. At maxNodes 3 the library takes min(4,3)=3 seats
// and behavioral takes 2, so 5 candidates compete for 3 seats and the final global re-sort can hand
// all three to a strong library slate — the behavioral guarantee silently vanishes. Unreachable
// today (the only live caller passes the default 6), so this is a note, not a fix. If the budget
// ever becomes configurable, the split has to be rethought as a proportional or floor-based
// allocation rather than two fixed counts that happen to sum to the budget.
export function allocateSlots(candidates, { maxNodes = MAX_NODES, slots = POOL_SLOTS } = {}) {
  const byScore = (a, b) => b.score - a.score || a.id.localeCompare(b.id);
  const pools = { library: [], behavioral: [] };
  for (const c of candidates) (c.pool === 'behavioral' ? pools.behavioral : pools.library).push(c);
  const picked = [], leftover = [];
  for (const name of ['library', 'behavioral']) {
    const list = pools[name].sort(byScore);
    const n = Math.max(0, Math.min(slots[name] || 0, maxNodes));
    picked.push(...list.slice(0, n));
    leftover.push(...list.slice(n));
  }
  picked.push(...leftover.sort(byScore).slice(0, Math.max(0, maxNodes - picked.length)));
  return picked.sort(byScore).slice(0, maxNodes);
}

// First-writer-wins id uniqueness over the visible union. Pure, and exported so the collision policy
// is pinned by a test rather than by the caller's argument order alone. See the call site in recall()
// for the policy (node wins, dossier dropped) and for the upstream root cause.
export function dedupeById(items) {
  const seen = new Set();
  return items.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

// The whole post-retrieval SELECTION, in ONE place and in order. Pure and embedding-free on purpose:
// everything after embed() is unreachable in the offline suite, so without this seam the ordering
// guarantee could only be pinned by assertions against this file's source text, which rot.
//
//   1. ELIGIBILITY  — raw cosine ≥ floor. Never the product: see the ranking-product note above.
//   2. SESSION DEDUP — a node surfaces once per session, then stays quiet.
//   3. SCORE        — cosine × trust × relevance.
//   4. ALLOCATE     — per-pool ranking, 4+2 slots, spillover.
//   5. ENRICH       — attach what rendering and logging need.
//
// Argument shape: the two RAW per-pool slates arrive separately because the two-slate split is the
// point of the design, and a caller that collapsed them would silently lose the anti-starvation
// property with nothing to fail. `already`, `sidecar` and `byId` are passed IN rather than read here
// so the function stays free of I/O and of a clock: the cursor, the sidecar and the pool are the
// caller's to load. Pool identity still comes from poolOf via scoreCandidate, so the slate partition
// and the allocation agree by construction rather than by a label that could drift.
//
// Step 2 is deliberately redundant with recall(), which already excludes injected ids from the
// candidate entries so they cannot consume a seat in the BOUNDED retrieval slate. Keeping the filter
// here too costs nothing, is idempotent, and means the guarantee holds for any caller instead of
// depending on every caller remembering it.
export function selectHits({ library = [], behavioral = [], already, sidecar, byId, floor = FLOOR, maxNodes = MAX_NODES, slots = POOL_SLOTS } = {}) {
  const injected = already || new Set();
  const lookup = byId || new Map();
  const candidates = [...library, ...behavioral]
    .filter((r) => r.score >= floor)                                   // 1. eligibility, raw cosine
    .filter((r) => !injected.has(r.id))                                // 2. session dedup
    .filter((r) => lookup.has(r.id))                                   //    unrenderable without its node
    .map((r) => scoreCandidate({ id: r.id, cosine: r.score, node: lookup.get(r.id), sidecar }));  // 3. score
  return allocateSlots(candidates, { maxNodes, slots })                // 4. allocate
    .map((c) => {                                                      // 5. enrich
      const n = lookup.get(c.id);
      return { ...c, title: n.frontmatter.title, prose: n.prose, isDossier: !!n.isDossier, claim: n.frontmatter.claim, citation: n.frontmatter.citation };
    });
}

// --- scope resolution: IDENTICAL gate to capture-core (DESIGN §9) so recall and capture agree on
//     "what is a real scope here": paths.mjs mappedScope(), deepest match first.
//     COCKPIT_SCOPE override -> mapped cwd -> else null (no recall). ---

// --- cheap term extraction (no model). ≥3-char letter/number tokens minus a tiny stoplist, so the
//     ripgrep entity-gate and the substantive-length gate don't fire on filler words. ---
const STOP = new Set(('the and for that this with you your are not but can how what why when who '
  + 'will would should could have has had been was were they them then than into out about over '
  + 'just like make made does did get got use using used now here there their our its also some '
  + 'any all one two too very much many more most lets let please thanks thank okay yeah yep nope '
  + 'need want know think going able else such only same each both via per').split(/\s+/));
function significantTerms(text) {
  return [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []))]
    .filter((t) => !STOP.has(t));
}

// --- the always-load fence to dedup against (MEM-20): every behavioral rule already projected into
//     a CLAUDE.md/SOUL.md managed region. Read from projection-state (the home of that lifecycle).
//     Behavioral nodes that did NOT graduate are absent here and may still recall — correct.
//     ONE implementation, in relevance.mjs (loadFenceIds): the copy that used to live here was kept
//     local so recall.mjs needed no edits, and that premise expired when step 4 wired the two
//     modules together. ---

// --- per-session recall cursor: the only thing recall writes. Tracks node ids already injected this
//     session so a node surfaces ONCE then stays quiet (this IS the novelty mechanism — when the
//     topic shifts, NEW nodes clear the floor; same-topic follow-ups find only deduped nodes -> silence).
//     Dot-dir under staging/ (reconcile skips dotfiles), analogous to capture's .cursors/. ---
function recallCursorFile(scope, sessionId) {
  const sid = String(sessionId || 'nosession').replace(/[^a-zA-Z0-9_-]/g, '');
  return resolve(MEMORY_ROOT, 'scopes', scope, 'staging', '.recall', `${sid}.json`);
}
function loadInjected(file) {
  try { return new Set(JSON.parse(readFileSync(file, 'utf8')).injectedIds || []); } catch { return new Set(); }
}
function saveInjected(file, set) {
  try {
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ injectedIds: [...set], updated: new Date().toISOString() }), 'utf8');
  } catch { /* bookkeeping only — never disrupt the session over it */ }
}

// --- recall hit-log (MEM-33 Phase-2 brick, shipped with MEM-37): append-only usage instrumentation.
// The ONLY honest utilization signal for the node-count/value-floor question (relevance shadow scores
// are non-discriminating on a young graph). Gitignored derived data under .cache/, best-effort — a
// logging failure must never disrupt a session. One JSONL line per injected hit.
// MEM-38 step 4: BOTH numbers are logged. `cosine` is what the three thresholds are calibrated
// against and what the next recalibration has to read; `score` is the product that actually decided
// the ranking, with its two factors beside it so a surprising selection is explainable after the
// fact rather than only reproducible.
// Exported so the cosine-versus-product gating can be asserted on BEHAVIOR rather than on this
// file's source text: both take plain hit objects, and source-text assertions rot (they pass while
// behavior diverges, and fail on a comment edit).
export function logHits(scope, sessionId, hits) {
  try {
    const file = resolve(MEMORY_ROOT, '.cache', 'recall-hits.jsonl');
    mkdirSync(resolve(file, '..'), { recursive: true });
    const ts = new Date().toISOString();
    const r3 = (x) => Number(x.toFixed(3));
    const lines = hits.map((h) => JSON.stringify({ ts, scope, session: String(sessionId || ''), id: h.id, pool: h.pool, cosine: r3(h.cosine), score: r3(h.score), trust: h.trust, relevance: h.relevance, expanded: h.cosine >= EXPAND_FLOOR })).join('\n') + '\n';
    appendFileSync(file, lines, 'utf8');
  } catch { /* instrumentation only */ }
}

// --- fence escaping (F6). INVARIANT: renderBlock is the ONLY thing that may emit a literal
// `<!-- cockpit:recall:begin|end` marker. Every node-derived string it interpolates goes through
// fenceSafe() first, so a node can never open or close the fence from inside it.
//
// The threat is not a rendering glitch, it is a TRUST RATCHET. read-pass.mjs's stripHarnessBlocks
// (read-pass.mjs:51) removes the injected block before the prompt is captured as human text, and its
// stripBetween slices from the first `begin` to the FIRST `end`. A node body carrying the close
// marker therefore truncates the strip, and everything after it survives capture as if the human had
// typed it — which is the channel that gets stamped `claude:typed` and derives `provenance: authored`,
// the top trust rung, on a fold that is monotone-up with no correction path. So a node could plant
// the marker that launders its own text into the highest tier, and a `claim: reported` node carries
// third-party source text by design. Both render branches were exploitable: the expand branch
// interpolates the full body, and the one-liner branch keeps a first sentence that can carry it.
//
// Escaping the comment OPENER covers both markers with one rule, since both begin with `<!--`. One
// backslash, the same house style read-pass.mjs uses for a forged `#### ` turn header: the text stays
// completely legible to the model, and only the marker-shaped `<!--` is touched, so an ordinary HTML
// comment in a node body renders untouched. It cannot be reversed downstream: the strip only DELETES
// ranges between literal markers, it never rewrites or unescapes text, and read-pass's only unescape
// is the line-leading `\####` case, which this does not produce.
//
// F7 widens the same invariant from the recall markers to EVERY harness tag family
// stripHarnessBlocks strips, because the marker was not the only forgeable scaffolding. A node body
// carrying a bare unclosed `<system-reminder>` was worse than a leak: stripBetween's unclosed-open
// branch (read-pass.mjs:41) slices to END OF TEXT, and system-reminder is stripped FIRST
// (read-pass.mjs:50), before the recall block itself is removed at :51 — so the injected tag deleted
// the human's own prompt along with everything else, silently emptying the captured turn. Nothing
// node-authored survived, so this was human-text DATA LOSS, not injection.
// Why all four families and not just system-reminder: system-reminder's unique exposure today is an
// artifact of the ORDER of stripHarnessBlocks's passes. The local-command-* / command-* families only
// look safe because their regex passes run AFTER the recall block is already gone, and a CLOSED
// forgery only looks safe because the forged range sits inside a block that gets removed anyway.
// Reorder those passes and the hole moves families in silence. One invariant, one chokepoint: only
// renderBlock may emit a literal harness marker or harness tag, so the escape covers what read-pass
// strips rather than what happens to be reachable this week.
// Deliberately NOT fixed on the consumer side: stripBetween's strip-to-end is correct there, since a
// genuinely truncated capture must not leak a dangling wrapper's contents into the corrections
// ledger. Relaxing it to drop only the tag would trade this data loss for real harness scaffolding
// entering the ledger, a worse trade.
// Boundary: the tag must be COMPLETE — a family name followed immediately by `>`, optional leading
// `/` for the closing form. That is exactly what read-pass matches (indexOf on the literal tag at
// :50, and `[a-z-]+>` in the regexes at :56-62), so tag-ish prose read-pass would never strip stays
// untouched: `system-reminder` bare, `<system-reminders>`, `<command-x y>`, `< system-reminder>`.
// A node discussing its own harness is expected here, and the escaped form keeps it readable.
const RE_RECALL_FENCE = /<!--(\s*cockpit:recall)/gi;
const RE_HARNESS_TAG = /<(\/?)(system-reminder|local-command-[a-z-]+|command-[a-z-]+)>/gi;
const fenceSafe = (s) => String(s ?? '')
  .replace(RE_RECALL_FENCE, '<\\!--$1')
  .replace(RE_HARNESS_TAG, '<\\$1$2>');

const oneLiner = (prose) => {
  const s = String(prose || '').replace(/\s+/g, ' ').trim();
  const sent = s.match(/^.*?[.!?](\s|$)/);
  const base = (sent ? sent[0] : s).trim();
  return base.length > ONELINER ? base.slice(0, ONELINER - 1) + '…' : base;
};

// Render the MARKED recall block (greppable fence; titles + one-liners + [[id]] pointers).
// AR-3 direction 2 (2026-07-19, amends MEM-30): recall is now tiered, not louder. Hits ≥ EXPAND_FLOOR
// auto-expand the full node body inline (high confidence: load-bearing enough to skip the expand-on-
// demand round trip). Hits between FLOOR and EXPAND_FLOOR stay one-liners, reframed as a read-this-
// file-if-load-bearing directive rather than full content. The block carries a rendering instruction
// asking for a short visible footer of the surfaced titles/ids (restored 2026-07-21; it was dropped
// in 63182c5 together with the Stop-hook enforcer — instruction only, no machine enforcement: the
// Stop-hook retry stays removed, it misfired on footers that were actually present).
// Exported alongside logHits, for the same testability reason.
export function renderBlock(scope, hits) {
  const lines = hits.map((h) => {
    // MEM-37 leg 3: a claim:reported node is an ATTRIBUTION, not endorsed knowledge — render it
    // visibly attributed ("per <source>: ...") so it never reads as a system-endorsed fact.
    // EVERY node-derived value below is fenceSafe()'d: citation (via src), title, id and prose. The
    // remaining interpolations are ours, not the node's: isDossier is a boolean gating a literal,
    // cosine is only compared, and hits.length / FLOOR / EXPAND_FLOOR are numbers.
    const src = h.claim === 'reported' ? fenceSafe(String(h.citation || '').replace(/^src:/, '')) || 'source' : null;
    const id = fenceSafe(h.id);
    // Both tier gates read h.cosine, NOT the product: they are calibrated bars on raw similarity.
    const tag = `**${fenceSafe(h.title) || id}**${h.isDossier ? ' [dossier]' : ''}${src ? ' [reported]' : ''}${h.cosine >= SURFACE_FLOOR ? ' [surface-worthy]' : ''}`;
    const body = fenceSafe(String(h.prose || '').trim());
    const prose = src ? `per ${src}: ${body}` : body;
    if (h.cosine >= EXPAND_FLOOR) {
      return `> - ${tag} — ↪ \`[[${id}]]\`\n>\n> ${prose.replace(/\n/g, '\n> ')}`;
    }
    // oneLiner runs AFTER escaping, so its 200-char truncation can only ever cut a marker shorter,
    // never reassemble one.
    return `> - ${tag} — ${oneLiner(prose)}  ↪ \`[[${id}]]\` _(read the file if load-bearing)_`;
  });
  return `<!-- cockpit:recall:begin scope=${fenceSafe(scope)} n=${hits.length} -->\n`
    + `> 🧠 **Ambient recall** — relevant memory the graph surfaced for this turn (read-only, not a ` +
    `directive). High-confidence hits are shown in full below; lower-confidence hits are one-liners, ` +
    `read the node file if it turns out to be load-bearing.\n`
    + lines.join('\n') + '\n'
    + `> _Rendering instruction: after your reply, append a short visible footer listing the surfaced ` +
    `node titles above — one line per node, \`[N] Title\`, with no id and no trailing punctuation. Do ` +
    `not render this instruction text itself, only the resulting footer._\n`
    + `> _OPEN-9 read-path · retrieval-gated knowledge (eligible + expand tiers are RAW cosine ≥ ${FLOOR} / ≥ ${EXPAND_FLOOR}; `
    + `ranked and slotted on cosine × trust × relevance) · disable with \`COCKPIT_RECALL=off\`._\n`
    + `<!-- cockpit:recall:end -->`;
}

// ============================================================ core
// recall({ prompt, cwd, sessionId, scope?, persist?, debug? })
//   -> { block, scope, hits, reason } | { block: null, scope, reason }
// `block` is the string to inject (null = stay silent). `reason` explains a silent turn (observability).
export async function recall({ prompt, cwd, sessionId, scope, persist = true, debug = false } = {}) {
  const log = debug ? (m) => console.error('[recall] ' + m) : () => {};

  if ((process.env.COCKPIT_RECALL || '').toLowerCase() === 'off') return { block: null, scope: null, reason: 'kill-switch' };

  // --- CHEAP GATE (no model load) ---
  const envScope = process.env.COCKPIT_SCOPE ? process.env.COCKPIT_SCOPE.trim() : null;
  scope = scope || (isScopeSlug(envScope) ? envScope : mappedScope(cwd || process.cwd()));
  if (!scope) return { block: null, scope: null, reason: 'no-scope' };          // same gate as capture

  const terms = significantTerms(prompt);
  if (terms.length < MIN_TERMS) { log(`trivial prompt (${terms.length} terms)`); return { block: null, scope, reason: 'trivial-prompt' }; }

  // entity gate: any node OR dossier lexically overlapping the prompt? ripgrep over both pools —
  // cheap, no model. Empty => no lexical signal => don't pay the embedder load. (Precision-biased:
  // pure-semantic-with-zero-keyword-overlap hits are rare and the riskiest for noise; we
  // intentionally require a foothold.)
  const [rgNodeHits, rgDossierHits] = await Promise.all([
    ripgrepSearch(terms.join(' '), NODES_DIR, 50),
    ripgrepSearch(terms.join(' '), DOSSIERS_DIR, 50),
  ]);
  if (!rgNodeHits.length && !rgDossierHits.length) { log('no lexical candidate (ripgrep empty)'); return { block: null, scope, reason: 'no-lexical-candidate' }; }

  // --- PULL (model load happens here, only past the cheap gate) ---
  const pool = await loadPool();
  // MEM-35: dossiers get the identical title+one-liner treatment as any node — full body stays
  // on-demand only (never injected here); dossiers are never superseded (third artifact class,
  // outside the append-only node record) so that filter is simply n/a for them.
  const dossiers = (await loadDossiers()).map((d) => ({
    id: d.id, isDossier: true,
    frontmatter: { superseded: false, scope: d.frontmatter.scope, title: d.frontmatter.title },
    prose: dossierOneLiner(d),
  }));
  // scope sees its own nodes/dossiers + global (knowledge is shared; DESIGN §4), minus superseded + fence dups.
  const fence = await loadFenceIds();
  const eligible = [...pool, ...dossiers].filter((n) =>
    !n.frontmatter.superseded
    && [scope, 'global'].includes(n.frontmatter.scope)
    && !fence.has(n.id));
  // ID UNIQUENESS, explicit and deterministic: NODE WINS, the colliding dossier is DROPPED. Nodes
  // are the canonical graph and every `[[id]]` pointer we render resolves to a node file, so a node
  // silently replaced by a dossier is the worse failure. Without this the collision produced TWO
  // candidates for one id: the shared embedding cache and byId both keep only the last writer
  // (always the dossier, appended second), so both candidates scored and rendered the SAME artifact
  // while eating two library seats.
  // ROOT CAUSE IS UPSTREAM, and this is only a read-path band-aid: node ids and dossier ids are
  // minted from the same slugify(title) against two INDEPENDENT taken-id sets that cannot see each
  // other (reconcile.mjs:1066 + nodes.mjs:97 for nodes; reconcile.mjs:1023 + dossiers.mjs:200 for
  // dossiers). The real fix is one shared taken-id set across the two minters; out of scope here.
  const visible = dedupeById(eligible);   // `pool` comes first in `eligible`, so the node is the keeper
  if (!visible.length) return { block: null, scope, reason: 'no-visible-nodes' };

  // TWO SLATES, one retrieval pass. Deliberately NOT two searchScored() calls: that helper embeds
  // the query on every call, so two calls pay two query embeddings, and each call's syncCache would
  // prune the OTHER pool's vectors straight back out of the shared in-memory cache. So: one
  // syncCache over the UNION, one embed of the query, two cosineTopK over the two vector slates.
  const cache = await new EmbeddingCache(CACHE_FILE).load();          // read-only: never .save() here
  await syncCache(visible.map((n) => ({ id: n.id, prose: n.prose })), cache);  // in-memory warm only
  const [qv] = await embed([prompt]);

  const byId = new Map(visible.map((n) => [n.id, n]));
  const cursorFile = recallCursorFile(scope, sessionId);
  const already = loadInjected(cursorFile);                            // BEFORE the slates, see below
  const sidecar = await loadSidecar();   // null on a fresh graph -> relevance 1 everywhere

  // The session cursor is applied HERE, before the bounded top-K, not after it. Each slate is
  // truncated to K, so filtering afterwards lets already-injected candidates CONSUME the slate: with
  // K library candidates all previously injected, the eligible (K+1)th is never considered at all and
  // recall under-fills or goes silent while fresh eligible nodes exist. An already-injected node must
  // not consume a seat, and the bounded fetch is where the seats are really spent.
  const entriesOf = (ns) => ns
    .filter((n) => !already.has(n.id))
    .map((n) => ({ id: n.id, vec: cache.get(n.id, contentHash(n.prose)) }))
    .filter((e) => e.vec);
  // FULL pool length, not a top-K. A `MAX_NODES * 3` cutoff here was a LEGACY of the design where
  // ranking WAS raw cosine, and top-18-by-cosine was a valid superset of top-6-by-cosine. The moment
  // ranking became cosine × trust × relevance that stopped being a safe optimization and became a
  // correctness bug: 18 high-cosine `inferred` or heavily-decayed nodes could crowd out a fresh
  // `authored` nineteenth that has the STRONGEST product, and it would never reach selectHits at all.
  // The floor and the product ranking now see every eligible candidate. Free, not a tradeoff:
  // cosineTopK already dots and sorts EVERY entry and only then slices, so k affects the slice, not
  // the work (measured: identical, see the build note). The ratified retrieval shape is untouched —
  // still ONE syncCache over the union, ONE embed of the query, and exactly TWO cosineTopK calls.
  const libEntries = entriesOf(visible.filter((n) => poolOf(n) === 'library'));
  const behEntries = entriesOf(visible.filter((n) => poolOf(n) === 'behavioral'));
  const library = cosineTopK(qv, libEntries, libEntries.length);
  const behavioral = cosineTopK(qv, behEntries, behEntries.length);

  // Observability only: the excluded set is scanned (no sort, no top-K) purely to keep 'all-deduped'
  // distinguishable from 'below-floor' now that deduped candidates never reach the slates.
  const dedupedEligible = visible.some((n) => {
    if (!already.has(n.id)) return false;
    const vec = cache.get(n.id, contentHash(n.prose));
    return !!vec && dot(qv, vec) >= FLOOR;
  });

  if (debug) for (const r of [...library, ...behavioral].sort((a, b) => b.score - a.score).slice(0, 6)) log(`  cos ${r.score.toFixed(3)} ${r.score >= FLOOR ? '✓' : '·'} ${r.id}`);

  // floor -> dedup -> score -> allocate -> enrich, all of it in selectHits (offline-testable).
  const hits = selectHits({ library, behavioral, already, sidecar, byId });
  if (!hits.length) return { block: null, scope, reason: dedupedEligible ? 'all-deduped' : 'below-floor' };

  if (persist) { for (const h of hits) already.add(h.id); saveInjected(cursorFile, already); logHits(scope, sessionId, hits); }
  return { block: renderBlock(scope, hits), scope, hits, reason: 'injected' };
}

// ============================================================ CLI (testing / floor calibration)
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let scope = null, showScore = false; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope') scope = argv[++i];
    else if (argv[i] === '--score') showScore = true;
    else rest.push(argv[i]);
  }
  const prompt = rest.join(' ');
  if (!prompt) { console.error('usage: node recall.mjs --scope <s> [--score] "<prompt>"'); process.exit(2); }
  // --score / debug never persists the cursor (so repeated calibration runs are reproducible).
  const res = await recall({ prompt, cwd: process.cwd(), sessionId: 'cli-test', scope, persist: !showScore, debug: true });
  console.log('\nscope=' + res.scope + '  reason=' + res.reason);
  console.log(res.block || '(silent — nothing cleared the floor)');
  if (showScore) {
    // Per-hit breakdown of the live product, then the relevance calibration view (raw vs weighted).
    // Since MEM-38 step 4 relevance is one of the live factors, so the shadow table is now a
    // calibration comparison, not a preview of an unwired feature.
    for (const h of res.hits || []) {
      console.log(`  ${h.pool.padEnd(10)} cos ${h.cosine.toFixed(3)} × trust ${h.trust.toFixed(2)} × rel ${h.relevance.toFixed(2)} = ${h.score.toFixed(3)}  ${h.id}`);
    }
    const { shadowScore, renderShadow } = await import('./relevance.mjs');
    console.log('\n' + renderShadow(await shadowScore({ prompt, scope: res.scope || scope, now: Date.now() })));
  }
}
