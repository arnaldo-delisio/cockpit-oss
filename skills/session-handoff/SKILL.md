---
name: session-handoff
description: Create a compact, reusable next-session handoff for Hermes, Claude Code, or the human before /new, /clear, model switch, brain switch, or a long/tool-heavy session reset. Use when the operator asks for a handoff prompt, next-session prompt, context reset summary, or asks what to tell Hermes/Claude next.
version: 1.0.0
model: sonnet
triggers: [handoff, session handoff, next session prompt, context reset, prepare next session, what should I tell claude, what should I tell hermes, before clear, before new]
tags: [handoff, context-hygiene, session-reset, coordination, prompt]
allowed-tools: Bash Read Grep
metadata:
  hermes:
    tags: [handoff, context-hygiene, coordination]
    platforms: [linux, macos]
---

## Purpose

Produce a **manual handoff packet** that lets the operator restart context cleanly or move work between
Hermes and Claude Code without losing operational truth. This skill standardizes the ritual the operator
already does by asking both brains for prompts: summarize what happened, what is locked, what is next,
and what must not be redone.

This is context hygiene, not memory writing. It does **not** edit the graph, run the reconciler, or
claim durable memory. The handoff is a user-facing prompt/packet that can be pasted into a fresh
session, `/new`, `/clear`, another model, Hermes, or Claude Code.

## When to Use

Use when any of these are true:

- The operator asks for a "handoff", "next session prompt", "prompt for Claude", or "prompt for Hermes".
- The session is long, tool-heavy, multi-topic, or starting to risk context rot.
- Work is complete and the next unit should begin in a fresh session.
- Work is incomplete and another brain/session must continue safely.
- A commit/push, verification run, generated artifact, or runtime state needs to be preserved in the handoff.

Do **not** use for:

- A normal short status answer where no context reset or brain switch is likely.
- Hiding uncertainty. If something is unverified, say so plainly.
- Creating canonical memory nodes or editing docs. This skill outputs a handoff; docs/memory updates are separate tasks.

## Procedure

1. **Identify the target.** Decide whether the user needs:
   - `short-summary` — 2–3 sentences for the human;
   - `next-session-prompt` — paste-ready prompt for a fresh session;
   - `claude-prompt` — builder-oriented prompt with repo/files/tests;
   - `hermes-prompt` — operator-oriented prompt with orchestration/status/next actions.
   If the target is obvious from the user's wording, do not ask.

2. **Use `Goal` as the next-session objective.** In a handoff, `Goal` must be forward-looking: the crisp one-unit objective the next agent should pursue. Do not use `Goal` to recap what the completed session was about. Put completed-session context under `Session Summary` or `Current State` instead.

3. **Gather live state when tools are available.** For repo work, check real state before writing the handoff:
   - `git status --short --branch`
   - `git log --oneline -3`
   - relevant generated artifact paths, ignored/tracked status, and verification output already run.
   Do not invent commit SHAs, test results, pushed status, or file contents.

   If the operator asks for a "full handoff prompt in a file" or similar, write it to `handoff/<thread-slug>.md`
   under the active scope's DOC-3 spine (governed 6th spine element, gitignored — never
   `tmp_*_handoff.md`, which is the retired, ungoverned pattern this replaces). Derive `<thread-slug>`
   deterministically from the thread's topic: lowercase, kebab-case, 2-4 words distilled from the
   session's actual subject (e.g. a session about migrating the essay map becomes `essay-map`, not
   `next-session-essay-map-handoff-v2`). Reuse the same slug every time this thread hands off — a
   thread's next handoff overwrites its own file, it never creates a naming variant; check for an
   existing `handoff/*.md` covering the same thread before inventing a new slug. Only write a handoff
   when resume cost is real (active debugging state, half-finished multi-step work, uncommitted
   decisions) — not as a default end-of-session ritual; if the next step is just picking the next Now
   line off a roadmap sidecar, skip it. Reply with the absolute path. Still include live repo state
   inside the file.

3. **Separate committed truth from runtime state.** Explicitly distinguish:
   - committed and pushed files;
   - modified but uncommitted files;
   - ignored/generated runtime outputs;
   - docs updated vs docs still stale;
   - submitted/external side effects vs merely prepared artifacts.

4. **Checkpoint small pending work before handoff when appropriate.** If the handoff reveals a tiny, low-risk cleanup or docs checkpoint that would make the next session materially cleaner, recommend doing it before compression. If the operator agrees, do the checkpoint, commit/push if requested or required by repo doctrine, then regenerate/update the handoff from the new live state. Do not leave stale handoff claims like “uncommitted” or “do not touch” after the work has been committed and pushed.

5. **Write the handoff packet using the template below.** Keep it compact but complete. Prefer bullets over prose.

5. **End with an exact pickup instruction.** The next agent should know what to do first, what not to redo,
   and what verification gates matter.

## Handoff Template

```markdown
# Session Handoff — <scope/project> — <date>

## Target
For: <Hermes | Claude Code | either | human>
Mode: <short-summary | next-session-prompt | claude-prompt | hermes-prompt>

## Goal
<The next coherent unit of work. This must be forward-looking and actionable for the next agent, not a recap of the completed session.>

## Session Summary
<Brief recap of what this session completed or changed.>

## Current State
- Done: <facts only>
- Not done: <facts only>
- Current repo/path/branch: `<path>` / `<branch>`
- Latest commit/push: `<sha> <message>` or `not committed`

## Locked Decisions
- <Decision that should not be re-litigated next session.>

## Files / Artifacts Touched
- Tracked: `<path>` — <what changed>
- Runtime/ignored: `<path>` — <what exists, ignored/not committed>

## Verification Actually Run
- `<command>` → <real result>
- `<command>` → <real result>

## Open Questions / Blockers
- <Unknowns or blockers. Say `none` if none.>

## Risks / Unverified Claims
- <Anything not verified. Say `none known` only if true.>

## Do Not Redo / Do Not Touch
- <Avoid duplicate work, unsafe scope, or out-of-scope areas.>

## Exact Pickup Instruction
<One paragraph/prompt the next agent can follow immediately.>
```

## Claude Code Prompt Shape

Use this when handing from Hermes/operator into Claude Code/builder:

```markdown
You are Claude Code working in `<repo path>` on branch `<branch>`.

Read first:
- `<state/doc file>`
- `<relevant source files>`

Committed state:
- Latest pushed commit: `<sha> <message>`
- What it did: <brief>

Runtime/generated state:
- `<ignored artifact path>` exists but is not tracked.

Next task:
<Precise build/debug/doc task.>

Constraints:
- Do not redo <completed work>.
- Do not touch <out-of-scope area>.
- Do not fabricate <claims/artifacts>.

Verification required:
- `<command>`
- `<command>`
```

## Hermes Prompt Shape

Use this when handing into Hermes/operator:

```markdown
You are Hermes operating in `<scope/project>`.

Current state:
- <committed truth>
- <runtime truth>
- <docs state>

Next operation:
<What to orchestrate, inspect, run, or verify.>

Guardrails:
- <side-effect limits>
- <what requires human approval>
- <what not to automate yet>

Evidence to gather before reporting done:
- `<command/path/check>`
```

## Rules

1. **Truth over continuity.** A handoff must preserve what is real, not make the next session feel smoother.
2. **Committed ≠ generated.** Always separate git-tracked state from ignored runtime artifacts.
3. **Done ≠ submitted.** Never imply external action occurred unless there is evidence.
4. **Verification is evidence.** Include actual commands/results, not "should pass" or "likely works".
5. **Unverified stays unverified.** If the current session did not inspect or test something, label it.
6. **Do not dump raw logs.** Compress tool output to the facts the next agent needs; include paths/commands for re-checking.
7. **No stale task resurrection.** The exact pickup instruction must reflect the latest user request, not old context.
8. **Respect brain roles.** Claude prompts should be builder-oriented; Hermes prompts should be operator/orchestration-oriented.
9. **One next unit.** A good handoff narrows the next session to one coherent unit, not a giant backlog.
10. **Checkpoint before compressing when the current unit is tiny and safe.** If the handoff reveals a small, coherent, already-reviewed current-session change (for example a docs alignment diff) that can be committed/pushed independently before context reset, recommend doing that checkpoint first. If the operator agrees, do the checkpoint and then produce the handoff for the next implementation unit; do not leave avoidable uncommitted current-session work merely because the user asked for a compression prompt.
11. **Stop after handoff unless asked to act.** If the user asked for a handoff, deliver the packet; do not start the next task.
12. **Handoffs are consumed and deleted on pickup, never archived.** The picking-up session's first move is to fold any surviving open thread into that Project's roadmap sidecar (Now/Next) or DECISIONS.md if decision-grade, then delete `handoff/<slug>.md`. It is never a chronology home — do not leave stale handoff files around "just in case".

## Session lessons

- When a handoff exposes a small docs or codebase checkpoint that can be finished before compression, finish it first, so the next session starts from a clean, pushed base.
- Refresh stale handoff facts from live git state rather than from what the session remembers.

## Quality Checklist

Before finalizing, verify the handoff answers:

- [ ] What was the goal?
- [ ] What is actually done?
- [ ] What remains undone?
- [ ] What commit/branch/status is real?
- [ ] Which artifacts are ignored/generated vs tracked?
- [ ] What verification actually ran?
- [ ] What must not be redone?
- [ ] What should the next agent do first?
- [ ] Are all unverified claims labeled?
