# Cockpit: Build Context

Loads when working at the cockpit repo root (building the system itself). The builder shell
already loads everywhere; this file adds only the cockpit's structure map and resume
packet. Cap ≤60 authored lines.

## Spine map (DOC-3)

| Doc | Owns |
|---|---|
| `memory/scopes/<scope>/projects/<id>.md` | Project objects: purpose, understanding, standing (WORK-1) |
| `memory/scopes/<scope>/projects/<id>.roadmap.md` | Now/Next/Done: the only stored roadmap |
| `DECISIONS.md` (owner-created, not shipped) | index-grade decision ledger (≤3-sentence entries) + open questions |
| `decisions/<topic>.md` (owner-created, not shipped) | deep dives behind meaty decisions |
| `memory-engine/DESIGN.md` | integrated spec of the memory layer |
| `handoff/<slug>.md` | mid-task resume aid: single slot per thread, consumed and deleted on pickup, gitignored |
| repo-root CLAUDE.md (this file) | structure map + resume packet |

Derived, never stored: scope and cross-scope roadmaps, rolled up on read from the project
roadmap sidecars by whatever surface asks for them. Chronology
= capture hooks + roadmap Done lines + ledger dates + git history.

## Cloud sandbox sessions (TOOL-12)

If the nested `memory/` repo is absent from this tree, you are running on a bare engine
clone (Claude Code app cloud sandbox). Before finishing, write your final commit's body as
a session summary: what was asked, what was decided, what was built and why, open
questions. The merge coordinator distills it into the owning scope's `sources/` at merge;
an unmerged branch leaves no trace. On a full checkout (`memory/` present) this rule is
dormant.

## Resume packet

Orient: each active Project's roadmap Now/Next → newest ledger entries.
(Seeded fresh at port cutover; keep this section short and current.)

<!-- managed:reconciler:begin schema=2 inputs=none -->
## Rules (projected from memory: do not edit; edit the source node)
_(no rules currently meet the always-load bar; see retrieval-gated memory)_
<!-- managed:reconciler:end -->
