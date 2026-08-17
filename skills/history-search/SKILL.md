---
name: history-search
description: Cited keyword search over past raw agent sessions (Claude Code + Codex JSONL via a local FTS5 index, Hermes state.db direct); also renders any past conversation readably (show/list, never raw JSONL). Use PROACTIVELY before saying "I don't have that context": resuming prior work, "which session did X", "when did we discuss/decide Y", "what was that error/command/path", or any past-session reference ambient recall didn't surface.
version: 1.1.0
model: sonnet
triggers: [history search, search history, past session, which session, old conversation, find that conversation, search transcripts, show session, list sessions]
tags: [memory, capture, search, history]
allowed-tools: Bash Read
metadata:
  hermes:
    tags: [memory, capture, search, history]
    platforms: [linux]
---

# history-search — search + read past raw agent sessions

Answers the Capture-layer question **"what just happened / where did that happen?"** over the raw
histories the memory graph never distilled (TOOL-8). Complements — never replaces — the distilled
graph (`retrieval.mjs`) and ambient recall (MEM-30): the graph knows what is *true*; this finds
where something *verbatim happened*.

## Run

```bash
node ~/cockpit/skills/history-search/history-search.mjs search "<query>" [-n 20] [--no-hermes]
node ~/cockpit/skills/history-search/history-search.mjs list [-n 20] [--project <scope>]
node ~/cockpit/skills/history-search/history-search.mjs show <file>[:<line>] [--around <turns>]
node ~/cockpit/skills/history-search/history-search.mjs index [--rebuild]   # refresh / full rebuild
```

- `search` auto-refreshes the index first (file-level: only changed files re-ingest; typically
  sub-second after the first build) and ranks **current-project hits first** (preference, not a
  wall — cross-scope results fill the remainder). `--no-refresh` skips the refresh.
- Results are grouped **sessions → events → citations**: every hit cites `transcript-path:line`
  (Claude/Codex) or `~/.hermes/state.db:msgN` (Hermes).
- **Don't open raw JSONL yourself to follow a citation** — `show <file>:<line> --around 5`
  renders the surrounding turns as readable text; `show <file>` renders the whole conversation;
  `list` browses recent sessions (date · scope · first prompt). `show` refuses files outside the
  transcript roots or outside the surface (walled/unscoped). Hermes hits: query the message id
  from `~/.hermes/state.db` (read-only).
- Query terms are treated as quoted literals, implicitly ANDed (FTS5 operators are NOT exposed).
  Keep queries to 2–5 significant words. Flag-like terms (`-n`, `--…`) can't be searched — they
  parse as CLI flags.

## Surface (agreed 2026-07-03 — the allowlist IS the boundary)

A session enters the index **only if its recorded cwd maps to a live scope**: the repo tree →
cockpit, or `<repo>/scopes/<x>` → scope `<x>` (deepest match first, layout §6; old
transcripts' stored cwd may use a legacy root value — the legacy `~/scopes` / `~/projects`
dual root is not ported and is not mapped on this VPS, `scope-gate.mjs:40`) — with `<x>`
present in `memory/scopes.json` (same boundary as the MEM-14 capture gate — one list, one
doctrine).
- **Confidential ventures** (in `scopes/` but deliberately absent from scopes.json):
  **hard skip, no override** — a security wall (MEM-32), enforced structurally at ingest.
  Belt-and-braces: such ventures also run their own agent homes (`CLAUDE_CONFIG_DIR` /
  `CODEX_HOME` / `HERMES_HOME` inside the venture root), so their transcripts never land in
  the shared trees at all.
- **Past structures** (scratch/, vault/, unmapped cwds): excluded; `#capture`/`#capture:<scope>`
  in the session text is the only opt-in (MEM-14 mirror). Archaeology fallback = manual `rg`.
- **Hermes**: the SHARED `~/.hermes/state.db` only, opened read-only, never ingested/copied.
  Standing rule: confidential Hermes automations run under their own `HERMES_HOME` (own
  `state.db`, MEM-25/32 pattern) — never the shared home.
- Skip decisions are remembered per file (mtime+size) **and versioned against the allowlist**:
  if `scopes.json` changes, the next refresh re-evaluates every file (a scope added → its history
  enters; removed → its events leave). Scope decisions come from parsed record fields
  (top-level `cwd`), never regex over raw text — pasted content can't spoof them.

## Ambient hook (automatic trigger)

`history-search.mjs hook` runs on Claude Code `UserPromptSubmit` (wired in settings.json, folded
into `memory-engine/bootstrap.sh` clone-clean). It stays **silent by default** and injects ≤4
cited hits (current-project first) only when the turn references past work — a lexical
**past-reference gate** ("last session", "we discussed", "which session", "remember when", …) or
the explicit **`#history <query>`** sentinel (query = rest of that line). **Per-session dedup:**
a hit injects its snippet once; if it qualifies again in the same session it becomes a one-line
_"already surfaced"_ back-reference so the model reuses what is already in context. Marked block
(`<!-- cockpit:history-recall:begin/end -->`), killable with `COCKPIT_HISTORY_RECALL=off`.
Fail-safe: errors swallowed, stderr muted, always exit 0 (a failing UserPromptSubmit hook would
otherwise block the prompt). Never pays the first full index build in-hook; refreshes only when
the cache is >15 min old. The hook searches all three providers; what is deliberately NOT wired
is a Hermes-side injection hook — `recall-hermes.mjs` stays the ONLY context-mutating Hermes hook
(MEM-30 invariant). Accepted tradeoff: the gate scans the whole turn (capped at 20k chars), so
pasted text containing phrases like "we discussed" can fire a spurious block — ≤4 marked
non-directive lines, silence-by-default holds for ordinary prompts.

## Contract (TOOL-8 — do not silently change)

- **Index = disposable cache** at `~/.cache/cockpit-history-index.db` — deleting it loses nothing
  but time; `--rebuild` is the recovery path for anything weird.
- **File-level freshness only** (mtime+size → drop file's rows + re-ingest whole file).
  NEVER add event-level checkpoints/cursors — that is the ctx failure mode TOOL-8 avoids.
  (The `surfaced` dedup table tracks hook injections, not ingest progress — different thing.)
- **Read-only over provider files**; zero network; zero dependencies beyond `node:sqlite`
  (Node ≥ 22.5) and the raw histories themselves.
- Indexed signal = user/assistant **text turns only**; thinking blocks, tool calls/results and
  meta lines are deliberately skipped (noise suppression). Grep the raw JSONL directly if the
  needle is inside tool output.
