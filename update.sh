#!/usr/bin/env bash
# update.sh <tag>, the fleet update contract (port layout §8).
#
# Releases are annotated tags vN.N.N on the engine repo; a VPS never tracks main. Sequence:
# fetch tags → checkout tag → per-surface installs where lockfiles changed → snapshot
# instance data → run pending migrations → regenerate → dry-run verify → report. On ANY
# failure everything the run touched rolls back together (Codex finding 6): instance-data
# snapshot restored, previous ref checked out, regeneration re-run from it. Never the tag
# alone.
#
# Default is DRY (prints the plan; first-execution-dry-run doctrine): update.sh <tag> --apply
# to act.

set -euo pipefail

# Same noninteractive git-over-ssh policy as provision/install.sh: unattended updates must
# fail clearly on a missing/changed host key or absent deploy key, never prompt.
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"

REPO_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
MEMORY_DIR="$REPO_ROOT/memory"
MIGRATIONS_DIR="$REPO_ROOT/migrations"
APPLIED_FILE="$MEMORY_DIR/.migrations-applied"
SOUL_GEN="$REPO_ROOT/shells/SOUL.generated.md"
SETTINGS="$HOME/.claude/settings.json"

TAG="${1:-}"
APPLY=0
if [ "${2:-}" = "--apply" ]; then APPLY=1; fi
[ -n "$TAG" ] || { echo "usage: update.sh <tag> [--apply]" >&2; exit 1; }

if [ "$APPLY" -eq 0 ]; then
  cat <<EOF
update.sh: DRY RUN for tag $TAG (pass --apply to act). Plan:
  1. git fetch --tags; record current ref; git checkout $TAG
  2. npm ci in memory-engine if its package-lock.json changed between refs
  3. snapshot instance data to $MEMORY_DIR/.update-snapshots/<ts>/:
     tar of memory/ + copies of $SETTINGS and $SOUL_GEN
  4. run pending $MIGRATIONS_DIR/NNN-*.mjs (those not in $APPLIED_FILE), each up()
  5. regenerate: node $REPO_ROOT/bootstrap.mjs --cutover
  6. verify: reconcile --dry-run; one recall invocation
  7. advance ~/cockpit-template to the same tag if it exists (warning-only, never rolls
     back: the template holds no state and runs nothing)
  8. print report
  On any failure: restore the snapshot, checkout the previous ref, re-run regeneration.
EOF
  exit 0
fi

cd "$REPO_ROOT"
# A parked pre-update tree means a previous rollback failed mid-restore; running anything
# further could destroy the only good copy. Manual recovery first, no mutation here.
if [ -e "$MEMORY_DIR.rollback-tmp" ]; then
  echo "update.sh: $MEMORY_DIR.rollback-tmp exists: a previous incomplete rollback left the pre-update memory tree parked there. Recover it by hand before any further update." >&2
  exit 1
fi
PREV_REF="$(git describe --tags --exact-match 2>/dev/null || git rev-parse HEAD)"
SNAP_DIR="$MEMORY_DIR/.update-snapshots/$(date +%Y%m%dT%H%M%S)"
SNAPSHOTTED=0

rollback() {
  echo "update.sh: FAILURE, rolling back everything this run touched" >&2
  # Attempt EVERY restoration step, collect failures, and never claim a clean rollback
  # after a partial one (round 5 finding 2).
  FAILED_STEPS=""
  fail_step() { FAILED_STEPS="$FAILED_STEPS $1"; echo "update.sh: rollback step failed: $1" >&2; }
  if [ "$SNAPSHOTTED" -eq 1 ]; then
    # The snapshot dir lives under memory/ (excluded from its own tar); park the possibly
    # migrated tree aside FIRST, then restore from the parked copy's snapshot.
    # Explicit per-command checks: `fn || handler` disables errexit inside fn, so without
    # them a failed tar could fall through to the final rm -rf and LOSE the parked
    # pre-update tree. The parked tree is removed only after every restore step succeeded.
    restore_memory() {
      # Never delete a prior parked tree: it can only exist here if something went badly
      # wrong before, and it may be the only good copy.
      if [ -e "$MEMORY_DIR.rollback-tmp" ]; then
        echo "update.sh: $MEMORY_DIR.rollback-tmp unexpectedly already exists, refusing to touch it" >&2
        return 1
      fi
      if ! mv "$MEMORY_DIR" "$MEMORY_DIR.rollback-tmp"; then return 1; fi
      PARKED_SNAP="$MEMORY_DIR.rollback-tmp/.update-snapshots/$(basename "$SNAP_DIR")"
      if ! tar -xzf "$PARKED_SNAP/memory.tar.gz" -C "$REPO_ROOT"; then return 1; fi
      # Carry the snapshot history back into the restored tree.
      if ! mkdir -p "$MEMORY_DIR/.update-snapshots"; then return 1; fi
      if ! cp -r "$MEMORY_DIR.rollback-tmp/.update-snapshots/." "$MEMORY_DIR/.update-snapshots/"; then return 1; fi
      if [ -f "$PARKED_SNAP/settings.json" ]; then
        if ! cp "$PARKED_SNAP/settings.json" "$SETTINGS"; then return 1; fi
      elif [ -f "$PARKED_SNAP/settings.json.ABSENT" ]; then
        if ! rm -f "$SETTINGS"; then return 1; fi
      fi
      if [ -f "$PARKED_SNAP/SOUL.generated.md" ]; then
        if ! cp "$PARKED_SNAP/SOUL.generated.md" "$SOUL_GEN"; then return 1; fi
      elif [ -f "$PARKED_SNAP/SOUL.generated.md.ABSENT" ]; then
        if ! rm -f "$SOUL_GEN"; then return 1; fi
      fi
      rm -rf "$MEMORY_DIR.rollback-tmp"
    }
    if restore_memory; then
      MEMORY_RESTORED=1
    else
      MEMORY_RESTORED=0
      fail_step "memory-and-generated-files-restore"
      echo "update.sh: pre-update memory tree preserved at $MEMORY_DIR.rollback-tmp (NOT removed)" >&2
    fi
  fi
  git checkout --quiet "$PREV_REF" || fail_step "engine-checkout"
  # Dependency state must roll back with the code: re-run the same lockfile-gated installs
  # in reverse (finding 5).
  if ! git diff --quiet "$PREV_REF" "$TAG" -- memory-engine/package-lock.json 2>/dev/null; then
    (cd "$REPO_ROOT/memory-engine" && npm ci) || fail_step "memory-engine-npm-ci"
  fi
  # Regenerate only if the update reached the point where bootstrap ran (post-snapshot)
  # AND the memory restore succeeded: regenerating over an unrestored tree would bake the
  # failed state into the generated files.
  if [ "$SNAPSHOTTED" -eq 1 ] && [ "${MEMORY_RESTORED:-0}" -eq 1 ]; then
    node "$REPO_ROOT/bootstrap.mjs" --cutover || fail_step "regeneration"
  fi
  if [ -z "$FAILED_STEPS" ]; then
    echo "update.sh: rolled back to $PREV_REF" >&2
  else
    echo "update.sh: INCOMPLETE ROLLBACK to $PREV_REF. Failed steps:$FAILED_STEPS. The instance may not match $PREV_REF; manual inspection is MANDATORY before using it." >&2
  fi
  exit 1
}

echo "update.sh: updating $PREV_REF → $TAG"
git fetch --tags
# Releases are ANNOTATED tags (layout §8); refuse anything else before any mutation
# (nothing is touched yet, so this needs no rollback).
if [ "$(git cat-file -t "refs/tags/$TAG" 2>/dev/null)" != "tag" ]; then
  echo "update.sh: $TAG is not an annotated release tag, refusing" >&2
  exit 1
fi
# The checkout below is the FIRST mutation; the trap goes live only now, so any failure
# above exits plainly with nothing to roll back.
trap rollback ERR
git checkout --quiet "$TAG"

# Per-surface installs only where lockfiles changed between refs (layout §8, Codex finding 7).
if ! git diff --quiet "$PREV_REF" "$TAG" -- memory-engine/package-lock.json; then
  (cd "$REPO_ROOT/memory-engine" && npm ci)
else
  echo "update.sh: memory-engine lockfile unchanged, skipping npm ci"
fi

# Snapshot BEFORE migrations: tar of memory/ plus the generated out-of-repo files.
mkdir -p "$SNAP_DIR"
tar --exclude='memory/.update-snapshots' -czf "$SNAP_DIR/memory.tar.gz" -C "$REPO_ROOT" memory
# For each bootstrap-owned external file: copy the preimage, or write an absence marker so
# rollback can remove a file the failed run created (exact pre-update state either way).
if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$SNAP_DIR/settings.json"; else touch "$SNAP_DIR/settings.json.ABSENT"; fi
if [ -f "$SOUL_GEN" ]; then cp "$SOUL_GEN" "$SNAP_DIR/SOUL.generated.md"; else touch "$SNAP_DIR/SOUL.generated.md.ABSENT"; fi
SNAPSHOTTED=1
echo "update.sh: instance snapshot at $SNAP_DIR"

# Pending migrations (format: migrations/README.md; applied names recorded in instance data).
touch "$APPLIED_FILE"
for m in "$MIGRATIONS_DIR"/[0-9][0-9][0-9]-*.mjs; do
  [ -e "$m" ] || continue
  name="$(basename "$m")"
  if grep -qxF "$name" "$APPLIED_FILE"; then
    echo "update.sh: migration $name already applied"
    continue
  fi
  echo "update.sh: running migration $name"
  node -e "const m = await import(process.argv[1]); await m.up();" "$m"
  echo "$name" >> "$APPLIED_FILE"
done

# Regenerate everything bootstrap owns (loaders, settings hooks, SOUL concat, scope dirs).
node "$REPO_ROOT/bootstrap.mjs" --cutover

# Dry-run verify: exercise real surfaces without writes.
node "$REPO_ROOT/memory-engine/reconcile.mjs" --dry-run
node "$REPO_ROOT/memory-engine/recall.mjs" --scope cockpit "update smoke check" >/dev/null
echo "update.sh: recall invocation OK"

trap - ERR

# Template tree rides along AFTER a fully successful update, outside the transaction: it
# holds no instance state and runs nothing, so a failure here is a warning, never a
# rollback trigger.
TEMPLATE_DIR="$HOME/cockpit-template"
if [ -d "$TEMPLATE_DIR/.git" ]; then
  if (cd "$TEMPLATE_DIR" && git fetch --tags && git checkout --quiet "$TAG"); then
    echo "update.sh: template tree advanced to $TAG"
  else
    echo "update.sh: WARNING, template tree at $TEMPLATE_DIR failed to advance to $TAG (instance update unaffected)"
  fi
fi

echo "update.sh: REPORT"
echo "  previous: $PREV_REF"
echo "  now:      $TAG"
echo "  snapshot: $SNAP_DIR"
echo "  verify:   reconcile --dry-run OK, recall OK"
