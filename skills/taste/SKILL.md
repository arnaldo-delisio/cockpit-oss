---
name: taste
description: Build frontend UI with committed design direction and structurally-correct spacing/symmetry. Use when generating or restyling landing pages, product UI, dashboards, or components in React/Tailwind or Astro/HTML where design quality matters. Learns from your feedback each run.
version: 1.0.0
model: opus
triggers: [taste, design this, build the landing page, style this UI, make this look good, frontend, restyle]
tags: [frontend, design, ui, prevention, self-improving]
allowed-tools: Read Write Edit Bash
---

## Purpose
Escape generic AI design **and** stop the craft defects (uneven card padding, broken symmetry, inconsistent rhythm) — by committing to a design *direction* before any code and then building from spacing-encapsulating **primitives** so siblings are identical *by construction*, not policed after. Self-improves: every run folds your feedback into `LEARNED.md`.

## How it works (the two-failure model)
- **Direction / generic look** → solved by a committed preset + the `frontend-design` skill (macro, pre-build) and verified post-build by the slop-check (step 6) — commitment alone doesn't guarantee the build didn't drift back to generic patterns.
- **Craft / spacing & symmetry** → solved by *prevention*: the model composes from layout primitives (`Stack`/`Cluster`/`Grid`/`Center`/`Card`) that bake the spacing decision in once and reuse it. It never types a raw `p-`/`gap-`/`m-` on a composed surface, so siblings can't drift. Micro. Verified post-build by the structural lint (step 6).

## Procedure
1. **Load memory first (the self-upgrade).** A `PreToolUse` hook (`taste-hook.mjs inject`) auto-injects `LEARNED.md`'s binding bullets as a `<taste-learned>` block whenever `/taste` runs — so learned preferences apply *regardless of which model runs the skill*, even if this step is skipped. Treat that block as binding. Only the **bullet items** under `## Doctrine`, `## <owner>'s preferences`, `## Per-stack notes` are binding; headings/prose/`<!-- -->` are not. (Reading the file yourself is a harmless fallback if the block isn't present.)
2. **Commit a direction.** Pick exactly ONE preset from `references/presets.md` that fits the product (don't stack them). State the committed direction in one sentence *before* writing code. Then invoke the `frontend-design` skill for generation under that direction.
   - Building an onboarding/signup/paywall/upgrade/pricing screen? Also consult `references/flow-psychology.md` — framing/sequencing checklist, orthogonal to the visual direction.
   - Building a dashboard/table/other data-dense UI? Also consult `references/dashboard-patterns.md` — structure/disclosure checklist, a third failure class alongside direction and spacing craft.
3. **Detect the stack & scaffold the kit (prevention).**
   - React/Next + Tailwind → scaffold `references/tokens.css` + `references/primitives-react.tsx` into the repo if not already present.
   - Astro / plain HTML + Tailwind → scaffold `references/tokens.css` + `references/primitives-astro.md`; use **Basecoat UI** (shadcn-as-HTML) for interactive components, port shadcn classes for static ones.
   - If the repo already has primitives/tokens, use them — don't duplicate.
4. **Build by composition only.** Assemble surfaces from the primitives. **Never** write a raw `p-`/`gap-`/`m-`/`space-` utility on a composed surface (cards, grids, sections, forms) — if a primitive doesn't fit, add/extend a primitive, don't inline a one-off value. Bespoke hero/marketing surfaces may use bespoke spacing but must still sit on the semantic tokens.
5. **Sourcing rule.** Standard interaction components (forms, tables, dialogs, dropdowns) → shadcn (React) / Basecoat (HTML), don't hand-roll. Bespoke compositions → build from primitives.
6. **(Opt-in) Ship-check before a client deliverable.** Two independent checks — direction commitment (step 2) only proves you *intended* to avoid generic AI look, neither of these is redundant with it:
   - **Structural lint.** Render the page, open it in the browser, and inject `taste_lint.js` via the browser `javascript_tool`. It measures the live DOM (sibling padding/height equality, gap = token, optical symmetry, edge alignment) and reports violations — deterministic, not eyeballed. Fix what it flags.
   - **Slop-check.** Screenshot the rendered page and critique it against `references/slop-check.md` — did the output actually honor the committed preset, or drift back toward generic AI tells (cliché gradients, default fonts, cookie-cutter card grids, stock SaaS copy)? Fix what's flagged.
   Skip both for quick internal work; run both before anything a client sees.
7. **Capture feedback → self-upgrade (automatic).** Feedback capture is hook-enforced: a `SessionEnd`/`PreCompact` hook (`taste-hook.mjs capture`) reads the transcript, distills any durable design preferences from the user's feedback via a **dedicated Groq model** (not the skill-running model), and merges them into `LEARNED.md` (dedupe + ~25-bullet cap + rewrite). So it fires regardless of which model ran the skill. **You do NOT hand-edit `LEARNED.md`** — just make sure any design feedback ("too tight", "always serif here", "never that gradient") is stated clearly in the conversation so the distiller can capture it. Hand-edit only if the hook is disabled.

## Hook wiring
The self-upgrade is enforced by `taste-hook.mjs`, wired in `~/.claude/settings.json`. The wiring
ships in `hooks/settings.template.json` and is installed by `bootstrap.mjs --write-settings`
(part of `--cutover`); nothing to re-add by hand on a new box:
- `PreToolUse` → matcher `"Skill"` → `node "<repo>/skills/taste/taste-hook.mjs" inject`
- `SessionEnd` and `PreCompact` → `node "<repo>/skills/taste/taste-hook.mjs" capture`

Write side needs `GROQ_API_KEY` in `~/.config/cockpit/env` (same key as `/watch`). If you gave design feedback this session but the key is missing (or the distiller call fails), capture **warns** (`systemMessage` + stderr) that your feedback was NOT persisted — it never fails silently; it stays quiet only when there was nothing to distill. The skill still works unwired — read/write just fall back to the model following steps 1 and 7.

## Rules
1. Direction before code — never start generating without a committed preset stated out loud.
2. On composed surfaces, spacing comes from primitives/tokens only. A raw `p-`/`gap-`/`m-` on a card/grid/section/form is a defect, not a choice.
3. One preset per build. Presets are mutually exclusive vibes, not layers.
4. shadcn/Basecoat-first for standard components; justify any hand-rolled one.
5. Don't blanket-apply shadcn to marketing/hero surfaces — that flattens the taste. Library = functional; primitives = bespoke.
6. The lint is a ruler, not a judge — it measures, it doesn't approve taste. Run it for verification, not for design decisions. The slop-check is a critique pass, not an auto-fixer — it flags, you fix.
7. The `LEARNED.md` read (inject) and write (distill+merge) are owned by `taste-hook.mjs` via hooks — don't duplicate them by hand. No timestamps; dedupe; ~25-bullet cap per section (the hook enforces this).
8. Porting shadcn classes to plain HTML drops Radix accessibility — only port *static* components; use Basecoat/React-island for anything stateful.
9. You know where everything is because you built it; the user is navigating, not touring. Judge a surface by where someone lands cold and gets stuck, not by what reads as obvious to you, and hold hands further than feels necessary. Where behavioural data exists (session recordings, funnels), observed friction outranks both your familiarity and your aesthetic preference; where it does not, say the judgement is unmeasured rather than dressing taste as evidence.
