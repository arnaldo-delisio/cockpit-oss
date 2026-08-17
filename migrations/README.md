# Migrations

Migrations exist solely for INSTANCE DATA shape changes (the private `memory/` repo's
files). Engine-only changes never need one: the engine ships whole with each tag, there is
nothing to migrate.

## Format

- One file per migration: `NNN-slug.mjs` (zero-padded ordinal, kebab slug), run in
  lexicographic order.
- Each exports an async `up()` that transforms instance data in place and is IDEMPOTENT:
  running it against already-migrated data is a no-op, never a corruption. There is no
  `down()`; rollback is `update.sh`'s snapshot restore, not reverse migrations.
- Applied migrations are recorded by filename, one per line, in
  `memory/.migrations-applied` (instance data, not the engine repo), written by `update.sh`
  after each successful `up()`. A name present there is never re-run.
- Resolve paths through `memory-engine/paths.mjs` (`MEMORY_ROOT`), never hardcode.

No migration files exist yet, deliberately: the first one is written when the first real
instance-data shape change ships, not speculatively.
