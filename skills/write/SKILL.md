---
name: write
description: Draft and rewrite posts, articles, and newsletters in the author's voice, escaping generic AI prose via a researched AI-tells audit and an accreting voice profile. Learns from your feedback each run.
version: 1.0.0
model: opus
triggers: [write, draft this post, write an article, linkedin post, newsletter, rewrite this, humanize]
tags: [writing, voice, content, self-improving]
allowed-tools: Read Write Edit Bash
---

## Purpose
Produce human-facing prose (LinkedIn posts, articles, newsletters) that sounds like the author, not like a model. Two layers: an **audit/rewrite layer** that works day one (the researched AI-tells rubric in `references/ai-tells.md`) and a **voice layer** that accretes over time (a voice profile plus calibration, `references/voice-craft.md`). This is explicitly NOT a detector-evasion humanizer: those tools optimize detector statistics, a different objective from sounding like a person (see `references/voice-craft.md`). "Humanize" requests are served as voice-fidelity rewriting; detector-evasion optimization is refused even when asked for in those words. Self-improves: every run folds your feedback into `LEARNED.md`.

## Procedure
1. **Load memory first.** A `PreToolUse` hook (`write-hook.mjs inject`) auto-injects `LEARNED.md`'s binding bullets as a `<write-learned>` block whenever `/write` runs. Treat that block as binding. Only the bullet items under `## Doctrine`, the author's preferences section, and `## Per-format notes` are binding; headings/prose/`<!-- -->` are not. (Reading the file yourself is a harmless fallback if the block isn't present.)
2. **Load the voice profile**, a `voice.md` in your memory repo under the scope that holds your personal writing (`memory/scopes/<scope>/voice.md`; ask the author which scope that is if the install has more than one and none is obvious). Data lives in the memory repo, never the engine tree. If no such file exists, run the seeding branch in `references/voice-craft.md` before any drafting: extract candidate voice material from the corpus (the `history-search` skill's index over past Claude Code/Codex/Hermes sessions, that same scope's sources layer under `memory/scopes/<scope>/sources/`, and samples the author supplies directly), elicit via storytelling questions, draft the profile, calibrate with short variants. Permission boundary: ephemeral calibration variants and the proposed profile MAY be drafted and shown in chat before approval (they are elicitation material, not persistence); only creating or updating the `voice.md` file requires the author's explicit approval. A missing profile does not block the audit layer alone (rewriting text that already exists).
3. **Real material first.** Never draft from a bare topic: get the actual story, opinion, and concrete specifics from the author (or their corpus) before generating. AI-assisted, not AI-generated.
4. **Draft in voice.** Use the voice profile plus 2 to 5 register-bridged excerpts as few-shot examples (never raw transcript dumps). Keep strong claims strong: models reflexively soften contrarian positions.
5. **Audit pass before presenting**, against `references/ai-tells.md`: scan for tell clusters (single tells are weak signals; several within a few hundred words is the flag), rewrite flagged lines, then a read-aloud rhythm check.
6. **Present with flags.** Explicitly flag any lines you are unsure carry the author's voice; ask for line-level feedback (which line feels off and why), not thumbs up or down.
7. **Capture feedback, self-upgrade (automatic).** A `SessionEnd`/`PreCompact` hook (`write-hook.mjs capture`) distills durable voice/style preferences from your feedback via a dedicated Groq model and merges them into `LEARNED.md`. You do NOT hand-edit `LEARNED.md`; just state voice feedback clearly in the conversation so the distiller can capture it. Hand-edit only if the hooks are disabled. Voice-profile edits are made only with the author's explicit direction during calibration.

## Hook wiring (one-time per machine/VM)
Self-upgrade is enforced by `write-hook.mjs` (a thin wrapper over `../lib/learned-engine.mjs`), wired in `~/.claude/settings.json` (machine config, not in the repo; re-add on a new VM):
- `PreToolUse` with matcher `"Skill"` runs `node "<repo>/skills/write/write-hook.mjs" inject`
- `SessionEnd` and `PreCompact` run `node "<repo>/skills/write/write-hook.mjs" capture`

Write side needs `GROQ_API_KEY` in `~/.config/cockpit/env` (same key as `/watch`, `/taste`, `/questions`). If you gave feedback this session but the key is missing or the distiller fails, capture warns that your feedback was NOT persisted; it stays quiet only when there was nothing to learn. The skill still works unwired: read and write fall back to the model following steps 1 and 7.

## Rules
1. No detector-evasion or paraphraser pass, ever. Wrong objective: voice fidelity is the target, not detector statistics.
2. The voice profile is data and lives in the memory repo (`memory/scopes/<scope>/voice.md`, the scope holding your personal writing), never in the engine tree.
3. The tells list is a living document: refresh it on evidence, not vibes.
4. The doctrine's no-dash-punctuation rule applies to all output prose.
5. Front-load real specifics: strategic vagueness is the most cited AI tell.
6. Expect to rewrite a meaningful fraction of any first draft; first drafts are not done (research: imitation is weakest exactly in informal personal genres).
7. `LEARNED.md` read (inject) and write (distill+merge) are owned by the hook; don't duplicate them by hand while the hooks are wired (hand-edit only if they are disabled). No timestamps; dedupe; ~25-bullet cap per section (the engine enforces this).
