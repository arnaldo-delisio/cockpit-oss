# Slop-check — post-build check for generic-AI drift

`taste_lint.js` verifies the *structural* axis (does spacing/symmetry hold by construction).
It cannot see the *generic-look* axis — whether the committed preset (`presets.md`) actually
survived the build, or the output drifted back to default AI patterns. This checklist is that
second check: screenshot the rendered page and critique it against these tells before shipping.

## Procedure
1. Render the page, screenshot it (browser `computer`/`javascript_tool`, or an artifact preview).
2. Compare against the committed preset from `presets.md` — does the output actually read as
   that direction, or has it drifted toward one of the tells below?
3. Fix what's flagged. This is a critique pass, not an auto-fixer — apply fixes the same way as
   any other build step, then re-check if the fix was substantial.
4. If the user flags something as "still looks AI-generated" that isn't on this list, that's
   design feedback — let it flow through the normal `LEARNED.md` capture (step 7 in `SKILL.md`),
   don't hand-edit this checklist.

## Tells (generic-AI patterns to catch)
- **Color**: purple/blue gradient on white or near-black — the single most common AI default.
  Any preset should commit to a specific palette; a gradient that could belong to any product
  is a miss.
- **Type**: Inter/Roboto/system-font defaults, or a single weight doing all the work. A distinct
  display+body pairing should be visible, not just "readable."
- **Copy**: cliché SaaS phrasing ("Unlock your potential," "Supercharge your workflow," "The
  future of X") sitting in hero/headline copy — a tell the copy wasn't actually written for this
  product.
- **Layout**: the default 3-column feature-card grid with icon-title-description repeated
  verbatim, no asymmetry, no grid-breaking element — reads as templated rather than composed.
- **Decoration**: default rounded-corner cards with a soft drop-shadow and no other distinguishing
  visual choice — "safe" in a way that erases the committed direction.
- **Overall test**: could this screen be shown as-is for five different unrelated products
  without anyone noticing? If yes, it hasn't committed to the direction — that's the slop.
