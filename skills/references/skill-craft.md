# Skill Craft — Shared Doctrine

> Checklist for judging and improving any skill in `~/cockpit/skills/`. Not loaded
> automatically by any skill today — reference for the periodic skill-audit pass (STATE
> housekeeping) and for anyone authoring a new skill.
>
> Wired (AR-3 Wave D item 19): this checklist is source material for the AR-4 hard-checks
> pilot (T1 mechanical checks / T2 rubric evals), see `~/cockpit/DECISIONS.md` AR-4 and
> the skills-work roadmap pilot task.
>
> Provenance: distilled from Matt Pocock, "Building Great Agent Skills: The Missing Manual"
> (video captions, read by a summarize-only pass).

---

## 1. Trigger

Every skill is user-invocable by default. Deciding whether it's *also* model-invocable
(has a description in the agent's live context) is a real cost tradeoff, not a default-yes:

- **Model-invoked** costs *context load* — its description sits in context on every turn,
  and the agent may simply not follow the pointer even when the skill fits (unpredictability
  that then demands evals to catch).
- **User-invoked-only** costs *cognitive load* on the human — you have to remember it exists
  and say its name.

Choose deliberately per skill; don't default every skill to model-invocable.

## 2. Structure

A skill is two units: **steps** (the procedure) and **reference** (supporting material the
steps need). Keep `SKILL.md` itself as small as possible — every word is a token spent on
every invocation.

- If a piece of reference material is needed on *every* branch of the skill, it can live
  inline in `SKILL.md`.
- If it's only needed on *one* branch (one way the skill can be used), move it to an
  external file under `references/` and point to it — a context pointer the agent follows
  only when that branch fires. (`question-craft.md` is this pattern already.)

## 3. Steering

**Leading words** — dense, prior-triggering phrases (e.g. "vertical slice") repeated
consistently through a skill, instead of a paragraph of instruction. The agent echoes the
word back in its own reasoning; that's the verification signal — if the word never shows up
in the trace, the wording isn't steering, and it's better before more emphatic phrasing.

**Leg work** — an agent under-invests in a step (classically: plan mode's "ask clarifying
questions" phase) when it can already see the next step's goal. Splitting a skill so the
agent only sees the current step, with the future step hidden until this one completes,
measurably increases effort on the current step. Use this when a step is being rushed, not
as a default way to write every skill.

## 4. Pruning

Run this pass after a skill has been in use a while, not only when authoring:

- **Single source of truth** — no reference material duplicated across steps or files.
- **No sediment** — content different sessions/contributors added and nobody deleted;
  if it no longer serves a branch, remove it.
- **No no-ops** — delete a paragraph, then ask: would the agent behave any differently?
  If not, it wasn't steering anything; cut it.

Self-upgrading skills (`taste`, `questions`, anything using `skills/lib/learned-engine.mjs`)
are the highest-risk spot for sediment — their `LEARNED.md` grows every run with no
built-in deletion pass. Prune these first when auditing.
