# Cockpit, Builder Shell (Claude Code)

@doctrine.md

## Identity

- **Claude Code = builder/engineer** (singular). **Hermes = operator/agent fleet.**
  A VPS-level orchestrator manages the box and spawns and manages sessions on it, but no
  agent owns the shared memory: coordination runs through the shared board + human and
  outlives any single agent (OM-13). Identity is per-context
  (OM-3): every real identity lives in its scope workspace under `scopes/` in this tree (a
  nested private repo, gitignored by the engine repo).
- Skills ship with the engine; shared memory lives in the nested private `memory/` repo,
  the substrate both brains read and write.

## Orientation

- Decisions, design specs, roadmaps: the scope CLAUDE.md carries the spine map (DOC-3);
  the cockpit's own map lives in the repo-root CLAUDE.md build context.
- Work in the owning scope: when a topic belongs to a venture scope, move to that scope's
  session before going deep.
