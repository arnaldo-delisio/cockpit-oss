---
name: teach
description: Turn Claude into a stateful personal tutor — build and maintain a per-topic teaching workspace (mission, resources, glossary, learning records, lessons) so learning about a topic survives and builds across sessions instead of resetting each time. Use when the human says "teach me", "/teach", "I want to learn", or names a topic they want to learn over time (not a one-off explain-this question).
version: 1.0.0
model: opus
triggers: [teach me, teach, /teach, I want to learn, learn about, start learning]
tags: [learning, tutoring, pedagogy, stateful, workspace]
allowed-tools: Bash Read Write Edit WebSearch WebFetch
metadata:
  hermes:
    tags: [learning, tutoring, pedagogy]
    platforms: [linux, macos]
---

## Purpose
Adapted from Matt Pocock's `teach` skill (`github.com/mattpocock/skills` →
`skills/productivity/teach/`, MIT), surfaced via the `/watch` skill from a video
walkthrough of it ("I tried teach and 10x'd my ability to learn").
Reworked for Cockpit's scope/file conventions and a hard boundary the source never needed:
**pure workspace files, never the memory graph** (see Rule 1).

This is a **stateful, multi-session commitment**, not a one-off "explain this to me." A teaching
workspace accumulates a mission, curated resources, a glossary, dated learning records, and a
sequence of self-contained lesson files — so each session picks up exactly where the last one left
off instead of re-deriving context or hallucinating past a full window.

## Workspace
Root: `~/learning/<topic-slug>/` (dash-case slug of the topic) — **top-level, deliberately outside
both the repo tree and its `scopes/` workspaces.** This is not a style choice: Cockpit's ambient session capture
(`memory-engine/capture-core.mjs`'s `mappedScope()`) auto-stages *any* session run with a cwd under
`<repo>/scopes/<x>` (→ scope `<x>`) or the repo tree (→ scope `cockpit`) into that scope's memory
`staging/`, regardless of which skill is active. An unmapped cwd is the only one `mappedScope()`
returns `null` for — the only ground where "pure workspace files, never the memory graph" (Rule 1)
is actually true rather than just asserted. Do not default a teaching workspace under the repo `scopes/` tree for
this reason, even for a venture-specific topic.

One topic = one workspace; never fold a second, unrelated topic into an existing one (make a new
`<topic-slug>/` instead).

Inside the workspace:
- `MISSION.md` — why the human is learning this; format → `MISSION-FORMAT.md`.
- `RESOURCES.md` — curated high-trust sources (Knowledge) + communities (Wisdom); format → `RESOURCES-FORMAT.md`.
- `GLOSSARY.md` — canonical terms, added only once genuinely understood; format → `GLOSSARY-FORMAT.md`.
- `learning-records/NNNN-<slug>.md` — dated, sequential, ADR-style insight log; format → `LEARNING-RECORD-FORMAT.md`.
- `lessons/NNNN-<slug>.html` — one self-contained HTML lesson per file, the primary teaching unit.
- `assets/` — shared components (stylesheet, quiz widgets, diagram helpers) lessons reuse instead of re-inlining.
- `NOTES.md` — scratchpad for stated teaching preferences ("go slower", "less math", "more code").

## Philosophy
Deep learning needs three things, in this order of a session's attention:
- **Knowledge** — pulled from high-trust resources, never parametric guessing. For acquisition, difficulty is the enemy: minimize friction while explaining.
- **Skills** — built through interactive, tightly-scoped practice tied to the knowledge just given. For skill-building, difficulty is the tool: effortful retrieval (recall, not recognition), spacing, interleaving.
- **Wisdom** — comes from real interaction with other practitioners. Attempt to answer wisdom-shaped questions yourself, but default to pointing at a real community rather than trying to be the human's only source of truth forever.

**Zone of proximal development.** Every lesson should feel challenged "just enough" — not so easy the
human is bored, not so hard they want to quit. Determine this from `learning-records/` (what they've
already demonstrated) weighed against `MISSION.md` (what the goal actually needs), not from a cold
guess each session.

**Fluency vs. storage strength.** Fluency (can retrieve it right now, in the lesson) is not the goal —
storage strength (still there in a month) is. Design practice around retrieval, spacing, and
interleaving rather than re-reading/re-exposure, which only buys illusory fluency.

## Procedure
1. **Resolve the workspace, then look before doing anything else.** Slugify the topic; check whether
   `~/learning/<topic-slug>/` (or a close variant) already exists. If it does, resume — read
   `MISSION.md`, `RESOURCES.md`, `GLOSSARY.md`, `NOTES.md`, the latest `learning-records/`, and
   existing `lessons/` before asking the human anything or writing a new lesson. Never create a
   duplicate workspace for a topic that already has one.
2. **First run only: establish the mission.** If `MISSION.md` is missing or thin, interview the human
   per `../references/question-craft.md` (the shared questioning doctrine that `/questions` also
   uses) on *why* they want this, until you can write a concrete, non-abstract mission per `MISSION-FORMAT.md`.
   A bad mission is worse than no mission — push back on vagueness rather than writing one anyway.
3. **Gather resources before teaching.** Check both `<repo>/scopes/writing/knowledge/{concepts,people,case-studies}/`
   and external sources (WebSearch/WebFetch for primary docs, recognized experts, peer-reviewed work)
   and high-reputation communities. An existing verified entry there is one source among equals, not
   ranked above or below a fresh external one. Write all of it into `RESOURCES.md` grouped Knowledge /
   Wisdom, each annotated with what it's for. Never substitute parametric memory for a cited source.
   Note explicit gaps rather than leaving silence.
4. **Determine the next lesson from the zone of proximal development**, then build exactly one:
   `lessons/NNNN-<slug>.html`, self-contained, beautiful/Tufte-style typography, reusing (not
   re-inlining) components from `assets/` — write a new shared component there the first time a
   second lesson would need the same thing. Every lesson: cites a primary source, ties back to the
   mission, gives one tangible win sized to working memory, ends with a nudge to ask follow-up
   questions, links to related lessons/reference docs. Try to open it for the human after writing
   (`xdg-open`/`open`, best-effort).
5. **Split knowledge from practice inside the lesson.** Explain with minimal friction first; then make
   the human *do* something effortful (retrieval-practice question, real-world step, quiz) with tight,
   ideally automatic feedback — not just re-reading.
6. **Write a learning record only on real evidence**, never because material was merely covered:
   the human demonstrably used a concept correctly, disclosed prior knowledge worth not re-teaching,
   corrected a misconception, or the mission shifted. Sequential `learning-records/NNNN-<slug>.md`,
   format → `LEARNING-RECORD-FORMAT.md`. A contradicted earlier record gets marked superseded, not
   deleted — the arc of understanding is itself signal.
7. **Promote terms to the glossary once owned**, not once introduced — tight, opinionated definitions
   per `GLOSSARY-FORMAT.md`; once a term is canonical, every later lesson/record uses that exact word.
8. **Point toward a community when the question needs lived experience**, not more explaining — pull
   from `RESOURCES.md`'s Wisdom section. If the human opts out of communities, record that in
   `NOTES.md` and stop re-suggesting.
9. **Record stated teaching preferences in `NOTES.md`** as they come up, and read it at the start of
   every session so a preference doesn't have to be repeated.

## Rules
1. **Pure workspace files — never the memory graph.** No `staging/` write, no reconciler involvement
   (MEM-8/9 untouched); this workspace is a self-contained artifact tree, the same boundary
   `research-storm` draws around `artifacts/`. This depends on the workspace root staying outside
   the repo tree and its `scopes/` workspaces (see `## Workspace`) — ambient capture is cwd-driven, not skill-aware,
   so it would apply regardless of what this skill itself writes. If durable cross-scope knowledge
   genuinely belongs in memory later, that is a separate, deliberate design change — not a default of
   this skill.
2. **One mission per workspace, resume don't duplicate.** Always check for an existing workspace by
   topic slug before creating a new one.
3. **Coverage isn't learning.** Only write a learning record on demonstrated evidence, never because a
   lesson merely covered the material.
4. **Cite real sources.** Every non-trivial claim in a lesson traces back to something in
   `RESOURCES.md`; never trust parametric knowledge as a stand-in for a real source.
5. **Reuse `assets/` before writing new lesson markup**; don't let lessons drift into inconsistent
   styling.
6. **One lesson at a time**, sized to the actual zone of proximal development — derived from
   `learning-records/` + `MISSION.md`, not guessed fresh each session.
7. **Glossary entries are opinionated and canonical** — pick the term, list the rest as aliases to
   avoid, and reuse it everywhere afterward, including inside other definitions.
8. **Confirm before changing `MISSION.md`.** Missions evolve; silently rewriting the compass does not.
9. **Respect an explicit opt-out from communities** — don't keep re-suggesting them.
10. **User-invoked only.** This is a deliberate multi-session commitment Claude never
    starts unprompted — it activates on an explicit ask to learn something over time, not on every
    question that happens to be educational.
11. **No self-upgrade `LEARNED.md` for v1.** Teaching-craft correction signal hasn't accumulated yet
    (skills/README.md's self-upgrade bar: subjective, durable, measurably-corrected). Revisit only if
    real use surfaces a consistent correction pattern worth persisting.
12. **`writing/knowledge/` is one source among equals, not a priority tier.**
    `<repo>/scopes/writing/knowledge/{concepts,people,case-studies}/` holds the author's own vetted research
    material — check it alongside external search and cite it the same way you'd cite any other
    verified source, no ranking above or below. This is a one-way read: a learning workspace never
    writes back into `writing/knowledge/` directly. Promotion the other direction happens only when
    the author deliberately decides something learned is worth verifying and citing in writing — same
    gate as any other source, not automatic.
