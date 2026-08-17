# skills/

Cross-brain shared skills — the subset both Claude Code (builder) and Hermes (operator) load from a single source of truth.

Hermes-only operational skills stay in `~/.hermes/skills/`. Project-specific skills stay in `<repo>/scopes/<project>/.claude/skills/`.

---

## Skill hierarchy

| Tier | Location | Scope | Brains |
|------|----------|-------|--------|
| Cross-brain shared | `<repo>/skills/` | Global | Both |
| Hermes native | `~/.hermes/skills/` | Global | Hermes only |
| Project-specific | `<repo>/scopes/<p>/.claude/skills/` | Project | Claude Code only |

Hermes has no per-project skill scoping — project context switches via SOUL.md sections.

---

## How each brain loads these skills

The manifest (`skills.json`, below) is the authoritative loader: `memory-engine/bootstrap.mjs` provisions each `core` skill per box by symlinking it into `~/.claude/skills/` and (when present) `~/.hermes/skills/`.

Manifest provisioning is the only supported path. A whole-dir `SessionStart` hook symlinking `<repo>/skills/*` → `~/.claude/skills/`, or a Hermes `external_dirs: [<repo>/skills]` block in `~/.hermes/config.yaml`, are retired alternatives; do not wire either.

Build gate: run `hermes update` before wiring either side.

---

## Fleet manifest (`skills.json`)

`skills.json` lists tiers: `core` (every machine, both brains), `optional` (installed on
demand), plus a `requires` map of binaries/env keys per skill. `memory-engine/bootstrap.mjs`
provisions core skills by symlinking each into `~/.claude/skills/` and (when present)
`~/.hermes/skills/`; `provision/install.sh` installs the binaries core skills need.
Bootstrap also prunes manifest-owned symlinks for skills that left the manifest entirely,
and warn-checks `~/.hermes/config.yaml` wiring (`external_dirs` at `~/.hermes/skills`, the
capture and recall hooks) without writing it.

Machine-local skills (`record` on the laptop; `dream`) live outside the repo in the machine's
own skill dir and are wired by hand, never provisioned by the manifest. `screenshots` was
retired 2026-08-17 (TOOL-11 amendment): the Claude Code phone app takes screenshots directly.

---

## Skill file structure

```
<repo>/skills/<name>/
  SKILL.md        ← instructions (what both brains read)
  <script>.py     ← supporting script if needed
```

## SKILL.md format

```markdown
---
name: slug
version: 1.0.0
model: sonnet|haiku|opus|deepseek-v4-flash|…
triggers: [phrase1, phrase2]
tags: [tag1, tag2]
---

## Purpose
One line.

## Procedure
Step-by-step. Each brain executes what applies to it.

## Rules
1. Numbered behavioral imperatives.
2. Hard cap: 10–15 entries. No timestamps.
3. Reconciler-only promotion until reconciler is built.
```

`## Rules` accumulates per-run lessons via the reconciler (staging-first). Static/human-curated until reconciler exists. Bloat hits Claude Code harder (full file loads as prompt) — enforce the cap.

Authoring conventions:

- Skill triggers live in each skill's own `SKILL.md` (the `triggers:`/`description` frontmatter), never in the shell docs: shells stay trigger-free, skills stay self-describing.
- Before inventing a launch procedure for a project's app, check the project's skills first: a project skill documenting the verified launch path wins over ad-hoc guessing.

---

## Self-upgrade pattern (`LEARNED.md`) — optional, opt-in per skill

`/taste` carries a `LEARNED.md` that a hook reads on invocation and rewrites with distilled user feedback at session end (`taste/taste-hook.mjs`, wired in `~/.claude/settings.json`). This is a **pattern, not a default**. It earns its cost (a `PreToolUse` + `SessionEnd`/`PreCompact` hook, a Groq call, and a file to maintain) only when **all** of:

- the skill makes **subjective / taste judgments** the user corrects in a consistent direction;
- those corrections are **durable and reusable** across future runs (not one-off facts);
- accumulated preference **measurably changes output quality**.

**Skip it** for mechanical/deterministic skills (transcription, screenshots, git plumbing, file generation) and for skills that already feed the central memory/reconciler — don't duplicate the memory layer. **Default = no self-upgrade.**

Current shared self-upgrading skills: `taste`, `questions`, `write`, and `day` qualify (`write` folds feedback into `LEARNED.md` via `write-hook.mjs`; `day` learns calendar routing, which is both subjective and the one thing that must never be hardcoded in a public skill). `watch` / `session-handoff` are mechanical; `record` is machine-local (TOOL-11), not shared. Re-check this criterion when adding any new skill.

---

## Skills in this directory

| Skill | What it does |
|-------|--------------|
| `watch/` | Transcript capture from local media, YouTube, or any yt-dlp-supported URL, autosaved to the scope's `sources/` |
| `taste/` | Prevention-first frontend design guidance plus a self-upgrading `LEARNED.md` and a linter |
| `history-search/` | Cited FTS5 search and readable rendering (`show`/`list`) over past raw agent sessions, with an ambient `UserPromptSubmit` hook (TOOL-8) |
| `codex-review/` | The reviewer lane Claude can actually invoke: prompt by file plus stdin (never a shell argument), exit 0 reviewed / 2 ran but unusable / 3 did not run (TOOL-7) |
| `teach/` | Stateful personal-tutor workspace (mission, resources, glossary, learning records, lessons), adapted from Matt Pocock's `teach` skill; plain workspace files, deliberately outside the memory graph |
| `questions/` | Outward questioning: design, and optionally conduct, a sequenced behavior-anchored question set; self-upgrading `LEARNED.md` |
| `day/` | Personal todos and appointments that no project owns, stored only as Google Calendar events (all-day + free for todos, `☐`/`✓` for state); self-upgrading `LEARNED.md` holds the calendar routing. Optional tier: it drives the `mcp__claude_ai_Google_Calendar__*` connector, so it runs in a Claude Code session with that connector authorised and not from Hermes |
| `write/` | Draft and rewrite posts in the owner's voice; self-upgrading `LEARNED.md` plus an AI-tells audit |
| `research-storm/` | Multi-persona interview and cited-article research method |
| `generate-image/` | Image generation via the Codex CLI `image_gen` tool |
| `session-handoff/` | Compact next-session handoff packet before `/new`, `/clear`, or a reset |
| `notion/` | Read public or link-shared Notion pages as text via the web client's own `loadPageChunk` endpoint: stdlib only, no key, no login. Reads only what Notion already serves to anonymous requests, so private workspace pages stay closed. Follows the continuation cursor and renders tables and nested blocks, since silent partial reads are the failure mode that matters here. Exit 0 read / 1 usage / 2 not public / 3 fetch failed. Undocumented endpoint, so it can break without notice; write and edit are not built yet |
| `last30days/` | Vendored third-party social-platform research (mvanhorn/last30days-skill @ `52f5331`, runtime subset per upstream `.skillignore`). Optional tier, hand-symlinked. Keys come from the shared `~/.config/cockpit/env` (`~/.config/last30days/.env` symlinks to it; `XAI_API_KEY`, `SCRAPECREATORS_API_KEY`). The X lane runs on the `xurl` backend (X developer app-only bearer, `xurl` CLI installed to `~/.local`, token store `~/.xurl/`, one local patch in the vendored copy for the store layout) and needs default depth, since `--quick` plans drop it; Reddit, HN, YouTube, and Polymarket work without keys. Flags: scraped content enters agent context unescaped (prompt-injection surface), and there is a platform-ToS caveat. Never run its setup wizard, which auto-installs third-party binaries |

`skills/skills.json` is the authoritative machine-readable source (ten core skills plus optional `day`, `taste`, and `last30days`; vendored third-party pins live in its `vendored` block).

Your own decisions about skills belong in your scope's `DECISIONS.md`, and skill work in progress belongs on a Project roadmap sidecar. Neither is shipped with the engine.
