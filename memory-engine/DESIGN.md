# Cockpit Memory Layer — Canonical Design

**Status:** design closed + hardened (2026-06-19; refreshed 2026-06-21 for the AnythingLLM / ingestion-model decisions; 2026-06-22 for the CLAUDE.md-projection decision, MEM-20; 2026-06-22 blocking-spec lock — concrete build formats in §6a; 2026-06-22 walling layer retired — isolation moved to the VM boundary, MEM-23; 2026-06-22 retrieval engine = minimal in-process stack after real-machine smoke-test, MEM-24 supersedes MEM-15's AnythingLLM pick). **BUILT + LIVE** — all 5 phases 2026-06-24; nightly dreaming (MEM-29) 2026-06-24; ambient read-path recall (MEM-30) 2026-06-25; visionary association-linker v1 (MEM-31) 2026-06-26. The per-decision build trail lives in DECISIONS + `log/`.
**Source of decisions:** the decision IDs cited throughout (MEM-*, TOOL-*, BUILD-*, OPEN-*) are entries in a decision ledger. This doc is the integrated spec of *how the memory layer works*; the ledger holds the choice-by-choice trail plus rejected alternatives, and `log/` holds the chronology.
**Note for readers of the public export:** the author's own ledger and its deep dives are private working records and do not ship with the engine, so those IDs are shorthand for why a choice was made, not links you can follow. A fresh install starts its own ledger; `bootstrap.mjs` seeds the spine for each scope. To find out what a cited ID names, read `DECISIONS-INDEX.md` at the repo root, which lists every ID with its short title.
**Scope of this doc:** the memory layer only. Tools, skills, `~/CLAUDE.md` orchestration, and the Hermes↔Claude handoff / board-backed live-work queue are separate deep dives.

---

## 1. Purpose

One memory substrate that a **fleet of agents** — Hermes capability-agents (content, job-apps, …), the Claude Code builder, and their Sonnet/Haiku subagents — all read and write, **without drift.** Knowledge cross-pollinates freely; confidential client data is isolated at the VM boundary, not inside the graph (MEM-23).

---

## 2. Core principles (locked)

- **Graph, not tree.** Knowledge is a unified, cross-linked, self-improving graph (Karpathy "LLM OS"). Retrieved by search, not by folder path.
- **Own the substrate.** Store of record = distilled, wikilinked **markdown we own** + git. No third party holds the brain.
- **Buy retrieval, run it local.** A swappable local engine sits *on top of* the owned markdown — embeddings + retrieval 100% local, no third party in the retrieval path. The engine is a **minimal in-process stack** (MEM-24): `all-MiniLM-L6-v2` ONNX embeddings + brute-force cosine + ripgrep + RRF, `require`d by the reconciler — no server/daemon.
- **Isolation is structural, not in-graph.** Confidentiality is enforced at the VM boundary (one trust domain per VM, MEM-23), never by in-graph tags or prompt instruction. The main graph is one non-confidential trust domain.
- **One writer for truth.** Many agents observe; a single reconciler writes canonical nodes.
- **Distill, don't dump.** Resources are compressed to durable facts before they enter the brain.
- **Autonomy keeps the manual escape hatch.** Every automated pass (nightly dreaming, projection, capture) stays runnable and inspectable by hand; automation adds a schedule, it never removes the manual path.

---

## 3. The two axes

Memory is indexed on **two orthogonal axes**. Conflating them was the original modeling error.

**TYPE** (what kind of thing):
- **identity** — who is served, voice, mission. Small, loaded at invocation.
- **knowledge** — distilled facts + relationships. Large, self-growing, RAG-retrieved.
- **log** — chronological record of what happened. Append-only, never rewritten.

**SCOPE** (who it is about): `global · per-venture · per-client · personal`. Projects nest under a venture or client. (Since the VPS port, `global` is a conceptual cell and a reserved routing key only, not a registered data scope: builder-global doctrine lives in the authored constitution files `shells/CLAUDE.md` + `shells/doctrine.md`, and `memory/scopes.json` never lists `global`.)

Every cell of the grid exists:

|            | global            | per-venture        | per-client            | personal        |
|------------|-------------------|--------------------|-----------------------|-----------------|
| identity   | operator (soul.md)| venture voice      | (client identity)     | personal self   |
| knowledge  | general know-how  | venture know-how   | client know-how       | personal        |
| log        | cockpit diary     | venture diary      | client diary          | personal diary  |

- **SCOPE is organization, not a wall** (MEM-23) — it marks *who a node is about*. Confidential clients are isolated by VM, not by an in-graph "vault" cell.
- **Shared knowledge graph** = the union of all knowledge cells in the VM, cross-linked across scopes. This is what cross-pollinates.
- **`soul.md`** = the **operator meta-identity** (Arn / Hermes) at global scope. **Per-context identity lives inside each scope** — so "identity is per-context, never global" holds: the global file is the *operator's*, not any context's.

---

## 4. Storage & ownership

- **Store of record:** distilled wikilinked markdown files + **git** underneath (history, rollback, audit). Local-first, embedded — no cloud DB (no Turso) for the store of record.
- **Format stance:** Cockpit's native format is intentionally close to the emerging Open Knowledge Format (OKF) pattern — markdown + YAML frontmatter + links + git-friendly directories — but not constrained by it. OKF validates the "format, not service" choice; Cockpit keeps its own richer node semantics (`scope`, `audience`, `claim`, `centrality`, projection lifecycle, reconciler-owned fields) and may later add an OKF-compatible export/import mapping rather than rewrite the internal schema.
- **Git boundary (OSS-1, Option D 2026-06-23):** the *system* lives in the **engine (cockpit) repo** — `memory-engine/` (code: bootstrap, capture, reconciler) + `memory-engine/DESIGN.md` (this spec) + `skills/` + `shells/`. The *data* lives in `memory/` inside the same tree as its **own nested, standalone private git repo** (identity, logs, staging, sources, `knowledge/`) — the engine repo gitignores `memory/` (and the `scopes/` workspaces) wholesale, so the engine history is data-free, and the data repo is the reconciler's two-phase-commit target (§5). `bootstrap.mjs` (root entry, forwarding to `memory-engine/bootstrap.mjs`) recreates the data tree on a clone; every path resolves from the repo root via `paths.mjs`, so the clone can live anywhere.
- **Layout (MEM-13, retopologized by the VPS port):** knowledge graph = one flat pool `memory/knowledge/nodes/` (scope = node frontmatter, master-index over the pool); memory substrate = centralized `memory/scopes/<scope>/{identity,log,staging,sources}/`. `sources/` = raw capture layer (§8). Scope workspaces live at `<repo>/scopes/<scope>/`, each with a co-located `CLAUDE.md` loader pointing at its memory-side scope shell.
- **Graph structure** = wikilinks (`[[ ]]`, Obsidian-navigable) between markdown nodes.

### Node schema
`type · fact|inference · centrality · cluster · scope · provenance · volatility · ratified · schema_version`

- `fact|inference` — the CLAIM's epistemic status (the field is `claim`; do not read it as provenance, which is now its own field below). A `fact` node **requires a citation** (log-entry hash or URL) or is auto-downgraded to `inference`.
- `centrality` — "god-node" ranking; drives retrieval priority.
- `cluster` — community membership; shrinks retrieval search space.
- `scope` — organization (which venture/client a node is about); not a security boundary (MEM-23).
- `provenance` / `provenance_via` (MEM-38 step 3, schema v2) — WHO the node's words came from, derived from the capture-time channel stamped on the backing turns (step 2's third staging-header segment, carried into `turnIndex` as `via`). Ladder: `authored` > `relayed` > `inferred`. `claim: inference` wins outright and gives `inferred`; else the strongest channel across all backing turns (`claude:typed`, `hermes:cli`, `hermes:telegram` give `authored`; `subagent` gives `relayed`), with `provenance_via` recording the winning token; else source-backed gives `relayed` via `distill`; else `inferred` with no via. There is deliberately no `unknown` tier, and an unrecognised token fails closed to "no channel", because absence of a channel is meaningful (assistant turns, hook and system injections, task notifications, tool errors and Hermes `[tool] ` traces all legitimately carry none). Updates fold stronger-wins across the surviving node, the update's backing, and the absorbed dups, which is monotone-up on purpose (anti-sawtooth for the recall multiplier) and therefore irreversible. **CAVEAT, load-bearing: `authored` certifies the header, not the author.** Recall scoring is live (MEM-38 step 4, `recall.mjs`): ranking is the product cosine × trust(provenance) × relevance, with read-side hardening against key coercion (a non-string provenance value reads as off-ladder by shape, not by trusting `toString()`).
- `volatility` (MEM-38 step 3) — WRITE-ONLY, no consumer until a class has a verifier. `reference` for what does not go stale (behavioral-pool nodes and `src:` cited documents), `operational` otherwise.
- `ratified` (MEM-38 step 3) — written by NEITHER staging path; its absence is the graduation gate. Ratification is written by `ratify.mjs` at graduation (MEM-38 step 5); absence still marks ungraduated nodes.
- `schema_version` — for lazy migration as the schema evolves. Currently `2`; both staging paths stamp the current version, so a node claiming `1` predates step 3.

**Concrete file format → §6a.1** (this list is the conceptual schema; §6a.1 is the implementable YAML+prose template + the field-ownership split).

**Tagging / vocabulary (MEM-21).** Tags + entity labels (concepts/people/products) are **free-form at capture**; the reconciler **normalizes synonyms into an emergent canonical vocabulary** (no hand-authored fixed taxonomy). Semantic retrieval (§7) + emergent `cluster`s + wikilinks make a controlled vocab unnecessary — the reconciler maintains *coherence* (the real need) as part of its self-improvement pass (§10). Revisit only if retrieval underperforms.

---

## 5. Write model — staging + single reconciler

Concurrent writes to shared files corrupt and contradict. Solution: **nobody writes canonical nodes except one reconciler.**

1. **Agents append** observations to a **session-anchored staging inbox** — append-only, each agent owns its lane, so appends never collide. Format: Haiku summarizes each turn → bullets → date-partitioned files tagged with a session anchor (provenance) + scope.
2. **One reconciler** is the **sole writer** of canonical nodes and runs in two tempos: lightweight ingestion bookkeeping continuously at capture boundaries, and the heavy distillation / synthesis pass nightly. It reads staging/logs/sources → fact-checks → cross-links → rewrites → GC.
3. **Git underneath** for history/rollback. Git **plumbing** (add/commit/push) = **Haiku tier**; git **judgment** (rare by design) escalates.

This **unifies write-safety and self-improvement into one component** (the reconciler). A single-writer-for-memory is infrastructure, not an orchestration master: memory belongs to no agent, and the brains coordinate via a shared Kanban board (OM-13).

### Reconciler operational contract
- **Conflict precedence:** source-trust → recency → human-escalation queue.
- **Two-phase commit:** write canonical + git commit, **then** mark staging consumed (git hash = consumed marker). Crash recovery = re-run from last unconsumed entry.
- **Fencing:** acquire a lockfile before reading staging; a second instance exits. (Prevents dreaming + manual run racing.)
- **Instability guard (narrowed — MEM-28, supersedes MEM-9's human-review default):** a risky rewrite (citation-drop / centrality-delta / cluster-flip / supersede) is guarded ONLY on an **always-load-eligible** node (behavioral type, centrality ≥ projection floor); anything else applies (memory is git-versioned — git is the undo). For an always-load risky change the reconciler's **LLM adjudicates** apply-vs-escalate (default apply; infra failure fails safe → escalate), and only a genuine contradiction / evidence-loss / removal of a still-valid rule reaches `pending-review/`. The human is not the default reviewer; that queue is near-empty by design. Two advisory writers also land there without ever blocking a mint: ambiguous mint-time scope derivation, and the near-duplicate flag (§ consolidation pipeline).
- **soul.md** mutations route through the **same** staging→reconciler pipeline (no direct writes — a bad direct write would corrupt every future session).
- **Subagents write ONLY to staging.** "Haiku plumbing" = git ops on behalf of the reconciler, **not** arbitrary graph-write access.

### Consolidation pipeline (MEM-27)

How the reconciler turns staging into canonical nodes — **LLM-semantic consolidation ("reflection")**, replacing the original per-proposal cosine→merge mint path (cosine can't separate same-rule from different-rule for terse behavioral nodes; no `SIM_MERGE` cutoff works — MEM-27). Embeddings stay for retrieval + cache warmth (§7); they no longer gate the mint path. They do **act on** it (built 2026-08-15): after consolidation settles the pool and before the Phase-1 commit, every node minted this run is compared by cosine against the whole live pool **across scopes**, in two bands. **≥ 0.95 (`NEAR_DUPLICATE_MERGE_COSINE`) merges automatically** — operator decision, overriding the flag-only design this shipped with; **0.85–0.95 (`NEAR_DUPLICATE_COSINE`) is reported** to `pending-review/` plus the audit and left for the human. A mint is **never blocked or discarded** in either band: dropping real knowledge over a metadata problem is the worse failure (same rule as mint-time scope derivation). The merge is not a second merge path — it calls the consolidator's own `stageUpdate`, so the older node keeps its prose untouched, the mint's citation/tags/entities/audience/provenance fold in under the existing union rules, and the mint is **superseded, not deleted**, which is what makes acting automatically reversible (git is the undo). Survivor rule: the pre-existing node wins; when both sides are mints of the same run, the earlier in mint order wins. The merge pass runs first and re-ranks per mint, so a family collapses onto one survivor rather than chaining through superseded nodes, and a merged mint is never also flagged. The gap it closes is structural: consolidation is per-scope and per-run, so twins in two different scopes are never in the same consolidate call, and an old node is only re-examined when its own scope gets a `--reflect` pass. Measured basis: the 2026-08-15 cluster-structure audit found these embeddings surface redundancy reliably and topic not at all (15 pairs ≥ 0.75, whole-corpus p99 0.524, the 8 pairs ≥ 0.85 all true twins). **Both thresholds are uncalibrated** — they come from that corpus's own distribution. The 0.85 flag's error cost is inbox noise; the 0.95 merge's is a silent weld of two rules that only looked alike, which is exactly the failure MEM-27 measured, so the auto band was set at the point where the observed pairs are "same sentence, different wording" (0.982 identical titles, 0.967 one word apart) rather than at the flag line. **Calibrate against real reconcile candidates**, and treat the merge band's supporting sample — 8 pairs in a 211-node corpus — as thin evidence, not settled. A mint whose vector is unavailable is reported as *unchecked*, never as clean.

1. **Distill** (one `judge('hard')` per work-unit, MEM-18 altitude): near-raw staging digest → candidate nodes (title/prose/type/centrality/cluster/tags/entities + `source_turns`). INCLUDE evergreen knowledge / standing behavioral rules / identity; EXCLUDE build & session mechanics (phase status, handoff, "do X in a fresh chat" → log chronology, not graph). Many small, reliable calls; this is the **only** place prose is authored.
2. **Group** (`groupForConsolidation`, size-triggered): one judge call fits → one group = the whole scope (the case today, always). Scope overflows the input budget → split by the distiller's `cluster` label; a single label still overflowing = the **sub-cluster seam, DEFERRED** (needs real edge-data; would contradict MEM-24 — supersede it deliberately if/when filled). Whole-scope input is load-bearing: cross-label synonyms must meet in one call to fold.
3. **Consolidate** (one `judge('hard')` per group): handed the group's existing canonical nodes + the new candidates, returns the grouping decisions — `action: keep | update | new | supersede` (+ `backing:[candidate-idx]`, `supersedes:[ids]`, `centrality`, `cluster?`). Fold paraphrases into one node, merge new into existing where restated, keep genuine distinctions, flag contradictions as supersede; echo every existing id exactly once.
   - **Compact-decisions (MEM-27 amendment):** the consolidate reply is **decisions only — NO prose** (the full-prose set overflowed the model's single-reply ceiling on a large scope: ~30 nodes × prose in one array truncates mid-array → unparseable). The reconciler **assembles** each final node: a `new` folded node takes its highest-centrality backing candidate's prose/title/type (tie → lowest idx), tags/entities unioned across all backing; an `update` keeps the existing node's prose. Prose authored only by the distiller; the consolidator judges grouping only — bounding the reply to a few KB of ids/numbers. (Chunking the scope by cluster to shrink the call is **rejected** — it scatters label-synonym dups where they never fold. Incremental neighbor-compare is **deferred** to thousand-node scale, a drop-in like MEM-24's ANN swap.)
4. **Guard + commit:** every `update`/`supersede` passes the instability guard, **narrowed per MEM-28** — a risky change is held only when it hits an always-load-eligible node, and then the reconciler's LLM (not the human) adjudicates apply-vs-escalate; everything else applies (git is the undo). An existing node the consolidator never names is **kept unchanged** (conservative-keep). Provenance survives the merge: `citation` ← backing candidates' source-turns (`stg:<anchor>:<sha8>`, so fact-vs-inference holds), `audience` ← operator if any backing came from a Hermes work-unit (else builder), `centrality` ← the consolidator's cross-evidence number. Then two-phase commit (above) + INDEX regen + retrieval-cache sync + projection (below).

**`source: dreaming` anti-compounding (deferred — only bites once synthesis exists, MEM-31 v2).** v1 produces no dreaming *nodes* (link-only), so consolidation needs no special handling yet. If synthesis is built (v2): when consolidation is handed a node with `source: dreaming`, it must treat it as **lower-trust** — never fold a real captured node *into* a dreaming node, never let a dreaming node be the authoritative survivor of a merge. This must be **enforced in code**, not just by the prompt (adversarial catch #2): the consolidate prompt is handed each node's `source`, but a deterministic post-step rejects any update that would absorb a captured node into a dreaming one.

**Two tempos, one engine:** on-write (`node reconcile.mjs` — new staging consolidated against existing) and nightly (`--reflect` — consolidate a scope's existing nodes with NO new staging, self-healing accumulated drift/dups; matters more now that it rewrites existing nodes, so the guard gates it too). The visionary association-surfacing pass (§8 mode 2b / MEM-31, **v1 link-only**) runs as a distinct phase *after* this consolidation commits, before projection — **BUILT + LIVE (2026-06-26)**: `visionary.mjs` (`surfaceAssociations`) + `links.mjs` (the `knowledge/links.json` sidecar), folded into nightly `--reflect`. The nightly tempo is **LIVE** (MEM-29): a systemd USER timer (`cockpit-reconcile.{service,timer}`) runs `reconcile.mjs --reflect` at 04:00 local, installed clone-clean by `bootstrap.sh`/`dream.sh`; a per-scope skip-unchanged fingerprint (`state.reflect`) makes idle nights cost 0 judge calls. On-write stays manual. **Depth:** MEM-27 + MEM-29.

### Reconciler runtime (MEM-25)

The reconciler is a **standalone, brain-neutral Node process** — the single-writer of a substrate both brains share, owned by neither (a Hermes-owned reconciler would make one brain the owner of a substrate both share, against OM-13). It `require`s the retrieval engine in-process (§7, MEM-24). Triggered by a timer (nightly heavy pass) + on-demand (continuous light pass). Its model calls go through a single swappable **`judge(prompt, tier)`** adapter that shells out to **`hermes -z "<prompt>" -t ''`** (only-completion-text stdout; `-t ''` disables tools) from a **dedicated reconciler `HERMES_HOME`** (`~/.cache/cockpit-reconciler`, its own git root, used as `HERMES_HOME` + `cwd`) that holds a neutral SOUL, no memory, and no `hooks:` block — this is what keeps `judge()` brain-neutral (the `--ignore-rules` flag is a **no-op in the oneshot path**, so isolation can't rely on it; MEM-25 brain-neutrality amendment 2026-06-24). Rides in-plan Codex OAuth (no per-token billing, MR-1). **Tiered, both in-plan Codex (extends TOOL-3):** `tier:'hard'` (distill→node, conflict resolution, centrality) → **`gpt-5.5`**; `tier:'bulk'` (triage, classify, summarize) → **`gpt-5.4-mini`**. If the shared Codex 5h/week window throttles, offload the most trivial bulk to **local Gemma** (MR-1 tier 2 — free/off-meter/private), never OpenRouter/Gemini. **[2026-07-29]:** model ids superseded by TOOL-10 (hard → `gpt-5.6-terra`, bulk → `gpt-5.6-luna`, as built in `judge-hermes.mjs`); the tier structure stands. **Adapter router as built (2026-06-25):** `judge.mjs` dispatches by the `JUDGE_ADAPTER` env var — **default `judge-claude.mjs`** (Claude Code CLI, subscription: `hard→claude-opus-4-8` / `bulk→claude-sonnet-5`, brain-neutral via `--system-prompt` + a neutral cwd); `JUDGE_ADAPTER=hermes` selects `judge-hermes.mjs` (the Codex / `hermes -z` path described above), which the nightly `dream.sh` exports. So the Claude adapter is now the operational **default**, not a future swap. **Per-tier routing [2026-08-15, supersedes the sentence above]:** `judge.mjs` no longer picks one adapter for the whole process. It routes BY TIER: `hard` → `judge-hermes.mjs` (Codex), `bulk`/`mechanical` → `judge-claude.mjs`. Reason: the Claude adapter's `--system-prompt` neutrality flag suppresses hard-tier yield on thin material (the OSS-2 zero below), while the Hermes adapter owns a genuinely neutral identity slot and distills the same material reliably. `JUDGE_ADAPTER=hermes|claude` remains an explicit override that forces ONE adapter for every tier, so `dream.sh` is unchanged. A hard-tier call with Hermes missing or unauthenticated THROWS, naming the missing piece; it never falls back to the adapter that returns an empty array, since that is a silent zero wearing a success exit code. So Hermes plus a Codex login are now install prerequisites, not options. Model *family* is a measure-then-tune call, not a lock. (`hermes proxy`/Nous was rejected: it fronts only nous/xai, cannot reach Codex — see MEM-25 revision.)

### Projection to CLAUDE.md (MEM-20)

The reconciler is also the **sole writer of the "managed regions" of CLAUDE.md files** — the always-loaded layer is a *projection* of memory, not a separately hand-maintained doc. (Memory is *retrieval-gated*; CLAUDE.md is *always-loaded* via the cwd→`/` merge. Behavioral rules only bite when always-loaded, so the few that matter get promoted out of the retrieval-gated graph into the always-load layer.)

- **What promotes:** high-`centrality` behavioral nodes only — `type ∈ {identity, feedback}` (operating rules). Facts/`knowledge` stay retrieval-gated and never promote.
- **Gate + cap:** `when_to_use` + an adversarial structure/accuracy lens decides survivors; the BUILD-4 `## Rules` 10–15 cap keeps the always-load layer thin (BUILD-2).
- **Determinism + lifecycle (amendment 2026-06-23):** because the gate is a non-deterministic LLM call, the fence has two graduated layers — **Emerging** (the gate's volatile, *sticky* pick) and **Durable** (rules that survived the gate N=3 consecutive reconciles, then held by a counter + node-state and no longer re-judged; auto-demoted when the source node is superseded / falls below floor). The hand skeleton stays the human-only deterministic anchor; promotion is automatic (no human gate). Lifecycle state lives in `memory/.reconciler/projection-state.json`. **Full contract → §6a.4.**
- **Routing by (scope × audience) (mandatory):** a node promotes only into the canonical always-load file of *its own scope and audience*, reached via the loader trick. **Builder** routes (the default): cockpit → `<repo>/CLAUDE.md` (load-point already in-repo); data scopes (project/venture/client) → `memory/scopes/<x>/CLAUDE.md` in the PRIVATE memory repo, with the bootstrap-generated `<repo>/scopes/<x>/CLAUDE.md` loader importing it. The old builder-global route is retired with the `global` scope: builder-global doctrine is the authored constitution (`shells/CLAUDE.md` + `shells/doctrine.md`, hand-edited, imported by the `~/CLAUDE.md` loader), not a projection target; `targetFor()` keeps a legacy `global → shells/CLAUDE.md` branch, but no scope registers as `global` and capture never mints one, so it is unreachable on a fresh graph. **Operator** routes (audience minted from the `brain:` stamp, MEM-20 audience-axis amendment): `operator+global` (the reserved operator-shell routing key) → `shells/SOUL.md`; a write there triggers regeneration of `shells/SOUL.generated.md` (the SOUL.md + doctrine.md concat, `generateSoul()` called from `projection.mjs`), which Hermes loads via the `~/.hermes/SOUL.md` symlink. `operator+non-global` → **no route** (the node mints into the graph but does not always-load — GA2, scope-naive routing accepted for v1). System scopes project public (engine repo), data scopes private (memory repo); the reconciler commits only repos it owns — never a foreign project/client repo. Preserves BUILD-2/OM-6 (the root shell that loads in every session stays free of scope-specific rules; operator rules never inherit the builder skeleton, which doesn't load into Hermes sessions).
- **One home (DOC-1):** the graph node is the home; the CLAUDE.md block is a **generated, fenced projection** (`<!-- managed:reconciler -->`), never hand-edited. The hand-authored skeleton (BUILD-2) lives in a separate block of the same file. Edit the rule → edit the node → next reconciler run refreshes the projection.

This is the **self-evolving-CLAUDE.md mechanism** — one distiller (the reconciler), not a second external miner, so `headroom learn` is retired (TOOL-2). **Concrete fence contract → §6a.4.**

---

## 6. Trust boundary = the VM (MEM-23)

Confidentiality is enforced at the **VM boundary**, not inside the graph. One trust domain per VM: the main VM holds only non-confidential work in one fully-shared graph (no `substrate` tag, no `vault/` dirs, no per-scope read-keys or engine-workspace isolation). A confidential client gets a **separate VM running a clone of the same cockpit**, organized when it arrives (OPEN-7) — not designed now.

**The security model is data-flow discipline:** confidential data never leaves its VM — no shared graph, no shared semantic index, no shared git remote, no copy-paste back into the main cockpit. The VM is only as good as that discipline. The only forward-looking cost paid now is keeping the cockpit **clone-clean** (no hardcoded paths, secrets out of the tree, deps pinned) so the future VM is isolation-by-construction.

*Why this replaced intra-graph walling: an in-process tag is fragile (one missing filter = cross-tenant leak); a VM is a structural boundary, zero-leak by construction. The split-substrate machinery was load-bearing complexity for a confidential client who doesn't yet exist (YAGNI). Full trail: the superseded walling entries in the ledger.*

**Lighter tier — isolated local memory root (MEM-32).** The VM is reserved for third-party *custody* needing process/filesystem isolation. A confidential or co-owned venture **built locally** needs the same *data* guarantees (no commingling, no shared remote, no cross-scope pollination) but not machine isolation — so it runs as an **isolated local memory root**: its own `memory/` tree + own git, selected via the `COCKPIT_MEMORY_ROOT` env override (single-point seam — every module resolves from `paths.mjs`'s `MEMORY_ROOT`, so one override redirects capture / reconcile / recall / projection / links together). It is never in the main `scopes.json` and never pushed to the shared `cockpit-memory` remote; backup, if wanted, is its own single-tenant private remote (or local/encrypted). Cross-pollination is impossible by construction (the linker / recall only see the active root), not filter-dependent. **Depth:** MEM-32.

---

## 6a. Locked build formats (node · bootstrap · CLAUDE.md fence)

The concrete byte-level formats that realize **MEM-11 / MEM-13 / MEM-20** — the specs that had to be locked before paths can be laid (pre-crystallization checklist item 3). Conceptual decisions stay in §4/§5/§6; this section is the implementable contract. *(The substrate-tag spec was deleted with the walling layer — MEM-23.)*

### 6a.1 Node template (realizes MEM-11)

One markdown file per node in the flat pool `knowledge/nodes/<id>.md`. **Filename = `id` = wikilink target** (`[[<id>]]`) — same kebab-slug convention as the existing `MEMORY.md` index. YAML frontmatter + distilled-prose body:

```markdown
---
id: <kebab-slug>            # = filename; the wikilink target
title: <human title>
type: knowledge | identity | feedback   # feedback = behavioral lesson the reconciler mints from MEM-22 markers
claim: fact | inference     # `fact` REQUIRES `citation` else reconciler downgrades to inference (MEM-9)
scope: cockpit | <venture> | <client> | personal   # organization, not a wall (MEM-23); `global` is a reserved routing key, not a registered scope (§5 routing)
audience: builder | operator   # reconciler-owned; minted from capture brain-stamp (hermes→operator, else builder); only projection consumes it — routes operator+global → SOUL.md (MEM-20 audience-axis amendment)
centrality: 0.0-1.0         # reconciler-computed; drives retrieval priority + CLAUDE.md promotion
cluster: <emergent-label>   # reconciler-assigned community
tags: [free-form]           # emergent, reconciler-normalized (MEM-21)
entities:                   # free-form labels, reconciler-normalized
  concepts: [...]
  people: [...]
  products: [...]
citation: <stg:SESSION:SHA8 | url>  # required iff claim: fact (else reconciler downgrades to inference)
source: capture | dreaming | closure:<project-id>  # reconciler-owned provenance; default capture (legacy/missing reads as capture). `closure:<id>` (WORK-1, live 2026-07-04) = minted from a graduation residue work-unit (`graduation_of:` staging frontmatter, closure verb) — the Project id is the permanent provenance anchor; a merge into an existing node keeps its source (the derived citation carries the closure anchor instead). v1 mints NO `dreaming` nodes (link-only, MEM-31). `dreaming` is reserved for the DEFERRED net-new synthesis (v2): machine-legible lower-trust marker (anti-compounding, code-enforced), `type: knowledge` only, NEVER projection-eligible, always `claim: inference`. Add `source` to the node FIELD_ORDER (adversarial catch #10). (v1's other provenance use is the `source: ported` field on `links.json` EDGES, §6a.5 — not nodes.)
provenance: authored | relayed | inferred   # MEM-38 step 3: WHO said it, from the capture channel on the backing turns (see §Node schema)
provenance_via: <claude:typed | hermes:cli | hermes:telegram | subagent | distill>  # the winning channel token; OMITTED entirely when the tier is `inferred`
volatility: reference | operational        # MEM-38 step 3: write-only, no consumer yet
ratified: <ISO8601>                        # MEM-38 step 3: PRESENT only after an explicit human ratification (step 5); neither staging path writes it
schema_version: 2
created: <ISO8601>
updated: <ISO8601>          # reconciler
last_synced: <ISO8601>      # retrieval-engine cache freshness (§7)
---

<distilled prose — clean enough for the engine to embed (§13 RRF requires clean node prose).>

Links: [[other-node]], [[another-node]]
```

**Ownership split.** Capture/staging stamps **mechanically**: `scope`, `created`, the raw provenance (`session_anchor` + `transcript:` path), and the `brain:` stamp (per-file; sessions are single-brain). The reconciler (sole writer, §5) owns everything else — `centrality`, `cluster`, `tags`/`entities` normalization, `claim`, `citation`, `audience` (minted from the `brain:` stamp; default `builder`), `source` (default `capture`; set `dreaming` only by the visionary pass, §8 mode 2 / MEM-31), `updated`, `last_synced`. Agents never hand-set centrality/cluster/audience/source.

**Citation token [2026-06-23, build].** A claim distilled from a captured staging turn cites it as **`stg:<session_anchor>:<sha8(turn-text)>`** — a stable, verifiable coordinate into the raw transcript (the staging header carries the `transcript:` path; the sha8 pins the exact turn). The reconciler mints it from the backing turn the distiller names; a node with **no** backing turn (pure synthesis) carries no citation and is `inference` (MEM-9 downgrade). A real log-entry-hash scheme can supersede this once `logs/` is populated — the `claim` semantics ("is this backed by a captured moment?") are unchanged.

**`feedback` nodes.** Behavioral lessons (corrections, confirmed approaches) are minted by the reconciler from MEM-22 salience markers (`#good`/`#bad` sentinels + inferred correction/decision spans) — not hand-typed at capture. They are the projection input for MEM-20 alongside `identity` nodes.

### 6a.3 Bootstrap (realizes MEM-13; graduates the §13 cold-start items)

One **idempotent** operation lays the tree (safe to re-run; creates only what's missing):

```
<repo>/memory/                                        # nested private data repo, gitignored by the engine repo
├── knowledge/
│   ├── nodes/          # flat pool — all scopes; scope lives in frontmatter
│   └── INDEX.md        # master index, reconciler-generated (§7 tier: hot cache → INDEX → deep wiki)
├── scopes/
│   ├── cockpit/{identity,log,staging,sources,projects}/
│   └── <scope>/{identity,log,staging,sources,projects}/  # one per entry in memory/scopes.json
└── scopes.json                                       # private scope list (OSS-1) — REQUIRED before first bootstrap
```

- **Seed set = the live scopes** listed in `memory/scopes.json`. Registration is a deliberate act: there are NO default scopes; a missing or empty `scopes.json` makes bootstrap warn and exit, and an unregistered directory under `<repo>/scopes/` is warned about, never auto-adopted. For each registered scope, bootstrap also materializes the workspace at `<repo>/scopes/<scope>/` with its doc spine and `CLAUDE.md` loader pair. Dormant ventures/clients are materialized by the **same idempotent function** at re-onboarding (OPEN-7) — never blanket-seeded (clean-start, MEM-15). Private scope names never appear in the engine repo.
- **No `vault/` dirs** — intra-graph walling is retired (MEM-23); the whole VM is one trust domain.
- **`INDEX.md`** = reconciler-generated master index: high-`centrality` god-nodes grouped by `cluster`, one-line summary + `[[wikilink]]` each. Regenerated each run; never hand-edited.
- **Append-only bootstrap mode** until ≥1 centroid node per cluster exists — the reconciler runs capture+append only (no GC, no heavy rewrite) so it doesn't thrash a near-empty graph. Seed: a per-scope identity stub (the operator identity is the authored `shells/SOUL.md`, not a seeded node).
- **Demo scope** (`scopes/demo/`) — seeded by bootstrap alongside the live scopes; contains 2 fictional staging files and NO pre-baked node (OSS-2: a seeded node made the smoke test unfalsifiable and suppressed the distiller's yield, so every demo node is one the pipeline minted). Never in `scopes.json` → excluded from the nightly dreaming pass. Cloner verification path: `node reconcile.mjs --scope demo --require-yield` (exercises the full distill→consolidate→project pipeline without real data, and exits 1 rather than 0 if it produced nothing). The seeded material distills reliably under the Hermes/Codex adapter, and returned zero on every measured sample under the Claude/Opus adapter against an empty scope (OSS-2). **Cause isolated [2026-08-15]:** the Claude adapter's own brain-neutrality flag is what suppresses the yield. Same fixture, same prompt, same model, cwd held constant: `--system-prompt NEUTRAL_SOUL` (shipping) returned 8 empty of 8, `--append-system-prompt` 6 empty of 8, and no system-prompt flag at all 0 empty of 12. The effect is content-sensitive, so the neutral text raises the emission threshold rather than disabling distillation: a dense digest carrying four standing rules survived the shipping flag 8 of 8, while the thin demo digest collapses. **Resolved [2026-08-15]:** the hard tier now routes through the Hermes adapter by default (per-tier routing in `judge.mjs`, §5 above), so the smoke test needs no environment variable and the OSS-2 zero is closed. Verified on three genuinely fresh clones with no `JUDGE_ADAPTER` set: exit 0 and 2 nodes minted each time. The Claude adapter's own hard-tier suppression is NOT fixed and stays documented, it is simply no longer on the default distill path; forcing `JUDGE_ADAPTER=claude` still reproduces it. See `decisions/model-routing-and-cost.md`.

### 6a.4 CLAUDE.md projection fence (realizes MEM-20)

The reconciler's managed region inside any target `CLAUDE.md`. **Three layers, two of them inside the fence** (the determinism + lifecycle model, MEM-20 amendment 2026-06-23):

```
## <hand skeleton>            ← human-authored, OUTSIDE the fence; the reconciler never writes it
<!-- managed:reconciler:begin schema=2 inputs=<gateSig> -->
## Rules (projected from memory — do not edit; edit the source node)
### Durable (auto-graduated — survived N+ reconciles; held until superseded)
- <rule text> [[source-node]]
### Emerging (volatile — promotes to Durable after N consecutive reconciles)
- <rule text> [[source-node]]
<!-- managed:reconciler:end -->
```

- **Strict fence discipline.** The reconciler reads/replaces ONLY the bytes between `:begin` and `:end`; everything outside (the BUILD-2 hand-authored skeleton — the deterministic always-load anchor) is never touched. No fence present → append one at EOF after a blank line. Present → full-replace the interior (idempotent).
- **Why the lifecycle.** The gate is an LLM call → its membership flips on *borderline* nodes, and a pure `inputs=` damping would freeze whichever set it landed on. So inside the fence rules graduate: **Emerging** = the gate's volatile pick, made **sticky** (last run's set fed back: keep unless clearly wrong → hysteresis); a rule the gate keeps `GRADUATE_AFTER` (=3) consecutive reconciles **auto-graduates** to **Durable** and is thereafter held by a counter + node-state, not re-judged each run. Promotion = the gate's *repeated* judgment; a counter sets the timing — automatic, no human gate, no second LLM boundary.
- **Demotion** is deterministic, never an LLM guess: a Durable rule drops when its source node is superseded or falls below the centrality floor (it leaves the eligible-candidate set). Git is the undo.
- **Backlink per rule** (`[[source-node]]`) — the node is the home (DOC-1); the block is a regenerable cache. Durable rules join the gate's dedup context so a graduated rule is never re-proposed into Emerging.
- **State is the home of the lifecycle:** streaks · graduated set · last-emerging · gate-signature, per scope, in `memory/.reconciler/projection-state.json` (committed, sibling of `state.json`). The fence is a pure render of it, so the CLAUDE.md diff only moves when membership moves. Gate damping: the gate is re-run only when its inputs (gate-candidates + skeleton + last emerging) change; otherwise last run's set is reused and streaks still advance.
- **Cap** ≤ BUILD-4's 10–15 `## Rules` total (Durable + Emerging); Durable earns its place first, Emerging fills the remainder; over-cap → highest-`centrality` wins, the rest stay retrieval-gated; the audit diff (§10) records drops (no silent truncation).
- **Scope routing.** A node projects ONLY into its own scope's canonical always-load file: cockpit→`<repo>/CLAUDE.md` (engine repo, load-point in-repo); data scopes→`memory/scopes/<x>/CLAUDE.md` (PRIVATE memory repo, loaded by the bootstrap-generated `<repo>/scopes/<x>/CLAUDE.md` loader); operator+global→`shells/SOUL.md` (triggers the `SOUL.generated.md` concat regeneration). Builder-global is no longer a projection target: `shells/CLAUDE.md` + `shells/doctrine.md` are authored constitution files (see §5 routing). Foreign project/client repos stay pristine — the reconciler writes only the engine + memory repos it owns. [2026-06-23 build: loader-indirection + public/private split resolved; retopologized at the 2026-07 VPS port.]
- **What projects.** Only behavioral nodes (`type ∈ {identity, feedback}`) project; facts/`knowledge` stay retrieval-gated and never promote.
- **Reserved escalation:** quorum / best-of-N the gate, if a future multi-scope load makes the Emerging boundary flip again. Not built now (YAGNI).
- **Load-stack dedup + suppression (AR-3 direction 3, 2026-07-18).** Standing policy: **projected rules add, never restate.** Each route has an explicit load-stack map (`stackFilesFor`): the other always-loaded files that stack with the target in a live session (every non-global builder scope inherits `shells/CLAUDE.md`; operator routes inherit nothing, SOUL.md is its own root and never co-loads with the builder shell). The gate's dedup context is the FULL text of the inherited stack (hand skeleton AND managed fence: an ancestor's projected rules are inherited coverage too), plus the route's own hand skeleton and durable rules. A deterministic **embedding suppression backstop** (MiniLM cosine ≥ 0.6, empirically: near-verbatim restatements ≥ 0.75, non-duplicates ≤ 0.40, semantic paraphrases are not embedding-separable and are the LLM gate's job) runs every reconcile over both the gate's picks and the held durable rules (including durable-vs-durable within a route, higher centrality wins); a suppressed rule is dropped/demoted and a `suppressed_by` trail ({by, cosine, route, date}) is appended to its source node's frontmatter, so the node records why it is always-loaded nowhere despite qualifying. `audience: both` (AR-3 item 11) routes one node to both the builder and operator targets, replacing twin node families.

### 6a.5 Links sidecar (realizes MEM-31 cross-linking) — BUILT + LIVE 2026-06-26 (`links.mjs` / `visionary.mjs`)

The cross-link surface for the visionary pass (§8 mode 2b) — and in **v1 the pass's ONLY output**
(net-new synthesis nodes are deferred, MEM-31). Associations between nodes live in a
**reconciler-owned edge-list `knowledge/links.json`** — NOT in node bodies or frontmatter. The
choice is load-bearing and must be wired exactly as below.

**Why a sidecar, not frontmatter/body (the wiring rationale).** A link written into a real node
would bump that node's `updated`, which shifts the MEM-29/MEM-31 **non-dreaming fingerprint** and
re-fires the visionary pass every night (runaway minting). A sidecar leaves real nodes byte-stable
on a link-only change → **no fingerprint churn, no prose churn, no instability-guard interaction**,
and it is naturally bidirectional. (External precedent: mem0 `linked_memory_ids`, Generative
Agents `filling` — both store links as separate data, not in the memory's text.)

**Shape.** A JSON array of undirected association edges; endpoints are node ids:

```json
[
  { "a": "<node-id>", "b": "<node-id>", "source": "dreaming",
    "note": "<one-line rationale>", "created": "<ISO8601>" }
]
```

- `a`/`b` are existing `knowledge/nodes/<id>.md` ids (the wikilink targets). Undirected (associative);
  store the pair sorted so `(a,b)` is canonical and dedup is trivial.
- `source` marks edge origin: `dreaming` (visionary pass) | `ported` (migrated from a pre-existing
  in-body `[[ ]]` link, see migration below) | room for future `manual`/`distiller` links.
- `note` is the synthesis rationale the `judge` emitted (why these two relate) — human-auditable.

**Wiring (single-writer, MEM-8/9 — only the reconciler touches it):**
- **Candidate selection (adversarial catch #7):** because the graph has ~no existing links to
  traverse, association candidates are **semantically-proximate node pairs** (`searchScored()`
  neighborhoods), NOT graph neighbors. Bias toward under-linked high-centrality nodes + nodes
  recently changed; include a starvation breaker so a stable graph still gets explored once. (Exact
  anchor count / scoring = a build-prompt tunable.)
- **Append:** the visionary pass adds an edge only if (a) both endpoints exist and are not
  superseded, and (b) the canonical pair is not already present (so it never re-proposes an
  association already there — part of the §8/G2 saturation guard; the judge is also handed the
  neighborhood's existing edges as context).
- **Prune:** each run drops any edge whose endpoint id is missing or `superseded` — keeps the edge
  set consistent with the live pool (the one maintenance cost of the sidecar; runs in the pass that
  already iterates the pool).
- **Commit boundary (adversarial catch #5 — DONE 2026-06-26):** `links.json` lives under
  `knowledge/`, so it rides the **PHASE-1 canonical commit** (`gitCommit(..., ['knowledge/'])`, §5)
  — the same two-phase, lockfile-fenced write as the nodes. It is part of the canonical graph, not a
  derived cache (unlike the embedding cache, which is gitignored). **The PHASE-1 commit now fires
  when nodes OR `links.json` changed** — a link-only run persists; node writes + INDEX + links
  commit as one atomic `knowledge/` transaction (the accepted edge set is computed, every endpoint
  validated against the live pool, written, then `knowledge/` committed). On lock-acquire, refuse to reconcile over a **dirty canonical tree**
  (`git status --porcelain` on `knowledge/` → recover/abort first) so a crash mid-write can't leave
  a node without its link or a link without its endpoint.
- **Read path:** this is the real **L4–L5 relationship/wikilink-traversal layer** (§7) the graph
  has lacked — `INDEX.md` and ambient recall (MEM-30) may traverse it to surface neighbors, and it
  is the edge-data that finally unblocks the deferred degree-centrality / community recompute
  (§6a.3) — though building that topology stays deferred until link density is real.

**Net-new synthesis nodes are DEFERRED out of v1** (post-adversarial-review, MEM-31 amendment).
v1 writes only edges (above) — no autonomous *nodes*. If synthesis is ever built (v2), each
synthesis node is an ordinary `knowledge/nodes/<id>.md` stamped `source: dreaming` (§6a.1), `type:
knowledge` only, **never projection-eligible**, depth-capped (≥2 non-dreaming backing), recorded as
edges here to its evidence. Not in scope now.

**One-time migration — port existing in-body links into the sidecar (DONE — ran with the first `--reflect` 2026-06-26; idempotent on re-run).** Today links are scattered in node bodies as `[[ ]]` references, mostly distiller
decoration: of every distinct target across the 106-node pool, only 3 resolve to a real node id;
the rest point at documents/decisions (`[[STATE.md]]`, `[[MEM-25]]`, `[[BUILD-4]]`). Leaving them
in bodies would create a second, inconsistent link home (against DOC-1) once `links.json` exists,
so they are ported, not left alone:
1. Scan every node body for `[[target]]`.
2. **Resolves to a live node id** → add an undirected `{a,b,source:"ported",created}` edge (canonical
   sorted pair, deduped). **Strip ONLY the reconciler-owned `Links:` suffix line** (adversarial catch
   #6) — the exact `bodyWithLinks` pattern. **Inline `[[ ]]` inside the distilled prose are left as
   plain text / untouched** (the distiller owns prose, MEM-27; rewriting it changes the embed text +
   cache hash). Handle alias `[[id|label]]` and heading `[[id#h]]` forms; skip links inside code
   fences.
3. **Non-resolving** (doc/decision pointer, not a node) → **drop the suffix entry**, recorded in the
   migration audit diff (never silent). External-reference backlinks are out of scope (not node→node).
This is a bootstrap step, not the nightly pass — the bounded suffix-strip is acceptable for a
one-time port; the steady-state pass never rewrites bodies (the whole point of the sidecar). It sets
`updated` once (or a `schema_migrated` stamp) and the visionary fingerprint ignores that one
migration revision. Idempotent: a second run finds no `Links:` suffix left to port.

### 6a.6 Project object template (realizes WORK-1 B1)

One markdown file per Project in the flat pool `memory/scopes/<scope>/projects/<id>.md` (WORK-1 §4)
— **beside** the graph, never in it; single-lane witness-writer (human + in-session builder), never
the reconciler. Same YAML-frontmatter-plus-body shape as a node (§6a.1), a different contract:

```markdown
---
id: <kebab-slug>                 # = filename; root-unique forever (WORK-1 amendment) — the
                                  # permanent provenance anchor graduated nodes cite back to
scope: <scope>
state: active | closed | graduated | archived
outcome: shipped | abandoned | superseded | absorbed | retired   # present once state ≥ closed
kind: finite | practice          # finite = ends by completion; practice = ends by retirement
tags: [free-form]                 # emergent, MEM-21 posture — the grouping valve at scale, no hierarchy
supersedes: <project-id>          # optional — set only by `revive`
relates: [<project-id>, ...]       # optional — soft, incl. cross-scope
depends_on: [<project-id>, ...]    # optional — structural, rare (A cannot proceed until B ships)
declared: <YYYY-MM-DD>            # when `declare` ran — separate from `started` (retro-declaration honesty)
started: <YYYY-MM-DD>             # real historical start; may predate `declared` (born-closed case)
closed: <YYYY-MM-DD>              # set by `close`
graduated: <YYYY-MM-DD>           # set by `graduate`
archived: <YYYY-MM-DD>            # set by `archive`
last_understanding_change: <YYYY-MM-DD>   # the staleness measure the Board confesses (WORK-1 §6)
schema_version: 1
---

## Purpose / end-state

<why this exists; what "done" means — or, for a practice, what it keeps running.>

## Current understanding

<the present model: problem, approach, key constraints, what changed it last. Mutable in place —
this is the ONE section that keeps changing while `state: active`; it stops moving once closed.>

## Standing

<blocked-on / waiting-on facts — OMIT this section entirely when there's nothing to report;
it is content, not a lifecycle state (WORK-1 §3).>

## Boundaries

<what this undertaking is explicitly NOT — the anti-scope-creep line.>

## Open threads / next moves

<coarse, judgment-grain only — no done-ticks, no task checklist (the task-log wall, WORK-1 §4).>

## Relations

<prose rationale for the frontmatter `supersedes`/`relates`/`depends_on` ids — the same
terse-fact-plus-why split DECISIONS.md already uses; the frontmatter carries the queryable id, this
section carries why it's there.>

## Pointers

<workspaces, repos, key artifacts, key decisions (DECISIONS ids where relevant).>

## Graduation

<appended by `graduate`, never hand-written — judged depth, minted/updated node ids, citation, the
residue staging path (unchanged from the closure spike).>
```

**Ownership split (WORK-1 §4, hardened by Codex finding #1).** Everything in this file is written by
exactly one lane: the human + the in-session builder acting as the human's hand. `declare` mints the
file; the witness principle governs `Current understanding` / `Standing` / `Boundaries` / `Open
threads` edits thereafter (human explicit, or the in-session builder when a session contains the
decision/pivot itself — never per-session sync); `close`/`graduate`/`archive` flip the lifecycle
fields exactly as the closure spike already does. The reconciler reads this file (graduation input,
future Board freshness) and may *suggest* an update via the pending-review lane; it never writes it.

**`declare` (new).** Hand-authors (or the builder, on the human's behalf) a Project object at
`active`, `kind` chosen up front, `declared` = today, `started` = the real historical start (may be
earlier — the born-closed convention generalizes to declare-while-still-open: a Project can be
declared today for work that's been running for weeks). No `supersedes` unless it is also a revive.

**`revive` (new).** `declare` + auto-`supersedes` in one gesture: mints a new active object and sets
`supersedes: <old-id>` (validated: the old object must exist and be `closed` or later, never
`active`). `Current understanding` is authored the same way `declare`'s is — by the human/builder,
in the `--body` file — typically seeded from the old object's final state; the tool does not
auto-extract it (heading text is prose, not a parseable contract). Provenance stays immutable — the
old object is never reopened (WORK-1 §3's no-reopening rule).

**Retro-declaration = born-closed (WORK-1 amendment, unchanged).** A finished undertaking is
declared already `closed`, with real historical `started`/`closed` dates and a separate `declared`
stamp — no fabricated active period ever enters git. `memory-build.md` is the worked example.

### 6a.7 Decision-log + Board (realizes ATT-1's remaining two stores; WORK-1 Lane B brick #3)

**Decision-log** (`decisions.mjs`) is a peer store, not Project-object content (ATT-1's "five
stores" table) — a single append-only `memory/decision-log.jsonl`, one JSON object per line, keyed
by the (root-unique) Project id. Top-level beside `scopes.json`, outside `knowledge/` and outside
`.reconciler/` — it is truth-like (committed, not disposable), so it doesn't belong with the
regenerable sidecars, and it never trips `reconcile.mjs`'s `knowledgeTreeDirty()` guard (scoped to
`knowledge/` only). Verbs (v1 ships the **minimal 3**, not ATT-1's original 5 — `snoozed(until)` and
`deferred(until)` are the same idea twice, and `acknowledged` collapses into `dismiss`; add a 4th
only if real use exposes a gap):

- `defer <id> --until <YYYY-MM-DD>|--cond "<text>"` — suppress until a date, or (uncomputable,
  never auto-expires) until a human-declared condition.
- `dismiss <id>` — suppress until the project's understanding changes.
- `waiting <id> --on "<text>"` — not suppressed; renders in the Board's own `waiting` lens.

Each write validates the id resolves to an `active` Project (via `closure.mjs`'s exported
`findProjectPath`/`listAllProjects`), then read-all + write-tmp + atomic-rename appends one line —
same torn-write protection as `closure.mjs`, applied to an append instead of a full rewrite. A
changed mind is a new line, never an edit (DECISIONS.md's "supersede, keep the trail" discipline,
applied to attention).

**Board** (`board.mjs`) is read-time, ephemeral, uncommitted (`node board.mjs [--scope <s>]`) — it
reads Projects + the decision-log and writes neither (ATT-1's hard wall). Lenses are ATT-1's exact
list — `active · waiting · blocked · newly-surfaced · deferral-expired` — computed fresh every run,
never stored. For each `active` Project, the *latest* decision-log entry governs:

- **Anti-nag mechanism:** an entry is **stale** — and therefore ignored entirely, not just its
  suppression — if the Project's `last_understanding_change` is newer than the entry's `ts`. A
  dismissal covers "the state as of `ts`"; once the Project changes, the Board re-surfaces it
  without anyone touching the log. **Known, accepted granularity limit:** `last_understanding_change`
  is date-only while `ts` is a full timestamp, so a decision and an understanding-change landing on
  the *same calendar day* are indistinguishable — the Board keeps the decision live until the
  *next* calendar day's change. Confirmed by isolated testing; not fixable without loosening
  `last_understanding_change`'s locked date-only contract, so it's accepted, not patched around.
- Live `waiting` → `waiting` lens. Live `defer` → suppressed unless `--until` has passed (then
  `deferral-expired`; `--cond` never auto-expires). Live `dismiss` → suppressed. Otherwise: a
  non-empty `## Standing` body section → `blocked`; no decision-log entry ever → `newly-surfaced`;
  else → `active`.

No portfolio-priority signal is invented (D2 is still explicitly undesigned, ATT-1) — within a lens,
items sort by staleness only (oldest `last_understanding_change` first).

### 6a.8 Insights inbox (realizes ATT-1's sixth store; activity-pattern mining, undesigned as of
2026-07-06, fully designed 2026-07-07 — BUILT 2026-07-07; detector roster since redesigned — see
§6a.8e/§6a.8g for live capability, this section's v1 detector spec is history)

**Insights** (`mechanical-insights.mjs`) is a peer store beside Capture/Projects/Board/Decision-log/Closure —
it answers a question none of the other five do: *"what did an automated scan of raw activity
notice that a human hasn't judged yet?"* Its clock is the scanner's own (nightly + on-demand), not
understanding-change (Projects) or a deferral event (Decision-log). One markdown file per finding,
flat under `<MEMORY_ROOT>/insights/<date>-<slug>.md` — **active-root-relative, not hardcoded to the
main cockpit** (MEM-32: a confidential VM has its own isolated `MEMORY_ROOT`, so its own insights
inbox lives there, same as everything else under that root) — and not nested under `scopes/<scope>/`,
since v1's detector output is cross-scope by nature; a `scope: <scope>|global` frontmatter field
carries scope info without baking it into the directory (mirrors Board's own `--scope` filter
pattern), so a future scope-specific detector needs no migration. **Standing convention:** every
insight detector, current and future, writes card files exclusively through the shared safe writer
(`writeInsightFile` in `mechanical-insights.mjs`), which is atomic (tmp then rename) and dry-run
aware; ad-hoc `fs.writeFile` of insight cards is not allowed.

Frontmatter: `claim`, `evidence` (list), `suggested_fix`, `source: activity-scan:<detector>`,
`scope`, `status: new|applied|promoted|dismissed`, `detected: <ISO timestamp>`,
`resolved: <ISO timestamp>?` (full timestamps, not date-only — date-only can't disambiguate two
same-day events, e.g. a dismissal and a fresh occurrence landing the same calendar day). "Same
pattern" = same normalized command shape (the same key `fewer-permission-prompts` already buckets
on); the resurface counter always reads the *latest* terminal-state file for that pattern key, never
an older one.

**v1 detector — recurring command pattern.** Reads Claude Code JSONL transcripts only (reuses
`fewer-permission-prompts`' existing extraction — same source, no new parsing format; Hermes
`state.db` is a fast-follow, deferred because its `tool_name` column is coarse — `skill_view`-style
wrappers, not per-skill/per-command — and would need new parsing work). 30-day lookback, 3+
occurrences of the same command shape to flag (below 3, a single coincidence isn't a pattern; wider
than 30 days risks surfacing an already-abandoned habit). **Underused-skill and
duplicate-parallel-effort detectors are deferred to their own follow-up sessions** — v1 sequencing
picked the cheapest detector first (reuses proven code, zero new parsing, zero LLM cost) to prove
the store/promote/dismiss mechanism before paying for the costlier two (underused-skill needs new
tool-call-to-skill-name attribution across two transcript formats; duplicate-effort needs
LLM/embedding-based semantic comparison across sessions). Git-commit-history capture (not currently
captured anywhere) is out of scope for this detector and deferred until a future detector needs it.

**Dedup + resurfacing** (mirrors the decision-log/Board anti-nag pattern): a scan never re-mints a
finding that already has an open (`status: new`) entry for the same pattern. Once a finding reaches
a terminal state (`applied`/`promoted`/`dismissed`), a *new* finding for the same pattern is only
minted if occurrences **since** that state's timestamp independently cross the threshold again — old
findings are never resurrected, only superseded by a fresh one (DECISIONS.md's "supersede, keep the
trail"). **Noise cap:** at most 5 new findings minted per run, by occurrence count — a safety net for
the first backlog-catchup run (30 days scanned at once); steady-state nightly runs should rarely hit
it given the dedup rule. No silent drop — a capped-out run logs how many crossed the threshold vs how
many were minted.

**Two action verbs, not one** — most command-pattern findings aren't Project-shaped (WORK-1's
mortality test, "can it end," fails for a one-line alias suggestion): `apply <id>` marks a finding
resolved (no Project created); `promote <id>` seeds `closure.mjs declare` for findings that
genuinely warrant a Project — **still human+builder only**, respecting `ontology-of-work.md`'s lock
that an automated process may never write a Project object directly. `dismiss <id>` reuses the
decision-log's verb name for consistency. CLI: `mechanical-insights.mjs scan|list|apply|promote|dismiss`.

**v1 build amendment (superseding this section's original
"performs the small fix directly" for `apply`):** v1's `apply` marks the finding
`applied`/`resolved` and **prints** `suggested_fix` for the human to act on by hand — it never
writes `.claude/settings.json` (or any other config) itself. Two reasons: the owner runs Claude Code
permissionless, so auto-writing a permission allow-rule has near-zero payoff for that
workflow; and it keeps this store's blast radius to its own files (`insights/`), matching the
narrow-scope spirit of the rest of this section (`apply` "must never write `memory/scopes/*/
projects/*.md`") rather than opening a new write surface into shared config for a v1 build.
Likewise, `promote <id>` marks the finding `promoted`/`resolved` and **prints** the
`closure.mjs declare` invocation to run — it never invokes `declare` itself, since `declare`
requires real authored prose (`--body`) that a deterministic finding template cannot supply
without a human. If a future detector's fix is safe, narrow, and worth automating, revisit `apply`
then — this is a v1 scoping choice, not a permanent one.

**Hard rule (Codex-flagged, folded 2026-07-07):** the nightly/`scan` path only ever mints findings —
it never invokes `apply`/`promote`/`dismiss`; those three are exclusively human-invoked CLI commands,
run interactively. `apply` is scoped to the finding's own `suggested_fix` (e.g. an allowlist/alias/
config entry) and must never write `memory/scopes/*/projects/*.md` or call `closure.mjs declare` —
that path belongs to `promote` alone.

Claim/evidence/suggested-fix text: a deterministic template, with a light Haiku-tier LLM phrasing
pass over it — mechanical rote-transform tier per the model-routing policy, not Sonnet/Opus,
regardless of subscription billing (routing is about task shape, not marginal cost).

**Board integration:** a one-line footer only — "N open insights → `node mechanical-insights.mjs list`" — a
plain count, read as a **separate path outside `board.mjs`'s lens computation**, which itself stays
byte-unchanged (still reads only Projects + the decision-log for its 5 lenses). Folding insights into
a lens would violate ATT-1's own "one object, one question" rule — Board's question is "what does my
Projects-understanding need," not "what did a scanner notice"; merging them recreates the
task-log-creep failure mode the ontology names by name.

**Confidential wall (corrected 2026-07-07 — the original "no new guard code" claim was wrong, Codex
blocker):** `mechanical-insights.mjs` reads **raw provider transcripts** (`~/.claude/projects/**/*.jsonl`), which
is a different surface than `reconcile.mjs` (reads only `staging/` under `MEMORY_ROOT`, never raw
transcripts directly) — so MEM-32's engine-level root isolation does not automatically cover it. The
actual precedent for reading raw transcripts is `history-search` (TOOL-8), which needed its own
explicit **scope-allowlist gate** mirroring `scopes.json` — confidential ventures hard-skip, no
override, no confidential scope opts in by exception. `mechanical-insights.mjs` must reuse that same gate (or
its underlying scope-classification code directly) before reading any transcript path, not assume
isolation is automatic from running inside a given root.

**Deferred, not built:** Hermes `state.db` as a second data source; git-commit-history capture.
Underused-skill, duplicate-parallel-effort, and new-skill-candidate are specified in §6a.8b below
and built in the same session (2026-07-07 follow-on).

---

### 6a.8b Insights inbox — underused-skill, duplicate-parallel-effort, new-skill-candidate detectors
(designed + built 2026-07-07, follow-on to §6a.8's
v1 command-pattern detector)

Three more detectors joining `command-pattern` inside the same `scan()` entrypoint, same store
(`insights/`), same lifecycle (`new → applied|promoted|dismissed`), same CLI (`apply`/`promote`/
`dismiss` are generic over any finding regardless of which detector minted it — no detector-specific
verbs). All four detectors share one JSONL walk of the transcript tree per `scan()` run — no second
pass over the same files.

**Noise cap amendment:** §6a.8's "at most 5 new findings minted per run" is, on reflection, a
**per-detector** budget, not a single global one — four detectors now share the store, and a single
noisy detector (e.g. a first-run command-pattern backlog) must not starve the others' budgets. Each
detector below has its own 5-finding cap. The Board footer is unaffected (still a plain sum of all
`status: new` findings, across detectors).

**Shared infra #1 — skill enumeration (`enumerateSkills()`).** Reads `<COCKPIT_DIR>/skills/*/SKILL.md`
(`COCKPIT_DIR` already exported by `scope-gate.mjs` — reused, not rederived) — every directory
containing a `SKILL.md`, i.e. `skills/lib` and `skills/references` are naturally excluded (no
`SKILL.md` of their own). Parses the existing YAML frontmatter (`name`, `description`) by reusing
`nodes.mjs`'s `parseNode()` (already imported for insight-file I/O) rather than importing a raw YAML
loader — `mechanical-insights.mjs` only ever imported `js-yaml`'s `dump`, not `load`, so routing through the
existing frontmatter parser avoids adding a second parsing path (Codex design review 2026-07-07
caught the original draft's inaccurate "already-imported js-yaml" claim). **Deliberately scoped to
this repo's own `skills/` tree, not plugin-
provided skills** (`codex:*`, `telegram:*`, `context-mode:*`, …, which live in separate plugin
packages this repo doesn't own) — a v1 scoping choice mirroring §6a.8's own "documented judgment
call" precedent: a plugin skill isn't something the owner authored or can retire/promote via this
store, so it isn't actionable insights-inbox material the way a cockpit-authored skill is. Each
skill's **age** = its `SKILL.md`'s first commit date (`git -C COCKPIT_DIR log --follow --format=%aI
-- skills/<name>/SKILL.md`, last line = oldest); a skill younger than the scan's `--days` window is
excluded from underused-skill consideration (hasn't had a fair chance to be used yet). The same git
call also yields the newest commit date (`lastChangedDays`); a skill changed within that same
age-floor window is likewise excluded (a just-reworked skill is not underused), and surviving
candidates rank least-recently-changed-first before the judge cap (full mechanics in §6a.8g's
detector git-signal extension paragraph). 11 skills
today — the git shell-outs are O(skills), cheap; revisit only if this ever needs to scale to
hundreds.

**Shared infra #2 — skill-invocation + session-opener extraction.** `command-pattern`'s existing
one-pass JSONL walk (`extractOccurrences`) is extended, not duplicated: it already visits every
`tool_use` block per assistant turn, so it now additionally captures blocks named `Skill`
(`block.input.skill`) as a third occurrence `kind` alongside `bash`/`mcp`, same scope-gating, same
timestamp bound. Session-opener extraction (duplicate-parallel-effort only) walks the same files for
the first `role: 'user'` turn with real text (≥ 40 chars, filters out one-word continuations like
"yes"/"continue" that would otherwise look spuriously similar under embedding) per session, scope-
gated identically (walled/unmapped hard-skip, no override — same as §6a.8's rule, an automated
scanner has no user text to check a `#capture` opt-in against).

---

**Detector: `underused-skill`.** A skill exists (per `enumerateSkills()`, ≥ `--days` old) with **zero**
`Skill` tool-use invocations of that name in the `--days` window. Cross-scope, `scope: global` in the
frontmatter (skill usage isn't tied to one repo the way a Bash command is). Pattern key:
`underused-skill::<name>`. **Resurfacing deviates from `command-pattern`'s crossing-based rule** —
zero activity has no "threshold" to cross again. A flat time-cooldown was the original draft here and
was rejected by the design-time Codex review (2026-07-07, major): it nags forever, re-crossing any
fixed cooldown with no new evidence and overriding the human's own dismiss decision every cycle.
**Corrected rule: once a skill reaches a terminal state (`applied`/`promoted`/`dismissed`), it is
never automatically re-minted again** — permanent silence, the same philosophy as
`duplicate-parallel-effort`'s "once minted, never remint" rule below, just keyed on resolution
instead of on first-mint; there is no automated un-dismiss path anywhere in this store. Claim
template: "You haven't invoked the `<name>` skill in the last `<days>` days
(added `<age>` days ago) — description: `<one-line description>`." Suggested fix: "Consider whether
`<name>` still matches how you work — a retrigger phrase, a CLAUDE.md pointer, or (if it's no longer
relevant) retiring it." Deterministic template + the same Haiku-tier (`mechanical`) phrasing pass as
`command-pattern`, same cosmetic-only fail-safe (falls back to the template on any judge failure,
never blocks minting). No judge call needed for detection itself — this is fully deterministic like
`command-pattern`.

**Detector: `new-skill-candidate`.** Reuses `command-pattern`'s **raw** occurrence groups (shape ->
occurrences, before either detector's dedup/threshold-filtering) as shared input — this is the
"shares infrastructure" the roadmap flagged, concretely: one JSONL-walk-and-group-by-shape pass feeds
two different questions. It then computes its **own independently-deduped** candidate list under the
`new-skill-candidate::` pattern-key namespace (below) — **not** `command-pattern`'s post-dedup list —
so the two detectors' open/resolved lifecycles stay fully decoupled: an open `command-pattern` finding
for a shape must never block `new-skill-candidate` from considering that same shape, or vice versa.
Capped to the top 15 candidates by occurrence
count before spending any judge call (`NEW_SKILL_JUDGE_CAP`, same backlog-safety-net spirit as
§6a.8's `NOISE_CAP`, bounding worst-case cost on a first catch-up run). Per candidate, one `bulk`-tier
`judge()` call (Sonnet-tier — this is a real classification, not the cosmetic Haiku phrasing pass;
model-routing policy: "bulk" = triage/classify/summarize) given the command shape, up to 3 evidence
lines, and the skill name+description list from `enumerateSkills()`, asking for structured JSON
`{coveredBySkill: string|null, skillWorthy: boolean, rationale: string}`. **Skip (mint nothing) if**
`coveredBySkill` is non-null (that's `underused-skill`'s territory — the skill already exists and
will be flagged there independently if it's going unused) **or** `skillWorthy` is false. **A judge
failure skips that candidate silently** — unlike the cosmetic phrasing pass, this is a real yes/no
gate, so a failure must not default to minting a false positive; it is not a "no silent drop" noise-
cap case (the candidate never crossed a confirmed threshold, there's nothing to report as dropped).
Pattern key: `new-skill-candidate::<same key as command-pattern's group>` — a distinct namespace
prefix, so a `command-pattern` finding and a `new-skill-candidate` finding can coexist for the same
underlying shape without colliding on dedup (they answer different questions: "annoying enough to
allowlist" vs "recurring enough to deserve a skill"). Own 5-finding noise cap, ranked by occurrence
count among judge-confirmed candidates. Claim template: "You've manually repeated `<shape>` (<kind>)
`<n>` times in `<days>` days and no existing skill covers it — `<judge rationale>`." Suggested fix:
"Consider authoring a skill for this (see an existing `skills/*/SKILL.md` for the format)."

**Detector: `duplicate-parallel-effort`.** Embeds every qualifying session-opener in the window
(shared infra #2) via `retrieval.mjs`'s existing `embed()` — no new dependency, no new cache sidecar
(a scan's session count in a 30-day window is small enough to re-embed fresh each run; MEM-24's own
"brute force stays fast" precedent covers the all-pairs cosine, done in-memory via the existing
`cosineTopK`-style dot product, no ANN needed). Pairs scoring above **τ = 0.72** (an initial guess,
not yet calibrated against real session data — documented honestly per the "documented judgment call"
precedent; calibrate during smoke-testing and adjust if it proves too loose/tight in practice) are
ranked desc and capped to the top 10 (`DUP_JUDGE_CAP`) before any judge call. Per surviving pair, one
`bulk`-tier `judge()` call given both openers (truncated) asks for structured JSON
`{duplicate: boolean, rationale: string}` — "do these describe genuinely overlapping/duplicate work,
not just a shared topic area?" (cosine alone over-fires on shared vocabulary, e.g. two unrelated "fix
the bug in X" sessions — the judge call is the actual precision filter DESIGN §6a.8 originally flagged
this detector as needing). **A judge failure skips that pair silently**, same fail-safe stance as
`new-skill-candidate` and for the same reason (a real gate, not cosmetic phrasing). **"Parallel" here
means temporally close within the same lookback window, not strictly concurrent** — an accepted v1
simplification; true concurrency detection would need wall-clock session overlap, deferred until a
false-negative in practice justifies it. **Session identity** (for both the pair key and the opener
extraction itself) **= the JSONL record's `sessionId` field, falling back to the file's basename**
when absent — the same fallback convention `history-search.mjs` already uses for its own per-event
`session` column, reused rather than reinvented. Pattern key: `duplicate-parallel-effort::<sessionId
A>::<sessionId B>` (sorted so the key is order-independent). **Dedup deviates from both other
detectors' resurfacing rules** — a specific pair of already-completed sessions is an immutable
historical fact, so once a pair has ever been minted (any status, including `new`, not just
terminal), it is never re-minted, full stop; there is no "fresh occurrence since resolved" concept for
two sessions that already happened. Own 5-finding noise cap. Claim template: "Session `<A>` (`<scope
A>`, `<date A>`) and session `<B>` (`<scope B>`, `<date B>`) both appear to have independently
pursued: '`<snippet A>`' vs '`<snippet B>`'." Evidence: both file:session references + both openers
(truncated). Suggested fix: "Check session-handoff notes or the Board before starting overlapping
work next time; consider whether one session's output supersedes the other."

**Confidential wall:** all three reuse the exact same `cwdScope`/`liveScopes` gate §6a.8 already
wired in — no new guard code, same hard-skip-on-walled-or-unmapped rule, same no-override stance
(an automated scanner has no user text to check a `#capture` opt-in against). **Ordering (clarified
2026-07-07, Codex design review):** the one-pass parse must read the whole file to even find the
`cwd` field (it can appear anywhere in the JSONL stream, same as v1), so occurrences and the session
opener ARE extracted into local variables before the gate check runs — same order v1's own
`extractOccurrences` already used and which the original §6a.8 Codex review already accepted. The
invariant that actually matters: **nothing extracted from a walled/unmapped file is ever returned to
the caller** — `analyzeTranscript()` discards both `occ` and `opener` and returns empty/null the
moment the gate fails, so a walled session's text is never embedded, never sent to `judge()`, never
logged, and never reaches a written finding. The gate is a return-value filter, not a
skip-the-read filter (reading is unavoidable to classify the file at all); no caller ever sees
pre-gate data.

**Cost shape (corrected 2026-07-07 — the original draft overstated this, Codex design review
major):** `underused-skill` is fully deterministic (no judge calls beyond the shared cosmetic
phrasing pass). `new-skill-candidate` and `duplicate-parallel-effort` bound their **judge-call**
volume with a pre-judge cap (15 and 10 respectively) regardless of how much raw activity a lookback
window contains — that part of the cost, the one that hits an external model and a possible
rate-limited nightly adapter, is genuinely bounded. **What is NOT bounded:** `duplicate-parallel-
effort`'s embedding pass (`embed()` over every qualifying session opener) and its all-pairs cosine
comparison both scale with session count in the window — linearly and quadratically respectively.
This is accepted, not a gap to fix now: MEM-24's own precedent is that brute-force cosine "stays
fast below fifty thousand vectors," and a 30-day window realistically holds, at most, low hundreds of
sessions — embedding a few hundred short (500-char-truncated) openers and doing the resulting
in-memory dot products is sub-second work, nowhere near that ceiling. Revisit only if real usage ever
approaches session counts where that stops being true. Both judge-gated detectors use `bulk` tier,
which (unlike `mechanical`) is already wired in both judge adapters (`judge-claude.mjs` and
`judge-hermes.mjs`), so nightly runs (`JUDGE_ADAPTER=hermes`) get full classification quality — no
new version of §6a.8's known Haiku-tier nightly gap is introduced here. **Wall-clock (found during
smoke-testing, fixed same session):** each `judge()` call is a real CLI subprocess call (~8s
observed on `judge-hermes.mjs`'s `bulk` tier) — run strictly sequentially, up to 25 candidates
(`NEW_SKILL_JUDGE_CAP` + `DUP_JUDGE_CAP`) took long enough that a real backlog scan exceeded a 180s
smoke-test timeout. Fixed with a small bounded worker pool (`mapLimit`, `JUDGE_CONCURRENCY = 4`) —
the judge calls are independent per-candidate classifications, so 4 concurrent workers cut
wall-clock roughly 4x without changing total judge-call volume or cost.

**Built + smoke-tested same session, 2026-07-07.** Real end-to-end runs against live transcript data
in an isolated `COCKPIT_MEMORY_ROOT` (`--days 1` and the `--days 30` default, both dry-run and real
writes): all four detectors minted well-formed findings; `apply`/`dismiss` verified to work
generically across detector types with no code change needed; a second scan confirmed
`command-pattern`'s existing crossing-based resurfacing, `underused-skill`'s now-permanent
dismissed-skill silence, and `duplicate-parallel-effort`'s permanent pair-dedup all hold correctly.
**Code-time Codex review** (after the design-time pass + implementation, mirroring §6a.8's own
two-pass precedent) found 2 majors + 1 minor, all fixed: (1) `duplicate-parallel-effort` deduped
already-minted pairs **after** slicing to `DUP_JUDGE_CAP`, letting stale top-cosine pairs starve
genuinely-new lower-ranked ones — reordered to dedup first, cap second; (2) `enumerateSkills()`
defaulted an unknown git age (lookup failure / untracked file) to `Infinity`, making an
unknown-age skill trivially "old enough" and risking a false underused-skill finding for a skill
that just landed — changed the fallback to `0` (too-new-to-judge, excluded, matching the store's
general skip-rather-than-guess stance); (3) `classifySkillCandidate()`'s judge prompt omitted the
"up to 3 evidence lines" this section promised — added, matching `command-pattern`'s own
evidence-line format (`file:line @ timestamp`).

**Amendment 2026-07-08 — `command-pattern` narrowed to bash-only; `new-skill-candidate`'s judge
prompt gained an MCP reasoning axis (both surfaced by review of the first real nightly run's
output, in conversation, not a Codex-review finding).**

*`command-pattern` (§6a.8) drops MCP occurrences entirely — its grouping is now filtered to
`kind: 'bash'` before candidates are built (`new-skill-candidate` is unaffected, still reading MCP
occurrences from the same unfiltered raw `cmdGroups`).* Two independent reasons surfaced this: (1)
the owner runs Claude Code permissionless, so the original "add a permission rule, it keeps prompting"
framing was dead advice — permission prompts never fire on that install in the first place, and detection
itself (occurrence counting from the transcript) was never affected by permission mode, only the
*fix text*'s relevance was; (2) command-pattern's underlying premise — "you're tired of retyping
this" — never actually fit an MCP call even independent of permission mode, since a human doesn't
type an MCP tool invocation, the model decides to make it; there's no typing-friction to relieve.
`suggestedFix()` is now bash-only and alias-first: "consider aliasing this in your shell config —
or, if you ever run without permissionless mode, add a permissions.allow rule" (permission rule
demoted from the lead suggestion to a conditional secondary one).

*`new-skill-candidate` keeps MCP in scope* (a blanket bash-only exclusion was considered and
rejected — see conversation 2026-07-08: a genuinely skill-worthy MCP pattern, where real manual
judgment/formatting/orchestration happens around each call, should still qualify; the problem wasn't
MCP-as-a-kind, it was that the judge had no reasoning axis to use). Confirmed wrong on real data from
the first nightly run: four `new-skill-candidate` findings recommended wrapping `context-mode`'s
`ctx_batch_execute`/`ctx_search`/`ctx_fetch_and_index`/`ctx_execute` in a new skill, purely because
each was called dozens-to-hundreds of times — the judge's own rationale text was circular ("its
frequency suggests a reusable workflow worth capturing," restating the premise as the conclusion).
This is actively wrong for a context-management tool specifically: `context-mode`'s entire purpose is
reducing context bloat by running work in a sandbox and returning only derived results; high-frequency
use of it is the tool succeeding at its purpose, not a sign of missing automation — and wrapping its
usage in a Skill (whose description itself loads into context once triggered) would work against the
tool's own reason for existing. `classifySkillCandidate()`'s prompt now adds an explicit reasoning
axis for `kind: 'mcp'` candidates: distinguish "a self-sufficient utility call, high frequency = normal
use" from "manual judgment/formatting/orchestration around each call that a skill could actually
capture" — a single MCP tool call is often already the complete automation, not manual toil wrapped
around a gap. **Re-verified against real 30-day data, 2026-07-08:** a fresh scan minted 4
`new-skill-candidate` findings, all `kind: 'bash'` (`grep -n`, `uv run`, `cd`), zero `ctx_*` — the
`ctx_*` tools' occurrence counts (86-338) are far higher than any of the bash shapes that did get
minted (89-206), so they were still well within the pre-judge cap and definitely considered, not
merely out-ranked by volume; the judge correctly rejected them this time. **Honest caveat (Codex
code review 2026-07-08, major):** the reasoning-axis prompt asks the judge to look for "manual
orchestration around each call," but `classifySkillCandidate()`'s evidence is only
`file:line:timestamp` — no captured tool input/args — so in the CURRENT evidence surface the judge
has no actual material to observe orchestration with; it can only ever report "none visible." In
practice this is close to a blanket exclusion for `kind: 'mcp'`, not the more nuanced case-by-case
judgment the design intended. Accepted rather than building input-capture machinery no real case has
needed yet (context-mode, the one concrete case in hand, SHOULD be rejected) — revisit if a
genuinely skill-worthy MCP pattern is ever wrongly suppressed by this.

---

### 6a.8c Insights inbox — `recurring-failure` detector (designed 2026-07-07, same-day follow-on to
§6a.8b, the owner's own suggestion after reviewing the shipped four)

A fifth detector, joining the same `scan()` / same store / same one-pass JSONL walk. Answers a
question none of the other four do: *"is there something you keep trying that never works?"* —
distinct from `command-pattern` (annoying but working, just wants a permission rule) and
`new-skill-candidate` (working, just repetitive).

**Shared infra extension — tool-result correlation.** `analyzeTranscript()`'s one-pass walk already
captures every `Bash`/`mcp__*` `tool_use` block as an occurrence (kind `bash`/`mcp`). This adds a
sibling branch, gated on `obj.type === 'user' && Array.isArray(obj.message.content)`, that scans for
`tool_result` blocks (`{tool_use_id, is_error, content}` — confirmed against real transcripts before
writing this: `tool_result` blocks live in synthetic `user`-role records, `tool_use_id` matches the
originating `tool_use` block's own `id` field). A `Map<tool_use_id, occurrence>` built alongside
`occ` (bash/mcp occurrences only, in-window — the same window filter that already gates `occ` itself)
lets the correlation mutate the occurrence object in place the moment its result arrives later in the
same forward pass (tool_use always precedes its tool_result in a transcript, so a single forward pass
suffices — no second pass, no buffering). Each occurrence gains `error: boolean | undefined` (`true`
= `is_error`, `false` = success, `undefined` = no `tool_result` ever arrived — e.g. an interrupted
session; treated as neither success nor failure, never as evidence either way) and, only on failure,
`errorSnippet` (the result's text content, truncated to 300 chars, for the claim/evidence text).
**Deliberately scoped to `bash`/`mcp` occurrences, not `skill`** — mirrors `command-pattern`'s own
bash/mcp-only scope; a failing skill invocation is a real signal too but out of scope for v1, easy to
extend later (documented judgment call, not an oversight).

**Detector definition.** `candidatesForRecurringFailure()` builds its **own** grouping map from
`command-pattern`'s raw `cmdGroups` (shared grouping, same reuse pattern as `new-skill-candidate`):
for each shape, compute `successes` and `failures` from the group's **full** occurrence list; skip
the shape entirely if `successes.length > 0` (any success anywhere in the current window disqualifies
it — see resurfacing note below); otherwise, if `failures.length >= MIN_OCCURRENCES` (3), build a new
group whose `occurrences` array is **the failures only** (successes are not carried forward). That
failures-only group map is then passed to the **existing shared `candidatesForNamespace()`** helper
(namespace `recurring-failure`) — this is what makes reuse actually safe (Codex design review
2026-07-07, blocker: the original draft said "reuses unmodified" without specifying which occurrence
list feeds the shared dedup helper, which would have let an implementer resurface on stale timestamps
or non-failure occurrences). Because the fed-in `occurrences` are failures-only,
`candidatesForNamespace()`'s existing "fresh occurrences since resolved" check literally means "fresh
*failures* since resolved" — no code change to the shared helper, only to what's passed into it.
**What re-triggers a dismissed finding:** the per-run zero-successes gate above already handles the
"did a success happen" question more simply than a resolved-timestamp special case would — any
success in the *current* window disqualifies the shape from minting this run, full stop, regardless
of whether there's a prior resolved finding or its timing; only once a run's window contains zero
successes again does the shared crossing-based rule get a chance to fire (3 fresh failures since the
last resolution). **"Zero successes ever this run" is the precision bar, not "more failures than
successes"** — `normalizeBash`'s first-two-token shape is coarse (`git push` covers many different
real invocations), so a shape that sometimes fails and sometimes succeeds is normal iterative work,
not "stuck."

**Judge call added (reversed from the original draft — Codex design review 2026-07-07, major,
empirically confirmed against real transcript data before accepting it):** the original draft claimed
"zero successes across ≥3 tries" needed no judge classification. Checking real transcripts before
writing this correction: `is_error: true` on a Bash `tool_result` tracks the underlying **shell exit
code**, not a tool-infrastructure failure — e.g. `node --check some-file.mjs && echo OK` failing with
a real syntax error while actively editing that file, or `git add` hitting a gitignored path,
both showed up as real `is_error: true` results with ordinary "Exit code 1" content. A command that's
*expected* to fail while you're mid-fix (a lint/test/syntax check re-run during debugging, a probe, an
`--exit-code`-style check) can easily rack up 3+ same-shape failures with zero successes in a short
window — that's normal iterative work, not "stuck," and the deterministic bar alone can't tell the
two apart (the two-token shape carries no information about *why* it failed). So this detector now
gets its own `bulk`-tier `judge()` classification, same pattern as `new-skill-candidate` and
`duplicate-parallel-effort`: given the shape, occurrence count, and up to 3 sampled `errorSnippet`s
(most recent first — different invocations' actual error text, even though the shape itself is
identical across them), ask `{"stuck": <true ONLY if this looks like a genuinely broken/stuck
recurring problem worth surfacing unprompted — a persistent misconfiguration, missing dependency, or
wrong approach; false if this looks like NORMAL iterative work where the command is expected to fail
until a fix lands>, "rationale": "<one short sentence>"}`. Candidates are capped to the top 15 by
failure count (`RECURRING_FAILURE_JUDGE_CAP`, same backlog-safety-net spirit as the other caps)
before spending a judge call, run through the existing bounded-concurrency `mapLimit()`
(`JUDGE_CONCURRENCY`). **A judge failure skips that candidate silently** — same fail-safe stance as
the other two ambiguous-signal detectors (a real gate, not cosmetic phrasing; failure must not default
to minting a false positive).

Pattern key: `recurring-failure::<same key as command-pattern's group>` — its own namespace, same
decoupling rationale as `new-skill-candidate` (an open `command-pattern` finding for a shape must
never block `recurring-failure` from considering that same shape, or vice versa — they answer
different questions from the same raw grouping). Own 5-finding noise cap, ranked by failure count
among judge-confirmed candidates. Claim template: "You've run `<shape>` (<kind>) `<n>` times in the
last `<days>` days in scope "`<scope>`" and it has failed every time (0 successes recorded) —
`<judge rationale>`. Last error: "`<errorSnippet>`"." Evidence: `file:line @ timestamp —
errorSnippet` per failure occurrence (up to 5), so the finding is actionable without re-opening the
transcript. Suggested fix (necessarily generic — no detector here can know the actual cause):
"Consider looking into why this keeps failing — check the error above, or whether it needs a
different approach/flag/dependency."

**`tool_result.content` shape (Codex design review 2026-07-07, minor — was under-specified):**
mirrors the existing content-extraction pattern already used for session-opener text: `content` may
be a bare string OR an array of content blocks (`{type: 'text', text: ...}`); `errorSnippet` extracts
the same way opener text does — string as-is, array filtered to `type === 'text'` blocks and joined —
then truncated to 300 chars. No new parsing convention introduced.

**Evidence contains raw tool-output content — a deliberate, documented deviation (Codex design
review 2026-07-07, major, weighed and accepted, not silently overridden):** all four shipped
detectors write only file:line:timestamp references into their evidence, never transcript content.
`errorSnippet` breaks that pattern because the whole point of this detector is to be actionable
without re-opening the transcript — a bare "it failed 3 times" reference is far less useful than
seeing what actually failed. This is accepted, not brushed aside, because the trust boundary doesn't
actually widen: `MEMORY_ROOT/insights/` lives inside the private `memory/` data repo (gitignored from
the engine code repo, OSS-1's public=system/private=data split), the exact same trust
boundary as the raw transcripts themselves (`~/.claude/projects/`, already fully local and
non-confidential — the confidential-wall gate below already excludes walled scopes entirely before
any occurrence, let alone its error content, is ever collected). Copying up to 300 chars of already-
local, already-non-confidential command output into another already-local, already-non-confidential
file is not a new leak surface, just a copy within the same wall. Revisit if this detector is ever
extended to a less-trusted surface.

**Confidential wall:** reuses the exact same `cwdScope`/`liveScopes` gate — no new guard code. The
tool_result correlation only ever mutates occurrence objects that already survived the window filter
inside a walled-check-gated return path (same invariant as §6a.8b: nothing extracted from a
walled/unmapped file is ever returned to the caller) — a walled file's `errorSnippet`s are discarded
along with everything else the moment the gate check fails, before `scan()` ever sees them.

**Known accepted limitation:** `is_error` reliability varies by tool — some MCP tools may report a
logical failure inside successful-looking `tool_result` content without setting `is_error`, so this
detector under-catches those (no false positives from it, only false negatives) — same class of
limitation as `command-pattern`'s own shape-coarseness, accepted rather than solved for v1.

**Built + smoke-tested same session, 2026-07-07.** Real end-to-end runs, mirroring the prior three
detectors' method: an independent from-scratch Python replica of the correlation+grouping logic
confirmed 0 real candidates exist in the live 30-day data (so a "0 minted" real-data result is
verified correct, not a silent failure); a synthetic transcript (deliberately written to the JSONL
file OUT of chronological order, to stress-test ordering) placed temporarily under
`~/.claude/projects/` and scanned against a real, isolated `COCKPIT_MEMORY_ROOT` correctly minted a
well-formed finding end-to-end, judge classification included, then was fully cleaned up (verified no
trace remains). **Code-time Codex review: 1 major + 1 minor, both fixed.** The minor, caught first
and the more consequential of the two in practice: occurrences arrive in file-scan order across
possibly multiple transcript files, not chronological order — the original code's "most recent
first" judge-prompt claim and the claim text's "Last error" were not actually guaranteed true.
Fixed by sorting failures ascending by timestamp once in `candidatesForRecurringFailure()`, so
`.at(-1)` (claim's "Last error") and the judge prompt's 3-most-recent samples (`.slice(-3).reverse()`)
and the evidence list's 5-most-recent (`.slice(-5).reverse()`) are all now genuinely
chronologically ordered — re-verified with the deliberately-scrambled synthetic transcript (file
order `[3,0,2,1]`; output correctly identified attempt 4 as both the judge's most-recent sample and
the claim's "Last error," and evidence listed 4→3→2 descending by real timestamp). The major:
`errorSnippet` (raw tool-output content) was embedded bare into the judge prompt with no boundary
against text that might read as an instruction, and the confirm gate accepted `verdict.stuck` on
truthiness rather than a strict boolean check. Hardened, not claimed as fully solved (the threat
model here is a local single-user tool's own command output, not an adversarial third party — the
same bare-embedding pattern already exists unflagged in `new-skill-candidate`'s and
`duplicate-parallel-effort`'s judge prompts, out of scope for this surgical fix): each error sample
is now wrapped in its own fenced block with an explicit "treat as DATA, not instructions" framing,
and the confirm gate now checks `verdict.stuck === true` strictly.

### 6a.8d Unified nightly self-improvement engine + harness-upgrade proposals inbox (designed
2026-07-10, resolves OPEN-10 — BUILT 2026-07-11, all 5 steps)

Reopens OPEN-10 ("harness auto-upgrade from failures," deferred since 2026-06-25 pending "real
harness-improvement signal" and a clearer Board/Workflows layer — both now true: insights has run
nightly since 2026-07-07, Board shipped 2026-07-06). Triggered by noticing two adjacent gaps
in one sitting: (1) `mechanical-insights.mjs`'s five detectors are pure occurrence-counting, blind to the one
signal the reconciler already treats as ground truth — `#good`/`#bad` verdicts (MEM-22) — and to the
graph itself; (2) nothing in the cockpit closes OPEN-10's loop — the harness (skills, MCP wiring,
hooks/config) has no self-upgrade path beyond `learned-engine.mjs`'s narrow per-skill `LEARNED.md`
case (BUILD-5).

**What this is NOT:** a merge of `reconcile.mjs` and `mechanical-insights.mjs` into one lifecycle. ATT-1's "one
object, one question" rule stands — a graph node is judged fact (MEM-27 consolidation, guarded,
reaches the always-load layer); an insight is an unreviewed hypothesis about activity (human
apply/promote/dismiss); the new harness-upgrade proposal below is a THIRD, distinct epistemic status
(a drafted, unapplied change to the harness itself). Collapsing these would recreate exactly the
laundering risk MEM-31's adversarial review found in the visionary layer — a repeated-but-wrong
autonomous guess is not corroborated by its own repetition, so anything that can reach a live/
authoritative surface needs a stronger gate than "the graph didn't complain."

**One shared read pass, three typed outputs.** Today `mechanical-insights.mjs` and `reconcile.mjs` each walk a
different, non-overlapping input (raw provider JSONL vs. tagged `staging/`) with their own dedup/
noise-cap/pattern-key machinery, duplicated in spirit. This designs ONE nightly read that both
existing engines and the new detector draw from:
  - `staging/` turns + their `#good`/`#bad`/inferred tags (already read by `reconcile.mjs`'s
    `parseStaging`/`buildDigest`)
  - raw provider JSONL tool/skill/MCP occurrences, now carrying success/failure (already extracted by
    `mechanical-insights.mjs`'s `analyzeTranscript`, tool_result correlation from §6a.8c)
  - the live knowledge graph (`loadPool()`)
  - the skills directory (`enumerateSkills()`, from §6a.8b)
  - the MCP tool catalog actually invoked in-window (occurrence `kind: 'mcp'` shapes, already
    collected, previously used only for frequency)
  - **Hermes' `state.db` activity log (added this session, sequenced last in build order)** — reuses
    `history-search`'s (TOOL-8) existing read-only access to `state.db`. **Corrected post-third-Codex-
    pass:** the safety mechanism is NOT a row-level confidential-wall allowlist (`history-search.mjs`
    doesn't filter Hermes queries the way it filters Claude JSONL by `cwdScope`) — it's structural:
    TOOL-8's confidential ventures run their own separate `HERMES_HOME`/`state.db` entirely, so the
    SHARED `state.db` this reads never contains confidential rows in the first place. Genuinely new
    work, not reuse: `state.db`'s `messages_fts` is built for text search, not structured tool-call
    events — extracting the same occurrence shape Claude's JSONL gives for free needs its own parsing
    against Hermes' schema, and its `tool_name` column is already known to be coarse (`skill_view`-style
    wrappers). **Also corrected post-third-Codex-pass:** every occurrence now carries a `provider:
    'claude'|'hermes'` field, and pattern keys become `provider::scope::kind::shape` — Claude and Hermes
    occurrences of a nominally-same shape are tracked as separate patterns by default (no silent
    cross-provider merging, given Hermes' coarser granularity); cross-provider aggregation is a
    deliberate future call, not assumed now. This is the single costliest addition here — every
    detector above gains Hermes coverage once it lands, but it does not gate anything else in this
    section.

Emitted to:
  1. **graph nodes** — unchanged; `reconcile.mjs`'s distill→consolidate→guard→commit, still the only
     writer of `knowledge/`.
  2. **insight findings** — `mechanical-insights.mjs`'s existing five detectors, PLUS a sixth,
     `recurring-correction`: groups `#bad`-tagged turns by COSINE-EMBEDDING similarity above a new
     `CORRECTION_THRESHOLD` (uncalibrated initial guess, same honestly-documented stance as
     `DUP_THRESHOLD` — reuses `duplicate-parallel-effort`'s existing `embed()`/`dot()` infra, §6a.8b —
     NOT the distiller's `cluster` label, corrected post-Codex-review: raw staging turns from
     `parseStaging()` carry only `{role, tags, text}`, no cluster field; only distilled candidate nodes
     get one) that recur in-window with no matching `#good` on the same group resolving them — same
     shape as `recurring-failure` (§6a.8c): a bulk-tier judge gate confirms "genuinely still wrong" vs.
     "already corrected, just re-discussed." **Pattern key (corrected post-second-Codex-pass):** anchored
     to the group's EARLIEST qualifying `#bad` turn's citation (`recurring-correction::<scope>::
     sha8(<citation>)`), never to the full membership set — an embedding cluster's membership can drift
     run to run as new turns cosine-match in, and a key over the whole set would mint a fresh finding on
     every drift, breaking the dedup contract every other detector relies on; a later run adding members
     to the same anchor is still "the same pattern." Same noise cap/lifecycle conventions as the other
     five. Also extends skill/MCP signal from raw call-COUNT to call-EFFECTIVENESS (success-rate
     correlated with nearby `#bad`), feeding `new-skill-candidate` and `underused-skill`'s existing judge
     prompts as additional evidence, not a new detector.
  3. **harness-upgrade proposals (NEW store, `<MEMORY_ROOT>/harness-proposals/`)** — draft-only
     artifacts: a proposed new `SKILL.md` body, a proposed MCP-wiring note, a proposed
     `.claude/settings.json` permission-rule diff. **Payload shape (corrected post-second-Codex-pass):**
     one markdown file per proposal (no separate attachment scheme), `mechanical-insights.mjs`'s frontmatter fields
     (`id`/`claim`/`evidence`/`source`/`pattern`/`scope`/`status`/`detected`/`resolved`), draft content
     as a single fenced code block in the body (`markdown` fence for a proposed SKILL.md, `diff` fence
     for a permission-rule/MCP-wiring change) — `claim` stays the short summary `list` prints, the fence
     is what `apply` prints in full. Dedup by pattern key, per-run noise cap, but a NARROWER two-state
     lifecycle — `new → applied|dismissed` only, no `promote` (corrected post-Codex-review: insights'
     `promote` means "seed a `closure.mjs declare`," which doesn't transfer to a harness change; left
     undefined it was a lifecycle hole). Its exact writer-lock discipline (WORK-1 spirit): **the nightly
     scan only ever mints a proposal file under its own store — it NEVER writes to `skills/`,
     `.claude/settings.json`, or any MCP registration, live or otherwise.** `apply` prints the fenced
     content for the human to place by hand, same as insights' `apply` today. This is OPEN-10's own
     question 3 answered at the conservative end: no risk-tiering in v1 — EVERY proposal is draft-only
     regardless of blast radius (prose-only skill doc or config diff, no distinction), matching
     the owner's explicit choice (draft-only, always) over a tiered auto-apply-if-low-risk alternative.
     Revisit tiering only after this store has real mileage, the same trigger discipline MEM-31 used
     before loosening `VISIONARY_BUDGET`.

**Self-connect: cross-linking the three stores.** `links.mjs`'s edge model (MEM-31) is untyped
node↔node `{a, b}` ids, `prune()` dropping an edge the moment either id leaves the live node-id set.
Extended (typed endpoints specified post-Codex-review, not left to implementation time) so an edge
can name `node:<id>`, `insight:<id>`, `proposal:<id>`, `skill:<name>`, or `mcp:<tool>` — a type-prefixed
string still sorts/dedups correctly under `edgeKey()`'s existing canonical-pair scheme. Per-type
`prune()` rule: `node:` prunes exactly as today (missing/superseded); `insight:`/`proposal:` prunes only
if the finding/proposal FILE is gone, never merely for reaching a terminal status (a `dismissed` finding
still exists and is still worth a connection); `skill:` prunes if `skills/<name>/SKILL.md` no longer
exists; `mcp:` is never auto-pruned in v1 (no deregistration signal exists yet — a tool merely unused
this window still exists). So the morning read is one connected picture (an insight about a recurring
`#bad` ↔ the graph node it corrects ↔ the harness-upgrade proposal it spawned), not three unrelated
inboxes. Same auto-apply/no-review-queue trust tier as today's node links (MEM-28: grounded +
reversible, git is the undo) — a cross-store link asserts nothing new, it only names an existing
relationship between artifacts that already independently exist.

**Closing the loop: proposal → artifact auto-link (added this session).** Read-only, additive: each
scan checks whether a proposal's named artifact now actually exists (a proposed skill now has a real
`skills/<name>/SKILL.md`, a proposed permission rule now appears in `.claude/settings.json`) and, if
so, adds a `proposal:<id> ↔ skill:<name>` (or the relevant config reference) edge via the extension
above. It never flips the proposal's own `status` — that stays human-invoked, exactly as everywhere
else in this section; the edge only makes an already-independently-true fact visible. **Corrected
post-third-Codex-pass:** name-matching alone can overclaim causation (a same-named skill could be
unrelated, independently authored) — the edge always carries a note, "name-matched only, not verified
as caused by this proposal; `status` unchanged," so the connection never silently implies resolution.

**Board integration (added this session).** `mechanical-insights.mjs` already gets a one-line Board footer (a
plain count outside Board's lens computation, ATT-1's own pattern). `harness-proposals/` gets the
identical treatment — same mechanism, not a new integration surface. **Corrected post-third-Codex-pass:**
the counting rule wasn't actually stated — matches `mechanical-insights.mjs`'s own `countOpenInsights()` exactly,
`status: new` only; the proposal→artifact auto-link never touches `status`, so it never changes the
count, only what a linked proposal's own list/detail view shows.

**Ownership (OPEN-10 Q4):** one reconciler-adjacent engine — the shared read pass (now spanning both
brains' activity, not a separate Hermes job) lives beside `reconcile.mjs`/`mechanical-insights.mjs` in
`memory-engine/`, still dispatched by the one existing `dream.sh`/`cockpit-reconcile.timer` (no new
systemd/launchd unit — same minimalism-rung reasoning `dream.sh`'s own header already gives for keeping
insights on the one timer).

**Trigger (OPEN-10 Q1) and target selection (OPEN-10 Q2), answered:** trigger = `#bad` density
(recurring-correction) + skill/MCP effectiveness delta, same evidence class the existing five
detectors already use, not a new centrality-threshold mechanism on harness-meta nodes (rejected —
would require minting graph nodes ABOUT the harness, a scope creep on `reconcile.mjs`'s judged-fact
contract). Target = skill authoring/retirement + MCP wiring notes + permission-rule diffs — explicitly
NOT tool code, hooks, tests, or project loaders (OPEN-10's own "likely need stronger verification"
tier) — those stay fully out of scope until this store has a track record.

**Status:** designed, built, then REMOVED per ATT-3 (2026-07-25, cut executed in MEM-38 step 8):
the store, `harness-proposals.mjs`, its Board footer, the middleware/board surface, and the
proposal→artifact auto-link are all gone from the code; the design below is preserved history
(rationale kept in the ledger's harness self-upgrade entry), and `proposal:` link endpoints are legacy
edges that `links.mjs prune()` now treats as dead (no producer). The rest of this section reads as
it did when the lane was live. **Two Codex adversarial passes (2026-07-10), both folded — none open:**
pass 1 found 1 blocker (the cluster-label gap) + 2 majors (links.mjs typed-endpoint gap, the undefined
`promoted` state); pass 2 (re-reading the fixed draft fresh) found 2 more majors (the cosine-grouping
fix's own missing threshold/stable-pattern-key rule; the harness-proposals payload shape, never actually
specified) + 1 minor (a stale DECISIONS.md cross-reference), all folded into this section. **Three more
pieces added the same session, before any build** (Hermes `state.db` as a second occurrence source, the
proposal→artifact auto-link, the Board footer) — **a third Codex pass reviewed these fresh and found 2
more majors + 2 minors, all folded in**: the Hermes confidentiality claim was overstated (fixed: the real
mechanism is TOOL-8's structural `HERMES_HOME` separation, not row-level filtering); occurrences needed
a `provider` field to avoid silently merging Claude+Hermes patterns (fixed: `provider::scope::kind::shape`
keys); the auto-link could overclaim causation on a name match alone (fixed: an explicit "name-matched
only" note); the Board footer's counting rule was left implicit (fixed: `status: new` only, matching
`countOpenInsights()`). Build order once approved: (1) extract the shared read pass as a small library both `reconcile.mjs` and `mechanical-insights.mjs`
import (no behavior change — a refactor, verify byte-identical output first); (2) `recurring-correction`
detector inside `mechanical-insights.mjs`'s existing `scan()`; (3) the harness-proposals store + its Board footer
(mirrors `mechanical-insights.mjs`'s file-per-finding shape and footer almost exactly — smallest new surface);
(4) the `links.mjs` cross-store extension, including the proposal→artifact auto-link (lowest risk,
purely additive, no new write path); (5) Hermes `state.db` as a second occurrence source, last —
the biggest lift, fully separable from 1–4.

**Amendment (2026-07-20, AR-5 task #1) — frequency detectors RETIRED, survivors get Dream-style
scoring:** the four frequency-based detectors are retired as noise mints, per
[[insight-minting-must-suppress-harness-and-trivial-command-no]] and
[[insights-must-use-judged-qualitative-signals]]:
- `command-pattern` (§6a.8): "you ran grep 235 times" carries no actionable signal, frequency of
  trivial commands is how all work happens.
- `underused-skill` (§6a.8b): "retire teach after 7 quiet days" nags on cadence, not on evidence a
  skill stopped fitting.
- `new-skill-candidate` (§6a.8b): its evidence surface (file:line:timestamp, no captured args) never
  gave the judge real material, so verdicts were frequency in disguise.
- `duplicate-parallel-effort` (§6a.8b): dup-detection kept matching /model harness turns, structural
  similarity is not duplicate work.
The judged detectors survive: `recurring-failure` (§6a.8c) and `recurring-correction` (§6a.8d),
with `semantic-insights.mjs` (ATT-2 B4) now the primary detector family. The §6a.8/6a.8b/6a.8c
detector specs above stand as history, not as live capability. New mechanics for the two survivors
(matching the fields `semantic-insights.mjs` already writes): each classify call also returns
`severity` (1-10) and `certainty` (0-1), stored in frontmatter with `score` = severity x certainty;
a GLOBAL per-scan mint cap of 4 across both detectors combined (replaces the per-detector
NOISE_CAP=5), selected by descending score with a diversity constraint (never all 4 from one
detector if the other has any qualifying finding); an anti-confabulation floor of >= 5 failure
occurrences for `recurring-failure` (raised from 3; `recurring-correction` keeps >= 3, #bad tags
are deliberate human signals with higher per-signal value); and a `first_seen` frontmatter field
carried across re-mints of the same pattern key, in both mechanical and semantic minting, for age
tracking across resolve/re-mint cycles. `harness-proposals.mjs`'s `mintProposal()` lost its only
callers (the two retired skill detectors) and went dormant; the dormancy ended with ATT-3's cut
(MEM-38 step 8): the module, store, Board footer, and read paths are removed.

### 6a.8f Prescription composition pass (built 2026-07-22, AR-5 design-session item — `compose-insights.mjs`)

A presentation-only LLM step at mint time: after judging selects the survivors, each minted
insight gets additive `composed_headline` / `composed_prescription` (2-3 sentences, second
person) / `composed_tone` (warning | opportunity | hygiene) / optional `composed_command`
(only when the claim/fix literally names one, never invented) / `composed_at` frontmatter
fields, written by `composeFields()` in `compose-insights.mjs` and called from both minters'
write paths. It NEVER touches claim/evidence/scores or any judging/cap logic; cost is bounded
by the existing mint caps (one `bulk`-tier judge() call per survivor — `bulk` because it is the
one tier wired on both adapters, so the nightly Hermes run composes for real). Fail-soft by
contract: any composition failure logs a warning, returns `{}`, and the insight mints exactly
as before; every consumer (dashboard `dreamView`/carousel included) treats absent composed
fields as normal and falls back to claim/`suggested_fix` rendering. `compose-insights.mjs
backfill [--dry-run]` is the idempotent catch-up verb for pre-existing insights (skips any file
already carrying `composed_headline`); ran 2026-07-22, 24/24 composed.

### 6a.8g Dreaming upgrade: corrections ledger, session-sprawl, underused-skill revival,
temperature-composed staleness/truth, continuity composition (DESIGNED 2026-07-23, AR-5
dashboard-port session; BUILT same day, build notes at the end of this section)

Design locked live with the owner 2026-07-23. Everything below stays inside the locked AR-5 task-1
doctrine: counts wrapped in judgment, no raw-frequency minting; only `scan`/nightly paths mint;
apply/promote/dismiss stay human-only. Build order = the numbered items, commit per item, Codex
adversarial review before finalizing (worker is not judge). Cinematic replay and the Full-review
overlay redesign are dashboard/fork-side, out of this spec.

**1. Corrections-ledger redesign (`mechanical-insights.mjs` + `read-pass.mjs`; supersedes
§6a.8d's recurring-correction mechanism).** Triggered by the 2026-07-23 misfired
recurring-correction card. recurring-correction becomes a ledger of individually tracked human
verdicts, not a cluster-and-count detector:
- Floor 3 to 1: every `#bad` user turn becomes a ledger entry, keyed by its `stg:` citation.
- Referent capture: entry text = the #bad turn PLUS the preceding ~2 exchanges from the same
  staging file (the correction's referent), never the tag message alone.
- Harness-block stripping: a new `stripHarnessBlocks(text)` helper in `read-pass.mjs` removes
  `<system-reminder>` blocks, `cockpit:recall` blocks, and `<command-*>`/`<local-command-*>`
  tags before capture, embedding, and evidence rendering.
- One bulk-tier judge verdict per NEW entry (capped per run), three-way: `absorbed` (one-off,
  already handled) | `preference` (durable style/preference, distiller material, not an insight)
  | `standing` (unresolved standing problem). ONLY `standing` mints an insight; severity/
  certainty/score as today.
- Resolution = post-correction recurrence, NOT #good presence: a `standing` entry resolves when
  later scans find no new cosine-similar #bad after the correction inside the recurrence window.
  `#good` turns are tracked separately on the ledger as reinforcement signals (cosine-linked,
  stored, rendered as evidence), never as resolution.
- Evidence is rendered as the human's actual sentences (stripped excerpts), not citations-only.
- Storage: `memory/.reconciler/corrections-ledger.json`, recomputable from staging (judge
  verdicts are cache; losing the file costs re-judging, never truth). Pattern keys stay
  `recurring-correction::<scope>::sha8(citation)` per entry for insight-dedup compatibility.

**2. `session-sprawl` detector (`mechanical-insights.mjs`). REMOVED per ATT-3 (2026-07-25, cut
executed in MEM-38 step 8): it failed the on_accept test (no nameable consequence to accepting a
sprawl card). The detector, its constants, the per-file stats in `analyzeTranscript`, and the
dashboard rendering/artwork are gone; the description below is preserved history.** New judged detector over the
raw-transcript walk `scan()` already performs (reuses `listClaudeJsonl`/`analyzeTranscript`; no
FTS5/sqlite dependency, the roadmap's "from FTS5" was a signal-source suggestion and the same
data is already walked). Per session file in window: turn count, distinct-tool breadth,
wall-clock span, opener excerpt. Candidates = top sessions over a size floor; the judge confirms
"genuinely sprawling (multi-topic, context-rotted, should have been split or handed off)" vs
"long but coherent". Mints into the same global MINT_CAP=4 selection; the diversity rule extends
to three mechanical detectors (each detector with qualifying findings gets at least one slot
before any takes a second).

**3. Revived judged `underused-skill` detector (`mechanical-insights.mjs`).** Per the AR-5
task-1 amendment (judged form may return, raw frequency stays retired). Re-enable `kind:
'skill'` occurrence collection in `scan()`. Candidates: skills from `enumerateSkills()` past an
age threshold with zero/low in-window invocations. The judge finally gets real material: the
SKILL.md description, LEARNED.md presence/size, last-use date, and a sample of in-window session
opener texts (what work actually happened), so the verdict is "recent work plausibly had fits
for this skill and it went unused" vs "no fit occurred". Only judge-confirmed mismatches mint.
Recency signal (MEM-38-family detector upgrade): `read-pass.mjs`'s `skillGitDates(relPath,
gitRoot)` returns both `ageDays` (oldest commit, the field `enumerateSkills` always carried) and
`lastChangedDays` (newest commit) from the same `git log --follow` call, parametrized by an
explicit `gitRoot` for hermetic testing; `enumerateSkills` attaches `lastChangedDays` to every
skill record. `filterUnderusedSkillCandidates` gates on both floors now: the existing age floor
(too new to judge) plus a new recency floor (a skill just touched is not "underused" this week
regardless of how old it is), and `rankUnderusedSkillCandidates` orders the survivors
largest-`lastChangedDays`-first (least-recently-used leads) before the `SKILL_JUDGE_CAP` slice,
so a stale-but-alphabetically-late skill can't be pushed out of the pre-judge cap by a run of
fresher, earlier-ordered ones. `buildUnderusedSkillPrompt` carries `lastChangedDays` into the
judge's own prompt text alongside `ageDays`.

**4. Staleness, composed with truth-pass by temperature (the session's central design call).**
Three watchers, three different questions, and the boundary is epistemic: truth-pass (MEM-37)
asks "is this node still TRUE" and may act on node lifecycle under its full rigor (quoted ledger
span, string match, cross-family two-pass, second-day confirmation); staleness asks "is this
file NEGLECTED" and may only mint insight cards, never assert falsity, never mutate a node or
doc; MEM-33 relevance stays the recall-salience overlay. Collapsing their outputs would recreate
the §6a.8d laundering risk, so they share a READ layer and keep separate typed outputs:
- Shared signal collection rides truth-pass's existing nightly full-graph walk (no second
  sweep): per node, staleDays from git last-commit mtime (fs mtime fallback), recall-hit recency
  from `memory/.cache/recall-hits.jsonl`, and last-verified from the sweep state.
- Truth-pass's judge ROTATION lane (10/night) is re-ordered by a risk score over those signals,
  hot-and-old first: a recently-recalled old node is where wrongness does damage, so it gets
  verified first. Explicitly NOT "judge only stale nodes": cold nodes are the least dangerous
  place for wrongness, and gating truth on staleness would starve verification where it matters.
  The delta lane (15/night, ledger-diff triggered) and the deterministic T1 full sweep are
  untouched, and the sweep-completeness contract holds (rotation still eventually covers every
  live node, just in risk order).
- The COLDEST nodes flow the other way, to a `memory-staleness` insight consumer minting "cold,
  worth refresh/fold/archive" cards (budget-bounded judge, skips nodes already
  `ledger_conflict: confirmed` so nothing double-reports). For a cold node the question is not
  "is it true" but "does it still earn its place".
- Doc staleness lives where the doc walk already is: `doc-debt` (`semantic-insights.mjs`) widens
  its candidate set beyond project objects/roadmaps to the scope's authored spine docs
  (`DECISIONS.md`, `decisions/<topic>.md`, `memory-engine/DESIGN.md`, scope `CLAUDE.md`, and for
  `cockpit` also `README.md`, `skills/README.md`, `shells/doctrine.md`) and feeds the judge a
  fenced staleness-signals block (staleDays per candidate). Pattern keys stay
  `semantic::doc-debt::…`; rotation/budget/cooldown mechanics unchanged.
- Doc-debt upgrade (MEM-38-family): a project candidate now carries its own `staleDays` AND a
  separate `roadmapStaleDays` (the roadmap sidecar's own git-recency, a second `staleDaysFor` call
  against the roadmap file, never shared with the project file's number), and candidates are
  ordered largest-gap-first when the gathered set exceeds the cap. The recency cap that used to
  live inside `targetProjects` runs AFTER the gap sort for doc-debt specifically (it calls
  `targetProjects` with an unbounded cap, sorts by gap, then caps the sorted list), so a high-gap
  project sitting late in recency order is never dropped before ordering ever sees it; every other
  `targetProjects` caller (research-gap, project-scheduling, source-insight) keeps its original
  cap-then-order behavior unchanged. `workCommitsSince` counts
  engine-repo commits matching the project id, literally (`--fixed-strings`, never as a regex), since
  the roadmap's last commit date (null on a missing date or an unusable repo, never a throw), giving
  the judge a work-vs-roadmap signal distinct from age alone: a stale-looking roadmap sitting on top
  of live commits reads differently from one tracking real inactivity. `lastCommitDateFor` returns
  the full `%aI` timestamp, not truncated to the date, so `--since` draws a precise boundary and a
  same-day commit landing before the roadmap's own last change that day is never miscounted as work
  after it. The judge's roadmap block is built by `truncateRoadmap`, which assembles the Now and Next
  sections whole first, in file order; every other section (Done, Notes, preambles, anything else
  that is not Now/Next) is droppable and is added back, each in its own file-order position, only
  while it still fits the remaining budget, so a large droppable section can never displace
  Now/Next content that already fit; only when Now+Next alone exceed the budget does the cut fall,
  from the end (replacing the old blind 2000-char slice, which could cut into Now/Next content
  before ever reaching it). A headingless file whose only segment already exceeds budget would
  otherwise assemble to nothing; if the result is empty and the input was not, `truncateRoadmap`
  falls back to a budget-sized prefix of the original text. A deterministic header (`docDebtHeaderLines`: roadmap-unchanged
  days, work-commit count with an age-only fallback wording, newest date found in the roadmap text
  via `newestDateIn`) precedes the roadmap block, and the prompt adds a guidance sentence to flag a
  Now item whose promised date passed with no Done follow-through, or a Next item the same file's
  Now/Done records already show complete. `discoverReferences` parses `.md` references out of a
  project's body and roadmap text (`decisions/<topic>.md`, `artifacts/research/<x>.md`, sibling
  project files, …), resolves them against both the engine repo and the memory repo, keeps only
  existing files (deduped, escapes outside both roots rejected before any existence check, and the
  resolved realpath re-checked against each root's own realpath so a symlink cannot resolve outside
  either root even when its lexical path stays inside one). The 256 KB size bound
  (`REFERENCE_MAX_BYTES`) is enforced at discovery itself, inside `discoverReferences`, via a
  `stat` on the resolved realpath, right after the containment check and before the file is ever
  added to the discovered set; `discoverReferences` returns that validated realpath (the lexical
  path travels alongside, only for display titles), and the gatherer re-checks size against the
  realpath, via its own `stat`, immediately before the read, since a symlink could be swapped in
  the window between discovery and read (a residual TOCTOU gap accepted here, as repo writers are
  trusted system components). Each discovered file joins the candidate pool as its own
  spine-doc-shaped candidate tagged with a "referenced by `<project>`" context line, read in full,
  inside the existing
  `CANDIDATE_CAP` and judge budget, with no new cooldown key shapes. The final candidate list
  round-robins the three classes (projects, spine docs, references), each keeping its own internal
  order, before slicing to `CANDIDATE_CAP * 2`, so a large projects or spine-docs list can never
  starve references out of the cap.
  Shared gather (MEM-38-family detector upgrade, `semantic-insights.mjs`): the project-loop
  enrichment above (`staleDays`/`roadmapStaleDays`/`roadmapLastChangeISO`/the gap) now lives in one
  function, `gatherProjectCandidates(scope, project)`, memoized per scope|project for the life of
  a scan so concurrent gatherers of the same target never re-read the same files or re-run the same
  git log twice. `gatherDocDebtCandidates`, `gatherResearchGapCandidates`, and
  `gatherProjectSchedulingCandidates` all consume it — doc-debt and project-scheduling each sort
  their own copy largest-gap-first before their own cap (mirroring doc-debt's existing cap
  discipline); research-gap keeps its original recency-only order, just capped after the shared
  gather instead of inside `targetProjects`. research-gap's and project-scheduling's judge prompts
  are now built by exported pure functions (`buildResearchGapPrompt`/`buildProjectSchedulingPrompt`,
  assertable without invoking `judge()`), both using `truncateRoadmap` (replacing a blind
  2000-char cut) and carrying the same `docDebtHeaderLines` deterministic git-signal block
  doc-debt's own prompt carries; project-scheduling's prompt adds one guidance sentence that real
  commit activity vs the roadmap's own claims is a re-sequencing signal (a Now item with no
  matching commits, or a parked/Next item commits are actually landing against). Because the
  per-target cooldown only spaces re-scans, doc-debt, research-gap, and project-scheduling also
  carry a deterministic open-card gate that runs before the judge call (no LLM cost): while a
  status-new card from the same detector, scope, and project (matched exactly, with empty project
  as its own bucket; cards stamp the frontmatter `project` at mint) is still open, the candidate
  is skipped (no judge, no mint, refreshing or clearing the old card is the accept queue's job),
  fail-open if the insights store cannot be read.

**5. Continuity-aware composition (`compose-insights.mjs` + both minters).**
`composeFields(fm, { prior })` gains optional prior-state context: the most recent prior insight
sharing the pattern key (composed headline/prescription, status, first_seen age in days), passed
by the minters (which already load the pool) and rendered as a fenced "prior card state" block,
so compositions can say "day 3, unmoved" or correct yesterday's framing. Fail-soft contract
unchanged; absent prior means byte-identical current behavior.

**6. Telemetry readability check (investigation, no build).** Establish what cost/utilization
telemetry is locally readable (Claude Code JSONL usage fields, `~/.claude` stats files, Hermes
`state.db`, OTEL env) and record findings as a roadmap note for a possible future detector.

Build-session guardrails: no writes outside `insights/`, `doc-proposals/`, and `.reconciler/`
sidecars; the confidential wall is unchanged (raw-transcript detectors keep the `liveScopes`
gate, staging/graph readers stay MEMORY_ROOT-relative); first executions dry-run under an
isolated `COCKPIT_MEMORY_ROOT`. Verification: `node --check` on touched files; `scan --dry-run`
on real data for both minters; an isolated-root smoke test minting nothing into the real store;
one real re-mint exercising prior-state composition; Codex review folded before commit.

**Build notes (BUILT 2026-07-23, same-day build session; three Sonnet subagents split by file
ownership, all judgment/verification in the orchestrator).** Items 1-3 landed in
`mechanical-insights.mjs` + `read-pass.mjs` (corrections ledger at
`.reconciler/corrections-ledger.json`; `stripHarnessBlocks()` in read-pass; `session-sprawl` off
additive `analyzeTranscript` per-file stats; judged `underused-skill` with LEARNED.md/opener
material; `selectForMinting` generalized to N detectors). Item 4's truth half landed in
`truth-pass.mjs` (one-git-log stale map + recall-hits map as the shared read layer; rotation lane
risk-ordered with a coverage judged-set so the sweep still completes; `memory-staleness` minter,
`STALENESS_JUDGE_BUDGET=3` bulk calls/run); the doc half in `semantic-insights.mjs` (spine-doc
candidates, scope-mode scans only; fenced staleness-signals blocks as judge input, never a
verdict). Item 5 in `compose-insights.mjs` (`composeFields(fm, { prior })`, absent prior
byte-identical) with prior passed at every mint site including the staleness minter. Item 6
findings live in the dashboard-port roadmap (Done entry of this date). Orchestrator verification
fixes beyond the subagent output: pending ledger entries are judged from the ledger's pending set
(not the run's new gather), so judge failures/cap overflow retry next run; spine docs excluded
from --project-targeted scans. Codex adversarial review (1 blocker + 2 major + 1 minor, all
folded): rotation judge eligibility widened beyond T1-missing/quarantined so risk ordering is
real, with the coverage set above; wildcard `<command-*>`/`<local-command-*>` stripping; #good
reinforcements rendered as evidence; staleness minter joined the continuity seam. Verified:
node --check on all five files; isolated COCKPIT_MEMORY_ROOT scan dry-run (1461 transcripts, all
four detectors ran, zero files written to either store); real-data dry-runs of both minters and a
budget-bounded truthPass harness (364 nodes, staleness judged 3/30 coldest); one real
composeFields call with prior ("Day 3 ..." continuity confirmed).

**Follow-up seams (2026-07-23, same day, owner-approved): non-standing verdicts get consumers.**
(1) Preference back-channel: a ledger entry verdicted `preference` is distiller material whose
one-shot distill window already closed (staging consumed cursor), so `mechanical-insights.mjs`
appends it to `.reconciler/preference-redistill.json` ({items, processed}, deduped against both)
and `reconcile.mjs` re-distills up to 5 items/run as synthetic work-units (stg-cited via the
referent text in turnIndex; explicit preference framing in the digest). Two-phase: an item moves
to `processed` only when its distill parsed AND either it yielded zero candidates (terminal, the
judge said nothing durable, mirrors the MEM-36 source rule) or its scope's consolidation completed
without failure (same `consolidateFailed` gate as sourceMarks); failures stay queued and retry.
(2) Repeat-absorbed context: when judging pending ledger entries, each is cosine-matched against
the scope's most recent 30 `absorbed` entries; a match ≥ CORRECTION_THRESHOLD adds a fenced
prior-absorbed note to the judge prompt (recurrence after an absorbed verdict is evidence against
one-off), pushing the honest verdict toward `standing` through the existing insight route, no new
lane. Codex review folded (1 P1: advancement gated on consolidation success, not just distill
parse; 2 P2: per-scope absorbed lookback, backtick neutralization in the correction judge fences).
Verified in an isolated root: dry-run leaves the queue untouched; a real run advances a zero-yield
item to processed exactly once; re-queue of a processed citation is refused.

## 7. Retrieval

**Hybrid, complementary by level** (5-level taxonomy: exact → topic → semantic → relationship-chain → graph-inference):
- **Semantic (≈L3):** a **minimal in-process stack** (MEM-24, supersedes MEM-15's AnythingLLM pick) over the owned markdown — `@huggingface/transformers` running `all-MiniLM-L6-v2` (ONNX, zero-network, local) for embeddings, a flat `Float32Array`+JSON cache (re-embed on content-hash change), and **brute-force cosine** (no vector DB — unjustified below ~50k nodes). One shared graph (no per-vault isolation — MEM-23). The reconciler `require`s it in-process — no server/daemon/GUI. A swappable cache → low lock-in (breaks = lose convenience, not knowledge; the spine is engine-independent owned markdown).
- **Relationship / inference (≈L4–5):** **wikilink graph traversal** over the owned markdown.
- **Tiering for token discipline:** hot cache → master index → deep wiki (~40K baseline). Evergreen knowledge → graph; volatile/live data (project state, client meeting notes) → **pointed-to, not ingested**.
- **Session hygiene (separate concern):** context-mode handles in-session context-window protection — it is **not** a memory store of record (MEM-15). Never index canonical notes into context-mode.

**Engine choice (MEM-24, supersedes MEM-15):** the **minimal in-process stack** above — chosen over AnythingLLM at a real-machine smoke-test (2026-06-22) once MEM-23 removed the multi-workspace need that was AnythingLLM's main draw. Smoke-test passed decisively: native ORT backend on Node v26, 4/4 real-corpus queries correct, ~9–11 ms warm, ~234 MB steady RAM. Brute-force stays interactive to ~50k–100k nodes (≫ our scale); an ANN index (sqlite-vec/LanceDB) is a drop-in cache swap only if ever exceeded. NotebookLM dropped (TOOL-1); AnythingLLM + Open Notebook rejected (heavyweight app / SurrealDB+CVEs). Does not block the memory build: the store of record is owned markdown and the engine is swappable on top.

**Freshness:** owned markdown is truth, the retrieval engine is cache. Re-sync triggered post-reconciler-commit; per-document `last_synced`; queries in a stale window are flagged. (TTLs in backlog.)

---

## 8. Ingestion — capture + three modes

**Capture layer (`sources/`, MEM-14).** Each scope has a `sources/` dir: verbatim inputs — transcripts, repo snapshots, docs, pastes — frontmattered (`type · title · source · captured · session_anchor · scope · status · distilled_into · concepts/people/products`), fully search-indexed so nothing is ever invisible. **Capture = intent, no engagement gate** — everything autosaves (`/watch` autosaves here), **scope-tagged** (mechanical — from the input's origin + the session's scope; organization not security, MEM-23). The **dream judges depth** by reading (full cross-linked node / one-line stub / leave-in-raw) — reading comprehension is the filter, no engagement metric; a wrong call self-corrects (find raw by search later → next run promotes). Memory is **freely mutable; git is the undo** — no tombstone ceremony, no scheduled space-GC (MEM-14, supersedes §10's tombstone language).

**Source change detection + contradiction-must-mint (MEM-40, BUILT 2026-08-04).** Two mechanisms narrowing the truth-pass blind spot (MEM-37's contract covers only wrongness some ledger text contradicts). **(a) Window sha:** `markSourceDistilled` stamps `distilled_sha` = sha8 of the distillation window (`truncate(body, SOURCE_DIGEST_CHARS)`, one shared `distillWindowSha` helper for stamp and comparison so they cannot diverge); the nightly scan re-queues a terminal source whose window sha changed for a full re-distill, which flows through normal consolidation and supersedes stale citing nodes, with the write-back recording only live citing ids. Editing a source note is thereby a first-class supersession path. Legacy terminal sources missing a sha get a one-time sha-only backfill stamp (no judge cost); a source whose `dossier_extracted` is terminal never re-extracts entities on re-distill (duplicate-claim guard). Content beyond `SOURCE_DIGEST_CHARS` is outside the distillation window by design, for staleness detection exactly as for first-pass distill. **(b) Contradiction override:** both distill prompts receive a capped EXISTING NODES block (60 nodes by centrality, 140-char prose) plus an instruction that material contradicting a listed node MUST mint a correcting candidate, grounded only in declarative claims the material itself makes; digest, source body, source title, and the node list are all delimited as untrusted data (titles travel as a TITLE line inside the data block, never in instruction context, same treatment in the dossier extraction prompts). Supersession still happens only in consolidation; the distiller just cannot stay silent about a contradiction. Ledger: MEM-40; episode that motivated it: TOOL-13.

1. **On-demand RAG = ambient recall** — pull at query time, automatically. **[BUILT + LIVE in both brains — MEM-30, 2026-06-25.]** Knowledge/fact nodes never project (MEM-20), so this is their ONLY route back into a live session. **Automatic ambient** recall, read-only (never writes the graph — MEM-8/9), **decoupled from capture** (TOOL-6), precision-biased (silence beats noise — MEM-27), marked + killable (`COCKPIT_RECALL=off`). **Mechanics (MEM-30):** a brain-neutral core `recall.mjs` + thin per-brain readers — Claude `recall-hook.mjs` on `UserPromptSubmit→additionalContext`, Hermes `recall-hermes.mjs` on the `pre_llm_call` shell hook→`{"context":…}` (cache-safe user-turn injection). **Two-tier trigger** (evaluate cheaply every turn, inject rarely): a per-turn gate with NO model load (scope-resolves ∧ ≥3 significant terms ∧ ≥1 ripgrep candidate) fires the budgeted cosine pull only when it trips — the scope-open seed is just the first substantive turn. **Precision floor cosine ≥ 0.35** (calibrated: on-topic 0.40–0.59, noise ≤~0.21; uses `searchScored()` since RRF discards scores). **Budget** ≤4 nodes, titles+one-liners, `[[id]]` expands on demand. **Dedup** vs the §6a.4 always-load fence (`projection-state.json`) + a per-session `staging/.recall/` cursor (the only thing it writes — a dot-dir reconcile skips, NOT the graph/cache). Freshness: cache-only reads honor §7 (the reconciler keeps the cache warm; stale/changed-but-unreconciled nodes drop until re-synced). Folded in the Hermes `memory_enabled` flip (DECISIONS TOOL-6). Full spec → DECISIONS MEM-30.
2. **Proactive "dreaming"** — the nightly `--reflect` pass (MEM-29), in two halves:

   **2a. Consolidation [BUILT — MEM-27].** Reads NEW staging since last run, distills to earned depth under the MEM-18 altitude filter, then LLM-semantically **consolidates** against the existing pool (fold paraphrases / merge / supersede) and self-heals drift among existing nodes. This half is *compressive/corrective* — it dedupes and tightens; it does not connect or invent. A cheap pass first gathers the salience-flagged spans (MEM-22: errors, `#good`/`#bad`, corrections, decisions) into a digest so the expensive model judges the digest, not the raw firehose, plus a small unmarked-but-likely-salient sample so forgotten sentinels don't create blind spots. Output writes straight to canonical, gated only by the narrowed instability guard (MEM-28).

   **2b. Visionary association-surfacing [BUILT + LIVE — MEM-31, 2026-06-26; v1 = LINK-ONLY].** The *associative* half — what 2a does not do. After 2a commits the clean pool (before projection), one pass runs **cross-scope** over the whole graph and surfaces **associations between existing nodes** → the `knowledge/links.json` sidecar (§6a.5). Mechanism: pick candidate node pairs by **semantic proximity** (`searchScored()`, warm cache, no graph DB — MEM-24; proximity is the candidate source since the graph started near-unlinked), then one `judge('hard')` call per neighborhood proposes edges, each with a one-line rationale. Edges are **auto-applied — no pending-review queue** (MEM-28; grounded + reversible, git is the undo) and **touch no node bodies and no always-load layer.** Folded into `--reflect` with a saturation guard keyed on the node fingerprint **+ an edge-set hash**; budget ≤16 new links/run (calibrated up from ≤8 after the first watched runs; tunable via `VISIONARY_BUDGET`). A one-time migration ported the existing in-body links into the sidecar (§6a.5).

   **Net-new synthesis nodes (the brain inventing new knowledge from old nodes) are DEFERRED** out of v1 after a cross-family adversarial review (Codex) found they carry nearly all the risk (autonomous guesses laundering onto the always-load layer via the projection streak-timer) and little marginal value on a ~100-node graph. The recording-vs-guess distinction is the line: capture nodes record real turns (cited, `claim: fact`); synthesis nodes manufacture inferences nobody asserted. If synthesis is ever built (v2), it is hard-constrained: `type: knowledge` only, **never projection-eligible**, `source: dreaming`/`claim: inference`, depth-capped (≥2 non-dreaming backing nodes, majority-dreaming rejected), with code-enforced anti-compounding. **Full design + the deferral trail → MEM-31; sidecar wiring → §6a.5.** *(The original mode-2 spec routed all dream output to a pending-review queue at lower trust; MEM-28 retired the standing human queue — for grounded edges the provenance + git-undo substitute, and the riskier synthesis half is deferred rather than queued.)*
3. **Active elicitation ("grill me"). REMOVED per ATT-3 (2026-07-25, cut executed in MEM-38 step 8): the skill reached past the engine read path straight into `loadPool`, and it was the sole producer of the occupied part of the pending-review escalation queue; the reconciler's open-flags sweep went with it. Preserved history below.** — pull tacit knowledge *out of the human* into the identity/knowledge layer by **relentless one-question-at-a-time interviewing** (recommend an answer per question; if the codebase can answer, look there instead of asking). Checkpoint each answer to structured markdown as you go. Output = discovery nodes + key decisions + Q&A log + **open-flags** (what the human couldn't answer). Open-flags feed the reconciler's **human-escalation queue** (§5). This is the input path for knowledge that no log or resource contains. Packaged as a skill (skills dive). Pattern source: Matt Pocock's `grill-me`.

---

## 9. Logging

- **Automatic via hooks — there is no `/log` skill.** `session_end` + `pre-compaction` hooks capture the session into the scope's log/staging — **near-raw and judgment-free.** Capture *records*, it does not decide what matters. The scope stamp is derived **mechanically from session context** (which scope/project the session ran in), not by reading content. (`pre-compaction` ensures in-session observations aren't eaten by context compaction.)
- **Scope resolution + capture gate (MEM-14 clarified, 2026-06-23).** A session is captured ONLY if it resolves to a real scope, in priority: `COCKPIT_SCOPE` env → mapped cwd (deepest match first: `<repo>/scopes/<x>` → `<x>`, registered scopes only; a cwd inside the repo tree but not under `scopes/` → cockpit) → a typed **`#capture` / `#capture:<scope>`** sentinel. An **unmapped cwd is skipped** — no fabricated `global` — so autonomous agents (Hermes, ex-paperclip heartbeats) and incidental sessions in random dirs never auto-enroll. `#capture` is the in-chat opt-in (collision-free like `#good`/`#bad`, MEM-22); it captures the whole session retroactively (the cursor starts at 0).
- **Raw is the source of truth.** Any Haiku summary at capture is a **lossy convenience index, never the only copy** — Haiku here is plumbing (write the file), never judging what's worth keeping (MEM-12). If a cheap summary dropped a buried correction, the reconciler would never see it; so capture preserves raw signal.
- **All recognition + distillation is the reconciler's job** (§5, Sonnet/Opus): it reads the raw record and decides what's a durable rule/fact, frames it, dedupes, sets centrality, and promotes to CLAUDE.md/SOUL.md. Judgment is concentrated in the one place that can afford intelligence.
- **Salience signals (MEM-22).** Capture also emits cheap **mechanical** markers flagging likely-high-value moments for the reconciler to prioritize (it still makes the final call) — four categories: **keep · correction · error · decision**. **Tier 1 = explicit sentinels** the user types — **`#good`** / **`#bad`** — collision-free, deterministic, highest-confidence (the human verdict). They are **priority overrides, not gates**: reviewed first, never auto-promoted on their own, still judged by the reconciler. A `#bad` grades the agent's *behavior* in that moment, not the quality of memory recall; the reconciler treats it as behavioral feedback unless the user explicitly falsifies a remembered fact. **Tier 2 = inferred** (the structural + regex signals below), best-effort, and still active whether or not a sentinel was used. **Sentinel absence is neutral, never low-value.** The reconciler's nightly heavy pass must still surface some unmarked-but-likely-salient candidates as a safety-net sweep, so forgotten sentinels do not create blind spots. Grounded in what Claude Code exposes: **errors are structural** (`tool_result.is_error: true` / the `PostToolUseFailure` hook); **keep/correction/decision = regex over verbatim user text** (`UserPromptSubmit.prompt` or transcript `user.message.content`). Detection is pattern-matching, not judgment — consistent with dumb capture. **Detect on `Stop` (per-turn, reliable) + `PreCompact` (before context loss) + `SessionEnd`** — the last has bug #6428 (doesn't fire on `/clear`), so never rely on it alone. Test failures + ESC interrupts are NOT structurally flagged → best-effort only. Affect/tone signals = deferred (feedback-mining mode).
- **Log files = the chronological SOURCE layer** under the graph (append-only diary; never rewritten). The reconciler **ingests** them and distills durable facts up into the graph.
- **Scope-aware + shared:** one timeline per context that **both Hermes and Claude** append to (replaces the old hardcoded `{CWD}/log/`).
- **Ad-hoc "note this"** = an agent writing to the scope log file directly — no dedicated skill.
- Session heartbeat lets the reconciler tell a live session from a dead one (missed-flush handling).

---

## 10. Self-improvement & GC

- Reconciler rewrites-on-ingest (fact-check → cross-link → rewrite) — the graph improves over time.
- **GC** = reconciler judgment **+ hard character-caps backstop** (mechanical, forces summarization even if the reconciler hasn't run). Session-anchor flags throwaway one-offs.
- **Forgetting = relevance decay, not deletion (MEM-33, refines this section).** The record is append-only; **relevance is a separate mutable, disposable overlay** — a recomputed **`.reconciler/relevance.json`** sidecar (same pattern as MEM-31's `links.json`, but **outside `knowledge/`** so it never trips the reconciler's dirty-tree guard). "Forgetting" lowers salience (dormant nodes need a higher recall score; superseded nodes leave default recall but stay readable via their chain); it never deletes history, decisions, or the evidence a belief changed. Pins (`type: identity`, projected nodes, an explicit top-centrality cut) are decay-exempt; **centrality otherwise modulates the decay *rate*, not a floor** (a floor pinned the median node and decayed nothing — Codex review 2026-07-01). Runs on its **own slower clock** (weekly + manual), sharing engine code but decoupled from the nightly distiller; recomputes the sidecar only, never mutating a node. Losing the overlay loses zero truth. **v1 is shadow/measure-only** (computes + reports, does NOT influence live recall selection). Status = DESIGNED, spike-next.
- **Supersede vs delete (MEM-14).** *Supersede* (keep, mark not-current via the `superseded` flag, stays searchable, relevance dropped) is the default curation move and pairs with decay above. *Delete* (drop from live graph, git keeps history) is a rarely-needed last resort — git is the undo, no tombstone ceremony. Deletion aggressiveness = runtime policy, deferred (OPEN-2). **Archive** (relocate cold material out of the hot working set into a cold store — still in git, provenance intact, excluded from default walks, reversible) is the clutter-removal move that is *not* deletion; it is driven by closure/graduation (ATT-1).
- **Observability:** reconciler emits a per-run audit diff (added/modified/deleted/held + reason codes); human-readable digest on demand.
- **Truth pass (MEM-37, BUILT 2026-07-21; `truth-pass.mjs`, called from `--reflect` before the Phase-1 commit so mutations ride the knowledge/ transaction; runs even when the reflect cost-guard freezes a scope).** Nightly tempo asking "is this node still true": a **T1 deterministic tier** first (backticked/absolute/`~` paths via `fs.access`, binaries via `command -v`; config-key checks deferred), then a budget-bounded **judge tier** (25 calls/run: delta lane 15, rotation 10) only for T1-missing, delta-lane, or already-quarantined nodes, checked against the scope's DECISIONS.md. Judging is **single-node per call, cross-family two-pass** (eval-locked 2026-07-21 on labeled fixtures, `truth-eval.mjs` + `truth-eval-fixtures.json`): batching measured ~half the recall for both families and was dropped; the sweep pass (first detection) uses the gpt-5.5 adapter (recall-optimized, ~85% per sweep), the confirmation pass (promotion) uses the Claude adapter (precision-optimized, zero false confirms measured), with Claude fallback if the sweeper is unavailable. Auto-action needs **triple agreement**: judge conflict verdict + quoted span string-matching the current ledger + cited entry live (a quote from a superseded entry counts only inside its `**Superseded:**` note; active "supersedes X" headings are live; `OPEN-n` bullet entries are matched in bullet form). Lifecycle: first agreement stamps **`ledger_conflict: confirmed`** (quarantine, node stays recallable); promotion to `superseded` needs a second confirmation on a later UTC day and routes always-load-eligible nodes through the MEM-28 guard (escalations → `pending-review/`). The flag is **sticky**: disagreeing later passes increment a counter, never clear it; consolidation round-trips it untouched. **Two queues**: full-graph T1 every night (all scopes, all live nodes; fs checks only) + a ledger-delta lane (25 nodes/night per scope whose DECISIONS.md changed; progress is a per-sweep judged-set of node ids, the sweep completes only when every live node is in the set; the ledger is diffed per `###` entry by sha8, only changed/new entries trigger and they are prepended to the judge excerpt; a first-ever sweep with no entry baseline is the full historical audit, runnable supervised via `truth-pass.mjs --audit`). Per-scope DECISIONS.md exists only for cockpit; other scopes are T1-only. Companion pieces: **capture ledger guard** (distill candidates contradicting a live decision normatively are rewritten "Evaluated and rejected", never dropped; historical claims mint normally), **`claim: reported` tier** (`src:`-cited mints are attributed in recall, never projection-eligible, truth-pass-exempt; a `stg:`-cited fact never downgrades), and the **MEM-33 Phase-2 recall hit-log** (append-only `memory/.cache/recall-hits.jsonl`, best-effort, gitignored).

---

## 11. Reconciling the 3 prior systems

No rivalry — roles assigned (MEM-15):
- **Claude Code file memory + Hermes memory** → collapse into the **identity layer** (soul.md + per-scope identity).
- **Retrieval** → the minimal in-process stack (MEM-24) over one shared graph (MEM-23 — no per-vault workspaces).
- **context-mode** → **session hygiene only** (in-session context-window protection), never a store of record. Its keyword KB / auto-memory is not canonical.
- **NotebookLM** → dropped entirely (TOOL-1).

**Clean start — no legacy migration (MEM-15).** The new graph starts empty. All auto-learned memory (context-mode's auto-prefs, incidental native `MEMORY.md` entries) was made under the old/wrong setup → untrusted, discarded, not folded. Only deliberately hand-authored, currently-correct notes carry forward, by hand. The first build pass is the **salvage audit (BUILD-3)** across all memory substrates + `CLAUDE.md` files; any deliberately-kept memory file folds into it.

---

## 12. Multi-agent fleet

- **Builder + operator fleet:** Claude Code (singular builder) + Hermes (a *class* of capability-agents). Both + their Sonnet/Haiku subagents read+write the one substrate.
- **Coordination = shared substrate + the human** (stigmergic), and it outlives any individual agent because knowledge, decisions, and rules live outside them. A VPS-level orchestrator manages the box and spawns and manages sessions on it, but it owns no part of the substrate (OM-13). Two distinct surfaces (do not conflate — ATT-1, 2026-07-01): (a) a **human-attention board** = a read-time, ephemeral advisor *derived* from project state + a decision-log (not a task DB, not a source of truth); (b) an **agent↔agent work-bus** = the live-work handoff between agents needing write-locking + a work-packet/receipt protocol (backlog, OPEN-3/4). The memory substrate stores durable knowledge; neither board owns project truth (projects do).
- **Model routing:** Opus orchestrates; Sonnet executes (research/bulk/edits); Haiku does mechanical/git-plumbing. Each skill carries its own model binding.

---

## 13. Build backlog (non-blocking specs to finalize during build)

- Retrieval-engine **re-sync TTLs** (triggers post-reconciler-commit).
- `schema_version` **migration functions** (keyed `from→to`, in-repo, tested, lazy on read).
- Reconciler **audit-diff + tombstones** (observability).
- ~~Dreaming **token/node budget + pending-review queue**~~ — **RESOLVED 2026-06-26 → MEM-31** (v1 = link-only association-surfacing: ≤8 links/run budget; NO pending-review queue — grounded edges + git-undo, MEM-28). Net-new synthesis deferred (carries the risk; descoped after the Codex adversarial review). **BUILT + LIVE 2026-06-26** (`visionary.mjs`/`links.mjs`; ≤16 links/run as built).
- ~~**Projection gate determinism**~~ — **RESOLVED 2026-06-23 → MEM-20 amendment + §6a.4** (three-layer fence: human skeleton + auto-graduating Durable + sticky Emerging; counter-driven promotion, deterministic node-state demotion; quorum reserved as the escalation). Built + verified end-to-end.
- Session **heartbeat** for dead-session detection.
- Staging **growth cap** (block + warn, never silent drop).
- Shared **Kanban board write-locking** + agent work packet / receipt protocol (OPEN-3/4).
- ~~**Cold-start** bootstrap sequence~~ + ~~exact scope **directory paths**~~ — **LOCKED 2026-06-22 → §6a.3** (idempotent bootstrap, seed-live-scopes, append-only mode, INDEX.md).
- **Hybrid-retrieval merge function** (MEM-19, from agentmemory grading): §7 leaves *how* the ranked lists combine unspecified. Where WE own the merge (engine semantic results × wikilink-traversal results), fuse the already-ranked lists with **RRF — reciprocal rank fusion, k=60** (standard rank-list fusion). Does NOT violate "buy retrieval": the engine still owns embeddings/vector retrieval internally; we only re-rank *across* the lists it returns. Sole requirement on us: each node carries clean distilled prose (the engine ingests it) — we build no vector index ourselves.
- **Identity-node naming — already settled by §3** (node = TYPE × SCOPE grid cell); do NOT adopt agentmemory's flat 8-slot list wholesale — it's the single-axis model §3 rejected, and most slots aren't identity anyway (`tool_guidelines`→skills `## Rules`; `project_context`→§7 volatile/pointed-to; `pending_items`→Kanban/log; `session_patterns`→§8 dreaming output). At most cherry-pick `persona · user_preferences · guidance` as sub-fields *inside* an identity node. Reference only, low priority.

---

## 14. Explicitly deferred (other deep dives)

- **`~/CLAUDE.md` orchestration** — the auto-loaded layer; how CLAUDE.md ↔ STATE ↔ graph ↔ soul.md cross-reference without bloat. Its own deep dive. *(The memory→CLAUDE.md projection mechanism is now decided — MEM-20, §5; the rest of the orchestration stays deferred.)*
- **Tools layer** — MCP/tool topology per brain.
- **Skills layer** — `<repo>/skills/` structure; self-improving skill `## Rules` block; `/watch` visual-ingestion evaluation.
- **Harness auto-upgrade from failures (OPEN-10).** **[2026-07-29]:** OPEN-10 was resolved and the harness-proposals system (`doc-proposals.mjs`) was designed, built, then REMOVED per ATT-3 (2026-07-25, §6a.8d / line 1053) — it is not a live system. Future harness maintenance that consumes memory signals (failures, corrections, `#bad`, repeated tool errors) stays a deferred, separate patch+verification system — not ordinary node consolidation or nightly dreaming.
- **OKF-compatible exchange mapping.** Google Cloud's Open Knowledge Format validates Cockpit's markdown+frontmatter substrate, but OKF is an interoperability/export surface, not the internal schema. Defer a mapper until there is a real need to publish, exchange, or ingest external OKF bundles; likely mapping: Cockpit node id/path → OKF concept id, node title/prose/tags/timestamps → OKF fields/body, Cockpit-specific `scope`/`audience`/`claim`/`centrality`/projection fields retained as extension frontmatter or omitted on export by profile.
- **Hermes↔Claude handoff interface / agent work queue protocol** — board-backed task packets for live work movement, separate from memory storage (OPEN-3/4).
- **Token-optimization** — treated as a cross-cutting thread applied in every layer, not a standalone dive.
