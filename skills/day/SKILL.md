---
name: day
description: Capture personal todos that no project owns, then read and reschedule the day, using Google Calendar as the only store. Use for errands, admin, appointments, "what does my day look like", "move this to tomorrow", or marking a personal item done. Learns from your feedback each run.
version: 1.0.0
model: opus
triggers: [day, todo, my day, my week, what's on today, add to my calendar, remind me to, reschedule, book this]
tags: [calendar, todos, personal, scheduling, self-improving]
allowed-tools: Read Bash
---

## Purpose
Hold the personal work that no project roadmap owns (errands, admin, appointments, small promises) in the one place already open on every device: Google Calendar. One store, no local file, no database, no new calendar. Self-improves: every run folds your routing and scheduling feedback into `LEARNED.md`.

## Where this runs
This skill drives the `mcp__claude_ai_Google_Calendar__*` connector tools: `list_calendars`, `list_events`, `search_events`, `create_event`, `update_event`, `delete_event`, `get_event`, `suggest_time`. So it works in a Claude Code session with the Google Calendar connector authorised, and it does **not** work from Hermes, which has no such connector. If the tools are absent, say so and stop; do not fall back to a local file, since that would mint a second store.

## The convention
- **Appointments** are ordinary timed events. Nothing special.
- **Todos** are all-day events with `availability: AVAILABILITY_FREE`, so a list of errands never makes the owner look busy and never fights `suggest_time`.
- **An open todo's title starts with `☐`, a done one with `✓`.** That is how a store with no completion state gets one.
- **Genuine all-day events** (travel, holidays, a birthday) carry no prefix, so they stay visually distinct from todos.
- Todos go on the **existing area calendar they belong to**. The skill never creates a calendar.

## Procedure
1. **Load memory first.** A `PreToolUse` hook (`day-hook.mjs inject`) auto-injects `LEARNED.md`'s binding bullets as a `<day-learned>` block whenever `/day` runs. Treat that block as binding. Only the bullet items under `## Doctrine`, the owner's preferences section, and `## Routing notes` are binding; headings, prose, and `<!-- -->` are not. (Reading the file yourself is a harmless fallback if the block is not present.)
2. **Discover the calendars.** Call `list_calendars` and work from what comes back. Calendar names are never hardcoded here: this skill ships publicly, and one person's calendar names are both a leak and useless to anyone else. Routing lives in `LEARNED.md`, which does not ship.
3. **Capture a todo.** Create an all-day event on the routed calendar, never the primary one: title `☐ <the thing>`, `availability: AVAILABILITY_FREE`, start and end as dates, not times, with `timeZone` set to that calendar's own zone (rule 6). Pick the day from what the owner said; when they said nothing, today. If the routing is genuinely ambiguous across two calendars, ask once rather than guessing, since a misfiled todo is invisible.
4. **Capture an appointment.** Create an ordinary timed event on the routed calendar, with the real start and end. No prefix. Use `suggest_time` only when the owner asked for a slot rather than naming one.
5. **Read a day or week.** `list_events` takes a **single** calendar, so a real read means one call per calendar. **Put all of those calls in ONE message so they run in parallel.** That parallel sweep is not just speed: it is the only way to cover more than one calendar at all, because `search_events` has no `calendarId` and reads the primary calendar only. Then present the day as: appointments in time order first, then open todos (`☐`), and mention done ones (`✓`) only if asked. An empty day is reported as empty, never padded.
6. **Complete an item.** Locate the event first. Use the read you already did, or sweep every calendar with parallel `list_events` calls filtered by `fullText`, which does take a `calendarId`. `search_events` is a fast path only when the item is known to live on the primary calendar; it cannot see any other calendar, so a lookup that relies on it reports "no such todo" for an item that exists. Then `update_event` its title from `☐ …` to `✓ …`, passing the owning `calendarId`. Never delete a completed todo: the trail is the record of the day.
7. **Reschedule an item.** Locate it the same way as step 6: the parallel `fullText` sweep across the calendars, with `search_events` only for a known primary-calendar item. Then `update_event` the dates, passing the owning `calendarId` and that calendar's own `timeZone` (rule 6). Keep the title and its prefix exactly as they are. Moving a todo across calendars means the routing was wrong, so say so out loud, since that is exactly the lesson `## Routing notes` is there to keep.
8. **Capture feedback, self-upgrade (automatic).** A `SessionEnd`/`PreCompact` hook (`day-hook.mjs capture`) reads the transcript, distills durable scheduling and routing preferences via a dedicated Groq model (not the skill-running model), and merges them into `LEARNED.md` (dedupe, ~25-bullet cap, rewrite). **You do not hand-edit `LEARNED.md`**: just state routing and timing feedback clearly in the conversation ("gym stuff goes on the personal calendar", "never put errands on a Sunday") so the distiller can catch it.

## Hook wiring
The self-upgrade is enforced by `day-hook.mjs`, wired in `~/.claude/settings.json`. The wiring ships in `hooks/settings.template.json` and is installed by `bootstrap.mjs --write-settings` (part of `--cutover`); nothing to re-add by hand on a new box:
- `PreToolUse` → matcher `"Skill"` → `node "<repo>/skills/day/day-hook.mjs" inject`
- `SessionEnd` and `PreCompact` → `node "<repo>/skills/day/day-hook.mjs" capture`

Write side needs `GROQ_API_KEY` in `~/.config/cockpit/env` (same key as `/watch`). If you gave feedback this session but the key is missing, or the distiller call fails, capture warns (`systemMessage` plus stderr) that it was not persisted. The skill still works unwired: read and write fall back to the model following steps 1 and 8.

## Rules
1. Google Calendar is the only store. No local file, no database, no sidecar list.
2. Never create a calendar. Route onto an existing one, or ask which existing one. Pass `calendarId` explicitly on every write (`create_event`, `update_event`, `delete_event`): omitting it silently writes to the primary calendar with no error.
3. Never write a todo to the primary calendar. Primary is fixed to the account address and cannot be reassigned, and every invitation the owner accepts lands there, so it is an inbox for what other people scheduled, not a category the owner controls. A todo arrives as no invitation, so a todo on primary is always misfiled. This is the accident rule 2 prevents: it happens when `calendarId` is omitted, not when it is chosen.
4. Never hardcode a calendar name in this skill or its scripts. Discover with `list_calendars`; keep routing in `LEARNED.md`.
5. Every todo is all-day and `AVAILABILITY_FREE`. A todo that blocks time is a defect.
6. Every all-day write passes `timeZone` and a bare timestamp, never a UTC offset. Take the zone from the target calendar's own `timeZone` in `list_calendars`; never assume or hardcode one. `timeZone` overrides any offset in `startTime` and `endTime`. An offset makes the event land a day early some of the time: midnight in a positive offset is the previous day in UTC, and the API takes the UTC date for an all-day event. Intermittent, silent, and it puts the todo on the wrong day.
7. `☐` opens, `✓` closes. No other prefix, and no prefix at all on genuine all-day events.
8. Multi-calendar reads go in one message, in parallel. Serial `list_events` calls are a defect.
9. `search_events` sees the primary calendar only. Never trust it for a cross-calendar lookup; find items with parallel `list_events` plus `fullText`.
10. Completion is a title rewrite, never a delete.
11. Project work does not belong here. If the item is derived from a project, it goes on that project's roadmap sidecar instead; say so and stop.
12. Ambiguous routing gets one question, not a guess.
13. The `LEARNED.md` read and write are owned by `day-hook.mjs`. Do not duplicate them by hand.
