---
name: questions
description: Design (and optionally conduct) a sequenced, behavior-anchored question set to ask someone else — client discovery, expert interview, or written questionnaire. Output is an artifact grounded in researched questioning craft. Learns from your feedback each run. Use when the human says "design questions", "build a questionnaire", "questions for <interview/call/discovery>", or wants to prepare to interview someone.
version: 1.0.0
model: opus
triggers: [questions, design questions, build a questionnaire, questions for, discovery questions, interview questions, prepare to interview]
tags: [questioning, interview, discovery, questionnaire, elicitation, self-improving]
allowed-tools: Read Write Edit Bash
---

## Purpose
Design questions that work **outward** — a set you (or a human) will ask someone else to pull out
the truth: how something really works, where it leaks, what it costs. The output is an **artifact**
(a sequenced, behavior-anchored question set), not a live interview by default. Grounded in one
shared body of questioning craft; self-improves by folding your feedback into `LEARNED.md` each run.

**Outward, not inward.** This is for questioning *someone else*, not for interviewing *the human
in front of you*.

## How it works
- **The craft is shared, not forked.** Both the principles (behavior-not-intention, how/what-not-why,
  implication ladder, strengths-first, artifact-over-description) and the T1–T10 toolbox live ONCE in
  `../references/question-craft.md`. This skill *applies* them to a specific target; it never restates them.
- **Two failure classes.** A weak *question* (abstract, leading, double-barreled) → fix with the toolbox.
  A weak *sequence* (right questions, wrong opener/order) → fix with the doctrine's sequencing rules.

## Procedure
1. **Load doctrine + memory first.** Read `../references/question-craft.md` (the technique). A `PreToolUse`
   hook (`questions-hook.mjs inject`) auto-injects `LEARNED.md`'s binding bullets as a `<questions-learned>`
   block when `/questions` runs — treat that block as binding. Only the **bullet items** under
   `## Doctrine`, `## What works by context`, `## Anti-patterns observed` are binding; headings/prose are
   not. (Reading `LEARNED.md` yourself is a harmless fallback if the block isn't present.)
2. **Gather the brief — recommend, don't interrogate.** Establish five inputs; propose your best read of
   each and let the human confirm/correct rather than asking open-ended into the void:
   - **Who** — role, relationship, disposition (skeptical CEO, friendly expert, anonymous respondent). Drives posture/framing.
   - **Goal** — what you must walk away knowing.
   - **Already known** — what you already have, so you don't design questions whose answers you hold.
   - **Modality** — live interview · written questionnaire · async. Changes length, framing prose, and which patterns fit.
   - **Constraints** — time budget, language, sensitivities.
   Ask only the inputs that materially change the design; infer the rest and state your assumption.
3. **Design the set (default output).** Build a sequenced artifact, not a flat list:
   - Open with a **disarming frame** (it's a mapping not an audit; "I don't know" is a useful answer) and
     **T6 best-case**, not problems.
   - Sequence the body per the doctrine (T1 trace-a-case → T3 how/what → T2 visibility → T4 implication
     ladder on every named gap → T7 mirror for depth), descend into gaps with T9/T10, close by reflecting back.
   - Each question is a concrete instance of a T-pattern; **note the pattern** beside it (for the human, and
     so feedback is traceable). Group by area. Strip jargon. Write in the target language.
   - Run the **jargon test** and **quick-rewrite rule** from the doctrine over every question before finishing.
4. **Write the artifact, return the path.** Save to the path the human gives, else a `questions/` dir under
   the current working scope (e.g. `<scope>/questions/<target>-<purpose>.md`). Don't hardcode any project.
   Return path + one-line description. **Reference "good output":** if the current tree already holds a
   real, validated question set in the target shape (typically a client discovery questionnaire under a
   scope's `questions/` dir), read it as the example of done and do NOT edit it from this skill (it belongs
   to its own workstream). Otherwise follow the target shape from the doctrine alone.
5. **(Opt-in) Conduct.** Only if the questioning happens THROUGH Claude (the human pastes the interviewee's
   answers, or asks Claude to run an async interview): drive the set **one question at a time** per the
   doctrine — recommend nothing for them, mirror (T7) for depth, climb the implication ladder (T4) on each
   named gap, follow resistance laterally (P9). Default is design-only; do not start a live loop unprompted.
6. **Capture feedback → self-upgrade (automatic).** A `SessionEnd`/`PreCompact` hook (`questions-hook.mjs
   capture`) reads the transcript, distills durable questioning lessons from your feedback via a **dedicated
   Groq model** (not the skill-running model), and merges them into `LEARNED.md` (dedupe + ~25-bullet cap).
   You do NOT hand-edit `LEARNED.md` — just state questioning feedback clearly ("that opener is too leading
   for a CEO", "mirror is dead weight on a written form") so the distiller can capture it.

## Hook wiring
Self-upgrade is enforced by `questions-hook.mjs` (a thin wrapper over `../lib/learned-engine.mjs`), wired in
`~/.claude/settings.json`. The wiring ships in `hooks/settings.template.json` and is installed by
`bootstrap.mjs --write-settings` (part of `--cutover`); nothing to re-add by hand on a new box:
- `PreToolUse` → matcher `"Skill"` → `node "<repo>/skills/questions/questions-hook.mjs" inject`
- `SessionEnd` and `PreCompact` → `node "<repo>/skills/questions/questions-hook.mjs" capture`

Write side needs `GROQ_API_KEY` in `~/.config/cockpit/env` (same key as `/watch` and `/taste`). If you gave feedback
this session but the key is missing (or the distiller call fails), capture **warns** (`systemMessage` + stderr)
that your feedback was NOT persisted — it never fails silently; it stays quiet only when there was nothing to
learn. The skill still works unwired — read and write just fall back to the model following steps 1 and 6.

## Rules
1. **Doctrine before design.** Never write questions without loading `../references/question-craft.md` first.
2. **Behavior, not intention.** Every question anchors to a real past event. If the obvious answer is yes/no
   or "more or less," it's still too abstract — rewrite it (quick-rewrite rule).
3. **Sequence, don't list.** A flat question dump is a defect. Open with a frame + T6, climb implications
   before solutions, close by reflecting back.
4. **One copy of the craft.** Apply the shared doctrine; never restate the principles or toolbox inside this
   skill or the output. If the craft itself improves, promote it into `question-craft.md` so every
   questioning skill benefits — don't silo it here.
5. **Design by default; conduct only on request.** The common case is a human conducting outward. Don't start
   a live one-at-a-time loop unless the questioning is genuinely happening through Claude.
6. **Match modality.** A live-only move (T7 mirror, lateral returns) is dead weight on a written form. Design
   to the modality you were given.
7. **The reference example is read-only.** Use an existing validated questionnaire as the shape of "good";
   never edit it from this skill.
8. **`LEARNED.md` read (inject) and write (distill+merge) are owned by the hook** — don't duplicate them by
   hand. No timestamps; dedupe; ~25-bullet cap per section (the engine enforces this).
