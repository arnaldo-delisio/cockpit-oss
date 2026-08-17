# Dashboard patterns — consult when building dashboards, tables, or other data-dense UI

Three structural flaws that separate a dashboard that looks fine from one that actually works.
Source: youtu.be/Ksx9C2-3yMo. This is a third failure class alongside taste's direction and
spacing/symmetry: *structure/disclosure* — letting data and usage shape the UI instead of
decorating a generic layout.

## Let the data drive the form
- Fixed-vocabulary fields (status, department, category) → chips, not plain text.
- Numeric columns → right-align so digits line up by place value.
- Long text → truncate to give breathing room to other columns.
- Inactive/deactivated rows → shade them, don't just list them identically to active rows.
- Time-series data that's currently a sorted table → consider a timeline instead; a table sorted
  by time is often the wrong form factor for time-dimensioned data.
- Color must come from the data (urgency, identity), not decoration — an avatar or a red urgency
  icon lets the eye triage faster than reading a text column.

## Progressive disclosure / spectrum of explicitness
Not everything belongs permanently on-screen. Rank actions by frequency/importance and reveal
accordingly:
- Primary, frequent action → always visible.
- Secondary, occasional action → tuck into a popover instead of a full page nav; show the most
  important sub-action (e.g. search) at the top of that popover.
- Rare/destructive action → reveal on hover with a tooltip, not permanently rendered.
This is also the shape of good onboarding: don't explain the whole product in a modal on first
load — point at one thing, let them do it, then reveal the next step (checklist/tooltip
sequencing), never a full dashboard dumped on a first-time user at once.

## Invisible UI
A dense table or drawer needs UI that isn't visible until needed to actually function: hover
affordances (copy-cell icon), comment indicators, tooltips on ambiguous icons/labels. Beginner
dashboards are reliably missing tooltips — assume the user won't decode every icon unaided, and
budget for the "UI you can't see" as seriously as the UI you can.
