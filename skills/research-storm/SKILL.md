---
name: research-storm
description: Faithful Cockpit port of Stanford's STORM research method (per-topic personas -> grounded interviews -> cited article). Use when a research question is substantial enough to warrant a multi-perspective, cited pass feeding a real decision or durable write-up. Claude and Hermes should PROACTIVELY PROPOSE this skill whenever a research ask looks like a good fit -- but always confirm before running, since it dispatches a real multi-agent Workflow with real time/token cost.
version: 3.0.0
model: opus
triggers: ["storm research", "storm article", "research this topic", "deep research"]
tags: [research, workflow, multi-agent]
allowed-tools: Workflow
metadata:
  hermes:
    tags: [research, propose-only]
    platforms: [linux, macos]
---

## Purpose
Faithful port of Stanford's **STORM** algorithm (Shao et al., NAACL 2024 —
`arxiv.org/abs/2402.14207`; codebase `github.com/stanford-oval/storm`) onto Cockpit's
Workflow tool: turn one topic into a cited, Wikipedia-style article by discovering
topic-specific research perspectives, simulating grounded interviews from each, then
outlining and drafting from the pooled research.

> Provenance: ported directly from the real `knowledge_storm` pipeline
> (`persona_generator.py`, `knowledge_curation.py`, `outline_generation.py`,
> `article_generation.py`, `article_polish.py` — read 2026-07-06), not from the informal
> "5 fixed personas + adversarial peer review" gloss in the video that surfaced this
> ("Stanford's method turns Claude into a PhD-level research team").
> That video's reliability-scoring / confirmed-corrected-demoted layer does not exist in
> real STORM — it was the creator's own addition, and is deliberately NOT reproduced here.

## What this is NOT (read before assuming anything)
- **Not adversarial peer review.** Real STORM never has personas or agents challenge or
  score each other. There is no "contradiction map," no confirmed/corrected/demoted
  verdict, no reliability score. If you want adversarial verification of a claim, that's a
  separate, general Cockpit pattern — layer it on deliberately, don't assume it's part of
  this pipeline.
- **Not a fixed cast.** There is no standing "practitioner/academic/skeptic/economist/
  historian" panel. Personas are *generated per topic* from real related-topic research
  (see stage 1) — a different topic yields different personas.
- **Not agent-to-agent debate.** Each persona runs its own independent two-role interview
  (persona-as-writer asking, an expert-role answering). Personas never see or respond to
  each other; they only converge later when their transcripts are pooled for outlining.

## Mechanical adaptations (labeled — algorithm intent preserved, implementation differs)
Cockpit has no Wikipedia-scraper, no embedding index, and no way for one Workflow agent
call to literally alternate turns with another mid-conversation. Four adaptations follow
from that, all in `workflow.mjs`:
1. **Persona-discovery corpus:** source surveys *other Wikipedia pages'* tables of
   contents; this port surveys web-search results for overviews of closely related topics.
2. **Interview mechanic:** source alternates two distinct LM roles (WikiWriter asks,
   TopicExpert answers) turn by turn via the orchestrator. This port runs **one agent per
   persona** that internally executes the same capped, grounded loop (ask → real web
   search → answer-from-snippets-only-or-refuse → repeat) — behaviorally equivalent
   (same cap, same no-hallucinate rule), mechanically simpler since `agent()` is already a
   full tool-using agent, not a bare completion call.
3. **Per-section retrieval:** source retrieves top-k snippets per section via an embedding
   index (`retrieve_top_k`). This port has no vector store, so each section-writing agent
   reads the full pooled research and does its own relevance judgment instead.
4. **Citation unification:** source assigns one global per-URL citation number from its
   shared embedding-retrieval index, so every writer already cites consistently -- no final
   remap needed. This port has no such index (each interview names its own local citation
   numbers), so it builds the same shared per-URL numbering itself, once, immediately after
   interviews complete, and rewrites each transcript's inline markers to match before
   anything downstream reads them -- consistent by construction, same *outcome* as the
   source's deterministic remap. **Fixed 2026-07-07** (was: one final LLM pass tried to
   rewrite the entire draft article to fix inconsistent numbering after the fact -- see
   below).

## When to use
User explicitly asks for STORM research, **or** you (Claude or Hermes) judge a research
ask is substantial enough that a cited, multi-perspective pass would clearly beat a single
WebSearch/WebFetch lookup — feeding a real decision or a durable write-up, not a quick
lookup. In the second case, **propose it and wait for confirmation before running** — this
dispatches a real multi-agent Workflow (4+ interview agents, one agent per section, several
search rounds): real time and token cost, not something to fire silently.

**Hermes note:** Hermes shares this skill file but the Workflow tool is a Claude Code
capability — if Hermes recognizes a good fit, it should propose running `research-storm`
to the operator (who then has Claude Code execute it), not attempt to run the pipeline itself.

## Invocation
The pipeline is a real saved script, not improvised each run:
```
Workflow({ scriptPath: "~/cockpit/skills/research-storm/workflow.mjs", args: { topic: "<topic>", depth: "standard" } })
```

**Depth presets** (`args.depth`, default `standard`) — pick before running; ask the user if
unclear which fits:

| depth | personas | conv turns | queries/turn | search top-k | max sections |
|---|---|---|---|---|---|
| `quick` | 1 (discovery skipped — source's real `disable_perspective` flag) | 2 | 2 | 2 | 4 |
| `standard` | 4 (source defaults exactly) | 3 | 3 | 3 | 8 |
| `deep` | 7 | 4 | 4 | 4 | 18 |

`maxSections` is a **Cockpit-only cost control**, not in the original algorithm (real STORM
never bounds outline size) — added because section count is what actually drives agent
count and cost (a `standard`-persona run with an unbounded 15-section outline cost ~1.03M
subagent tokens / ~50 min / 25 agents in the first smoke test). Any individual knob
(`maxPerspective`, `maxConvTurn`, `maxQueriesPerTurn`, `searchTopK`, `maxSections`,
`disablePerspective`, `dedupThreshold` — default 6000 chars) can still be passed directly
to override its preset value.

Returns `{ topic, depth, article, personas, sectionTitles, interviewCount, sectionCount }`;
`article` is the final markdown — write it yourself to
`artifacts/research/<topic-slug>-<date>.md` (Workflow scripts have no filesystem access,
so the save happens outside the script, in the invoking session).

**Known gap (found in the first smoke test, 2026-07-06) — fixed 2026-07-07:** the final
citation-unification step used to be one LLM agent call, last in the pipeline and a single
point of failure — if it errored (e.g. a session/quota limit), the returned article fell
back to un-unified, section-locally-numbered citations and no `## References` list.
Citations are now made globally consistent right after the Interviews stage (one shared
per-URL number, baked into every transcript before pooling/outline/drafting ever read it),
so the final unification is a **deterministic compaction pass in plain code, not an agent
call** — no cost, no quota/session failure mode. Codex-reviewed 2026-07-07: caught and
fixed one high finding (lead paragraph citations were compacted separately from the body,
leaving lead on stale pre-compaction numbers — fixed by compacting lead+body together) and
one medium finding (an invented/unmapped citation marker was silently dropped from
References with no signal — fixed by logging a warning naming the stray marker(s)).
Unit-tested against synthetic cross-persona local-numbering collisions, an
unused-citation compaction case, and a stray-marker case; not yet re-run through the full
live pipeline (that costs real time/tokens — confirm before re-running the smoke test).

## Algorithm reference — the 4 stages, faithfully

### Stage 1 — Persona discovery (`persona_generator.py`)
1. One agent identifies closely-related existing topics/pages for the given topic (the
   real algorithm's `FindRelatedTopic`) and pulls their section structure (real: scrapes
   Wikipedia ToCs via `get_wiki_page_title_and_toc`; port: WebSearch + WebFetch for
   comparable overview pages/articles).
2. One agent proposes personas from those examples (`GenPersona`): "a group of editors who
   will work together... each represents a different perspective, role, or affiliation...
   add a description of what they will focus on."
3. **Always prepend a default "Basic fact writer"** persona (broad basic-facts coverage) —
   this is in the source, not an addition. Cap additional discovered personas at
   `max_perspective` (source default: **3**, so 4 total by default). Configurable per run.

### Stage 2 — Knowledge curation via simulated conversation (`knowledge_curation.py`)
Run **in parallel, one independent conversation per persona** (`parallel()` — personas
never interact):
- **WikiWriter** (the persona) asks one focused question at a time, grounded in the
  conversation so far; ends the interview by saying "Thank you so much for your help!" —
  cap at `max_conv_turn` (source default: **3** questions).
- **TopicExpert** (the answering role), per question: breaks it into up to
  `max_search_queries_per_turn` (source default: **3**) search queries → runs them via
  real web search → takes the top `search_top_k` (source default: **3**) results per
  query → answers **only from retrieved snippets**, with inline `[n]` citations. If
  nothing relevant is found: **"I cannot answer this question based on the available
  information"** — never hallucinate an answer.
- Collect each persona's full dialogue transcript. This set of transcripts *is* the
  research — nothing is scored or ranked yet.

### Stage 3 — Outline generation (`outline_generation.py`)
1. One agent drafts a **naive outline first, from parametric knowledge alone, no search**
   — headers only (`#`/`##`/`###`), no topic name repeated, no body text.
2. One agent **refines that draft outline** using the full pooled set of every persona's
   conversation transcript from stage 2 (concatenated together, not per-persona) to produce
   the final, informed outline.

### Stage 4 — Article generation + polish (`article_generation.py`, `article_polish.py`)
1. For **each top-level outline section** (skip any literal "Introduction" or
   "Conclusion"/"Summary" section — handled separately in the polish pass), **in
   parallel**: retrieve the most relevant snippets for that section from the full stage-2
   research pool, then write the section with proper inline numbered citations `[n]`
   (source's `WriteSection` instruction — one agent per section, independent).
2. **Lead/summary section**: one agent writes a concise overview (≤4 paragraphs) of the
   full drafted article, cited, prefixed `# summary`.
3. **Optional dedup pass**: one agent removes repeated information across sections,
   preserving structure and every citation exactly (only when the draft is long enough
   that duplication is plausible — this is opt-in in the source too, `remove_duplicate`).
4. **Citations**: unify citation numbering globally across the whole article by first
   appearance (same URL always gets the same number), and emit a numbered references list
   at the end mapping `[n]` → source URL.

## Output
A single markdown file: `# summary` lead section, then the outlined sections in order,
cited inline, then a `## References` list. Save to
`artifacts/research/<topic-slug>-<date>.md`. If it informs a locked decision, add a
pointer from the relevant `decisions/<topic>.md` (no standalone research archive
otherwise — matches the existing "research earns a home by becoming a decision" rule).

## Rules
1. Do not add adversarial review, contradiction mapping, or reliability scoring to this
   pipeline — those aren't STORM. If a task actually needs adversarial verification, use
   that as a separate step explicitly, not folded silently into "storm research."
2. Every section-level and interview-level claim must trace to a retrieved snippet with a
   citation. An expert-role answer with no supporting snippet must refuse, not hallucinate.
3. Personas are generated per-topic (stage 1) — never hardcode a fixed persona list.
4. Real cost — don't invoke for a quick lookup; reserve for research feeding an actual
   decision or durable write-up.
5. Co-STORM (the collaborative, human-in-the-loop discourse + mind-map extension from the
   same repo) is out of scope for this port — this covers STORM only.
6. **Proactive but not silent.** When a research ask looks like a good fit, propose running
   `research-storm` and say why — never dispatch the real Workflow without confirmation.
