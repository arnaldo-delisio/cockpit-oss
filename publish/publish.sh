#!/usr/bin/env bash
# publish.sh, the public export of the cockpit engine.
#
# Builds a curated copy of this repo into a fresh directory and makes exactly one
# commit there. It never pushes. It never calls gh. It never adds a remote.
# Pushing is a deliberate human step, done by hand after reading the verification
# block below. The script prints the suggested `gh repo create` command at the end
# and stops there.
#
# Default is DRY: prints what it would export and writes nothing. Pass --apply to
# build the export (same flag convention as provision/install.sh).
#
# Usage:
#   publish/publish.sh                        dry run, default target
#   publish/publish.sh --apply                build the export
#   publish/publish.sh <dir>                  dry run, custom target
#   publish/publish.sh <dir> --apply          build the export at <dir>
#
# Safety properties, in order of importance:
#   1. The file list comes from `git ls-files` only, never from a filesystem walk,
#      and the content comes from `git archive HEAD`, never from the working tree.
#      Untracked, gitignored, and locally modified content cannot enter the export.
#   2. publish/manifest.txt is the only source of exclusions.
#   3. The target directory is wiped each run, but only if it is absent or carries
#      the marker file this script writes, with this script's magic line inside it.
#      A human pointed directory is never rm'd, and neither is the source repo or
#      anything inside it.
#   4. Verification runs after the commit and fails the script on any problem.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST="$SRC/publish/manifest.txt"
MARKER=".cockpit-export-marker"
MARKER_MAGIC="cockpit-export-marker v1"

APPLY=0
DEST=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -*) echo "publish.sh: unknown flag: $arg" >&2; exit 1 ;;
    *) DEST="$arg" ;;
  esac
done
DEST="${DEST:-$SRC/../cockpit-oss-export}"
mkdir -p "$(dirname "$DEST")"
DEST="$(cd "$(dirname "$DEST")" && pwd -P)/$(basename "$DEST")"

# The destination is wiped, so it must never be the source repo or live inside it.
# Both sides are already resolved to absolute real paths above.
if [ "$DEST" = "$SRC" ] || [ "${DEST#"$SRC"/}" != "$DEST" ]; then
  echo "publish.sh: refusing to use $DEST as the target." >&2
  echo "  It is the source repo $SRC, or a directory inside it." >&2
  echo "  The target is wiped on every run. Pick a path outside the source repo." >&2
  exit 1
fi

[ -f "$MANIFEST" ] || { echo "publish.sh: manifest not found: $MANIFEST" >&2; exit 1; }

# ── 0. Owner source tree gate ─────────────────────────────────────────────────
# This script ships INSIDE the export it builds, for transparency: a reader can see
# exactly what is held back and why. It cannot run there, and must say so plainly
# instead of failing as if something were broken. publish/private-terms.txt is the
# discriminator: the manifest excludes it from every export by a must-match rule, so
# it is present in the source tree and absent in any copy this script produced.
# Without it the export is already the export, the private paths the manifest names
# are legitimately gone, and every must-match rule would report a phantom typo.
if [ ! -f "$SRC/publish/private-terms.txt" ]; then
  cat <<EOF
publish.sh: this tree is a public export of the cockpit engine, not the owner's
source tree, so there is nothing to export from here.

  The export machinery ships so the public boundary is readable: publish/manifest.txt
  lists exactly what is held back, and this script shows how. Running it needs the
  private source tree it exports FROM, identified by publish/private-terms.txt, which
  by design never travels.

  Nothing was written, and nothing is wrong with this clone.
EOF
  exit 0
fi

# ── 1. Clean tree gate ────────────────────────────────────────────────────────
# An export must correspond to a real commit, so tracked changes block the run.
# Untracked files are reported but do not block: they cannot reach the export,
# since the file list comes from git ls-files.
dirty="$(git -C "$SRC" status --porcelain --untracked-files=no)"
if [ -n "$dirty" ]; then
  echo "publish.sh: the engine working tree has uncommitted tracked changes." >&2
  echo "  Commit or stash them, then rerun. Offending paths:" >&2
  printf '%s\n' "$dirty" | sed 's/^/    /' >&2
  exit 1
fi
untracked="$(git -C "$SRC" ls-files --others --exclude-standard)"
if [ -n "$untracked" ]; then
  echo "NOTE: untracked files present. They are never exported. Paths:"
  printf '%s\n' "$untracked" | sed 's/^/    /'
fi

HEAD_SHA="$(git -C "$SRC" rev-parse --short HEAD)"

# ── 2. Manifest rules ─────────────────────────────────────────────────────────
RULES=()
RULE_ZERO=()   # 1 when the rule is allowed to match zero files, 0 when it must match.
KEEPS=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
  esac
  if [ "${line:0:1}" = "!" ]; then
    KEEPS+=("${line:1}")
  elif [ "${line:0:1}" = "?" ]; then
    RULES+=("${line:1}"); RULE_ZERO+=(1)
  else
    RULES+=("$line"); RULE_ZERO+=(0)
  fi
done < "$MANIFEST"

# Returns 0 when the repo relative path must be excluded.
is_excluded() {
  local p="$1" k r
  for k in "${KEEPS[@]}"; do
    [ "$p" = "$k" ] && return 1
    [[ "$p" == $k ]] && return 1
  done
  for r in "${RULES[@]}"; do
    case "$r" in
      */) [[ "$p" == "$r"* ]] && return 0 ;;
      *[*?]*) [[ "$p" == $r ]] && return 0 ;;
      *) [ "$p" = "$r" ] && return 0 ;;
    esac
  done
  return 1
}

# ── 3. Split the tracked file list ────────────────────────────────────────────
KEPT=()
DROPPED=()
while IFS= read -r -d '' f; do
  if is_excluded "$f"; then DROPPED+=("$f"); else KEPT+=("$f"); fi
done < <(git -C "$SRC" ls-files -z)

echo
echo "source:   $SRC (at $HEAD_SHA)"
echo "manifest: $MANIFEST"
echo "target:   $DEST"
echo "tracked files: $(( ${#KEPT[@]} + ${#DROPPED[@]} ))   exported: ${#KEPT[@]}   excluded: ${#DROPPED[@]}"
echo
echo "excluded by rule:"
DEAD_RULES=()
for i in "${!RULES[@]}"; do
  r="${RULES[$i]}"
  n=0
  for f in "${DROPPED[@]}"; do
    case "$r" in
      */) [[ "$f" == "$r"* ]] && n=$((n+1)) ;;
      *[*?]*) [[ "$f" == $r ]] && n=$((n+1)) ;;
      *) [ "$f" = "$r" ] && n=$((n+1)) ;;
    esac
  done
  note=""
  [ "${RULE_ZERO[$i]}" -eq 1 ] && note="   (expected zero)"
  printf '  %-70s %d file(s)%s\n' "$r" "$n" "$note"
  if [ "$n" -eq 0 ] && [ "${RULE_ZERO[$i]}" -eq 0 ]; then DEAD_RULES+=("$r"); fi
done
if [ "${#DEAD_RULES[@]}" -gt 0 ]; then
  echo
  echo "  must-match rules that matched nothing (likely typos):"
  for r in "${DEAD_RULES[@]}"; do echo "    $r"; done
  echo "  Fix each rule, or prefix it with ? if it is defensive and expected to match zero."
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  if [ "${#DEAD_RULES[@]}" -gt 0 ]; then
    echo "DRY RUN FAILED: ${#DEAD_RULES[@]} manifest rule(s) matched nothing."
    exit 1
  fi
  echo "DRY RUN. Nothing was written. Pass --apply to build the export."
  exit 0
fi

# ── 4. Git identity, taken from the source repo ───────────────────────────────
GIT_NAME="$(git -C "$SRC" config user.name || true)"
GIT_EMAIL="$(git -C "$SRC" config user.email || true)"
if [ -z "$GIT_NAME" ] || [ -z "$GIT_EMAIL" ]; then
  echo "publish.sh: no git identity found in $SRC." >&2
  echo "  The export commit needs an author. Set it, then rerun:" >&2
  echo "    git -C $SRC config user.name \"Your Name\"" >&2
  echo "    git -C $SRC config user.email \"you@example.com\"" >&2
  exit 1
fi

# ── 5. Fresh target directory ─────────────────────────────────────────────────
if [ -e "$DEST" ]; then
  if [ ! -f "$DEST/$MARKER" ] || ! grep -qxF "$MARKER_MAGIC" "$DEST/$MARKER" 2>/dev/null; then
    echo "publish.sh: refusing to wipe $DEST." >&2
    echo "  It exists but carries no $MARKER file written by this script, so it is" >&2
    echo "  not a previous export. Move it aside, or pick another target directory." >&2
    exit 1
  fi
  rm -rf "$DEST"
fi
mkdir -p "$DEST"
printf '%s\nWritten by cockpit publish/publish.sh from %s. This directory is a generated\nexport. It is wiped and rebuilt on every run. Do not keep hand edits here.\n' \
  "$MARKER_MAGIC" "$SRC" > "$DEST/$MARKER"

# ── 6. Materialize the kept files from HEAD ───────────────────────────────────
# Content comes from the commit, not from the working tree, so a smudge filter or
# any local divergence cannot put unexpected bytes into an exported path.
# Paths are passed as literal pathspecs. Older git has no --pathspec-from-file for
# archive, so the list goes in batches there. Both branches extract the same bytes.
if git archive -h 2>&1 | grep -q -- '--pathspec-from-file'; then
  PATHSPEC_FILE="$(mktemp)"
  trap 'rm -f "$PATHSPEC_FILE"' EXIT
  printf ':(literal)%s\0' "${KEPT[@]}" > "$PATHSPEC_FILE"
  git -C "$SRC" archive --format=tar \
    --pathspec-from-file="$PATHSPEC_FILE" --pathspec-file-nul HEAD | tar -x -C "$DEST"
else
  batch=()
  flush_batch() {
    [ "${#batch[@]}" -eq 0 ] && return 0
    git -C "$SRC" archive --format=tar HEAD -- "${batch[@]}" | tar -x -C "$DEST"
    batch=()
  }
  for f in "${KEPT[@]}"; do
    batch+=(":(literal)$f")
    [ "${#batch[@]}" -ge 200 ] && flush_batch
  done
  flush_batch
fi

extracted="$(find "$DEST" -mindepth 1 ! -type d ! -path "$DEST/$MARKER" -printf x | wc -c)"
if [ "$extracted" -ne "${#KEPT[@]}" ]; then
  echo "publish.sh: extracted $extracted file(s) but expected ${#KEPT[@]}." >&2
  echo "  The export does not match the selected file list. Nothing was committed." >&2
  exit 1
fi

# ── 6b. Regenerate the public decision index ──────────────────────────────────
# The index maps the decision IDs cited all over the shipped code and docs to a
# short title, so a public reader is not left with dead shorthand. It is derived
# from the private ledger, which never travels.
#
# It is generated INTO THE EXPORT, never into the source repo. Two reasons, both
# structural: the clean tree gate above has already passed, so writing a tracked
# file into the source mid-run would dirty the tree the gate just cleared; and the
# export's content comes from `git archive HEAD`, so a fresh write into the source
# working tree would not reach the export anyway. Generating into $DEST keeps the
# gate exactly as strict as it was and still makes drift impossible in the
# artifact that ships. The tracked source copy is checked separately below.
INDEX_FILE="DECISIONS-INDEX.md"
INDEX_GEN="$SRC/publish/gen-id-index.mjs"
INDEX_STATE="skipped"
if [ -f "$INDEX_GEN" ] && [ -f "$SRC/DECISIONS.md" ]; then
  if node "$INDEX_GEN" --out "$DEST/$INDEX_FILE"; then
    INDEX_STATE="generated"
  else
    echo "publish.sh: the decision index generator failed. Nothing was committed." >&2
    exit 1
  fi
else
  echo "NOTE: no private ledger in this tree, so $INDEX_FILE was not regenerated."
fi

# ── 6c. Reset the reconciler's managed regions ────────────────────────────────
# Every always-load file the reconciler targets carries a fenced region of rules
# projected out of the owner's graph. Those rules link to node files that never
# ship, and they describe the owner's own ventures. A cloner reading the export
# before running anything would read them as the project's constitution.
#
# The region is reset to the exact empty state the reconciler writes when no rule
# meets the always-load bar, so the first reconcile on a fresh install recognises
# it. Hand-editing the source copy would not work: the reconciler owns the region
# and rewrites it in this tree on every run.
#
# Targets are the EXPLICIT projection paths, asked of the reconciler itself
# (memory-engine/projection.mjs, repoProjectionPaths(), derived from targetFor()).
# Walking by basename was wrong: documentation, examples, and tests quote the fence
# markers, and any file named CLAUDE.md or SOUL.md anywhere in the export would have
# been rewritten. The derivation fails the run rather than falling back, so a broken
# import cannot silently reset nothing and let a projected region ship.
if ! PROJECTION_PATHS="$(node --input-type=module -e \
  "import { repoProjectionPaths } from '$SRC/memory-engine/projection.mjs'; console.log(repoProjectionPaths().join('\n'));")"; then
  echo "publish.sh: could not read the projection targets from memory-engine/projection.mjs." >&2
  echo "  Nothing was committed." >&2
  exit 1
fi
echo
echo "managed regions:"
MANAGED_FILES=()
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ -f "$DEST/$p" ]; then
    MANAGED_FILES+=("$DEST/$p")
  else
    echo "  projection target not in the export (excluded by the manifest): $p"
  fi
done <<< "$PROJECTION_PATHS"
RESET_GEN="$SRC/publish/reset-managed-region.mjs"
if [ "${#MANAGED_FILES[@]}" -eq 0 ]; then
  echo "  no always-load files in the export"
elif ! node "$RESET_GEN" --reset "${MANAGED_FILES[@]}"; then
  echo "publish.sh: resetting the managed regions failed. Nothing was committed." >&2
  exit 1
fi

# ── 7. One commit ─────────────────────────────────────────────────────────────
git -C "$DEST" init -q
git -C "$DEST" symbolic-ref HEAD refs/heads/main
git -C "$DEST" config user.name "$GIT_NAME"
git -C "$DEST" config user.email "$GIT_EMAIL"
# The marker is export machinery, not shipped content.
printf '%s\n' "$MARKER" > "$DEST/.git/info/exclude"
git -C "$DEST" add -A
git -C "$DEST" commit -q -m "Cockpit engine, public export

Curated export of the cockpit engine, built by publish/publish.sh from
source commit $HEAD_SHA. Private data, the owner's decision ledger, and
vendored third party skills are excluded per publish/manifest.txt."

# ── 8. Verification, after the commit ─────────────────────────────────────────
FAILURES=()
fail() { FAILURES+=("$1"); }

echo
echo "============================ VERIFICATION ============================"

# (a) exclusions absent from the working tree and from all reachable objects
leak_tree=0
while IFS= read -r -d '' f; do
  [ "$f" = "$MARKER" ] && continue
  if is_excluded "$f"; then echo "  LEAK in worktree: $f"; leak_tree=$((leak_tree+1)); fi
done < <(cd "$DEST" && git ls-files -z)
leak_hist=0
# rev-list --objects has no NUL delimited form. Git quotes any path with an odd
# byte in it, so such a path still arrives as one line. It cannot be compared to
# the rules reliably, so it is reported for a human to look at.
while IFS= read -r p; do
  [ -z "$p" ] && continue
  [ "$p" = "$MARKER" ] && continue
  if [ "${p:0:1}" = '"' ]; then
    echo "  UNCOMPARABLE path in history (quoted by git): $p"
    leak_hist=$((leak_hist+1))
    continue
  fi
  if is_excluded "$p"; then echo "  LEAK in history: $p"; leak_hist=$((leak_hist+1)); fi
done < <(git -C "$DEST" rev-list --objects --all | cut -d' ' -f2-)
if [ "$leak_tree" -eq 0 ] && [ "$leak_hist" -eq 0 ]; then
  echo "a. exclusions: PASS (no excluded path in the worktree or in any object)"
else
  echo "a. exclusions: FAIL ($leak_tree worktree, $leak_hist history)"
  fail "excluded paths present in the export"
fi

# (b) exactly one commit
commits="$(git -C "$DEST" rev-list --count HEAD)"
branch="$(git -C "$DEST" branch --show-current)"
if [ "$commits" = "1" ] && [ "$branch" = "main" ]; then
  echo "b. history: PASS (1 commit on branch main)"
else
  echo "b. history: FAIL ($commits commit(s) on branch '$branch')"
  fail "export history is not a single commit on main"
fi

# (c) no source .git or source history leaked in
stray="$(find "$DEST" -mindepth 2 -name .git -print)"
parent_in_export=0
if git -C "$DEST" cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null; then parent_in_export=1; fi
if [ -z "$stray" ] && [ "$parent_in_export" -eq 0 ]; then
  echo "c. isolation: PASS (no nested .git, source commit $HEAD_SHA unknown to the export)"
else
  [ -n "$stray" ] && printf '  nested .git: %s\n' "$stray"
  [ "$parent_in_export" -eq 1 ] && echo "  source commit $HEAD_SHA is reachable in the export"
  echo "c. isolation: FAIL"
  fail "source git data leaked into the export"
fi

# (d) secret scan
echo "d. secret scan:"
hits=0
scan_errors=0
# The scanned file list is read once, NUL delimited, and passed to grep directly.
# No xargs, so grep's own exit status survives: 0 match, 1 no match, anything else
# is a scanner error and must not read as a clean pass. Binary files are scanned as
# bytes (-a), since a tracked binary can carry a key just as well as a text file.
SCAN_FILES=()
while IFS= read -r -d '' f; do SCAN_FILES+=("$f"); done < <(cd "$DEST" && git ls-files -z)
scan() {
  local label="$1"; shift
  local out status
  set +e
  out="$(cd "$DEST" && grep -naH "$@" -- "${SCAN_FILES[@]}" 2>&1)"
  status=$?
  set -e
  if [ "$status" -gt 1 ]; then
    printf '   %s: SCANNER ERROR (grep exit %d)\n' "$label" "$status"
    printf '%s\n' "$out" | sed 's/^/     /'
    scan_errors=$((scan_errors + 1))
    return
  fi
  if [ -n "$out" ]; then
    printf '   %s:\n' "$label"
    printf '%s\n' "$out" | sed 's/^/     /'
    hits=$((hits + $(printf '%s\n' "$out" | wc -l)))
  fi
}
# Boundary and length matter. A bare `sk-` matches ordinary English (task-, risk-,
# Flask-), which buries the real hits in noise. Require a word start and a key
# length body.
scan "key shaped strings" -E \
  -e '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}' \
  -e '(^|[^A-Za-z0-9])ghp_[A-Za-z0-9]{20,}' \
  -e '(^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}' \
  -e '(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}' \
  -e '-----BEGIN [A-Z ]*PRIVATE KEY-----'
# The owner's email and home path are derived at runtime, never written here as
# literals. A literal would make this file match its own scan once publish/ ships,
# and would only ever be correct on one machine.
SCAN_SKIPPED=()
if [ -n "$GIT_EMAIL" ]; then
  scan "owner email" -F -e "$GIT_EMAIL"
else
  echo "   NOTE: owner email check skipped, git config user.email is unset in $SRC."
  SCAN_SKIPPED+=("owner email")
fi
OWNER_HOME="${HOME:-}"
if [ -n "$OWNER_HOME" ] && [ "$OWNER_HOME" != "/" ]; then
  scan "owner home path" -F -e "$OWNER_HOME"
else
  echo "   NOTE: owner home path check skipped, HOME is unset or is the filesystem root."
  SCAN_SKIPPED+=("owner home path")
fi
if [ "$scan_errors" -gt 0 ]; then
  echo "   FAIL ($scan_errors scanner error(s) above; the scan did not run clean)"
  fail "secret scan hit $scan_errors scanner error(s)"
  [ "$hits" -gt 0 ] && fail "secret scan found $hits hit(s)"
elif [ "$hits" -eq 0 ]; then
  if [ "${#SCAN_SKIPPED[@]}" -gt 0 ]; then
    skipped_list=""
    for s in "${SCAN_SKIPPED[@]}"; do
      [ -n "$skipped_list" ] && skipped_list="$skipped_list, "
      skipped_list="$skipped_list$s"
    done
    echo "   PASS (no hits; skipped: $skipped_list)"
  else
    echo "   PASS (no hits)"
  fi
else
  echo "   FAIL ($hits hit(s) above)"
  fail "secret scan found $hits hit(s)"
fi

# (e) manifest rules that matched nothing
if [ "${#DEAD_RULES[@]}" -eq 0 ]; then
  echo "e. manifest: PASS (every must-match rule matched at least one file)"
else
  for r in "${DEAD_RULES[@]}"; do echo "  dead rule: $r"; done
  echo "e. manifest: FAIL (${#DEAD_RULES[@]} must-match rule(s) matched nothing)"
  fail "${#DEAD_RULES[@]} manifest rule(s) matched nothing"
fi

# (f) private terms, swept over the finished export
# The generator refuses to write a title carrying a private name, but that only
# covers one file. This is the check that matters: every tracked file in the
# committed export, scanned for every term in the scrub list. Terms marked ~ in
# that list are reported and not failed, because the owner's own name is public
# in this repo by design (LICENSE carries the copyright holder).
echo "f. private terms:"
TERMS_FILE="$SRC/publish/private-terms.txt"
if [ ! -f "$TERMS_FILE" ]; then
  echo "   FAIL (scrub list not found at $TERMS_FILE)"
  fail "private terms list missing, the export was never swept"
else
  term_hits=0
  soft_hits=0
  term_errors=0
  term_count=0
  while IFS= read -r line; do
    line="${line%%$'\r'}"
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$line" in ''|'#'*) continue ;; esac
    soft=0
    case "$line" in '~'*) soft=1; line="${line#\~}" ;; esac
    term="${line%%=*}"
    term="$(printf '%s' "$term" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$term" ] && continue
    term_count=$((term_count + 1))
    # The term is matched case insensitively and only where neither neighbour is
    # a letter or a digit, the same boundary rule the generator applies.
    pattern="(^|[^A-Za-z0-9])$(printf '%s' "$term" | sed 's/[][\\.^$*+?(){}|]/\\&/g')([^A-Za-z0-9]|$)"
    set +e
    out="$(cd "$DEST" && grep -naHiE "$pattern" -- "${SCAN_FILES[@]}" 2>&1)"
    status=$?
    set -e
    if [ "$status" -gt 1 ]; then
      printf '   %s: SCANNER ERROR (grep exit %d)\n' "$term" "$status"
      term_errors=$((term_errors + 1))
      continue
    fi
    [ -z "$out" ] && continue
    n="$(printf '%s\n' "$out" | wc -l)"
    if [ "$soft" -eq 1 ]; then
      printf '   NOTE: %s appears %d time(s) (reported, not a leak)\n' "$term" "$n"
      soft_hits=$((soft_hits + n))
    else
      printf '   LEAK: %s\n' "$term"
      printf '%s\n' "$out" | sed 's/^/     /'
      term_hits=$((term_hits + n))
    fi
  done < "$TERMS_FILE"
  if [ "$term_errors" -gt 0 ]; then
    echo "   FAIL ($term_errors scanner error(s); the sweep did not run clean)"
    fail "private term sweep hit $term_errors scanner error(s)"
  elif [ "$term_hits" -gt 0 ]; then
    echo "   FAIL ($term_hits occurrence(s) of a private term in the export)"
    fail "private terms present in the export"
  else
    echo "   PASS ($term_count term(s) swept, 0 leaks, $soft_hits reported occurrence(s))"
  fi
fi

# (g) the tracked index copy agrees with the ledger
# The export always carries a freshly generated index, so the export cannot drift.
# The copy committed in the source repo can, and a reader of the source repo would
# then see stale titles, so it is checked here rather than rewritten mid-run.
if [ "$INDEX_STATE" = "generated" ]; then
  if node "$INDEX_GEN" --check "$SRC/$INDEX_FILE" 2>/dev/null; then
    echo "g. decision index: PASS (export regenerated, source copy agrees with the ledger)"
  else
    echo "g. decision index: FAIL (the $INDEX_FILE committed in $SRC is stale)"
    echo "   Run: node publish/gen-id-index.mjs   then commit the result."
    fail "the source repo's $INDEX_FILE is out of date with the ledger"
  fi
else
  echo "g. decision index: SKIPPED (no private ledger in this tree)"
fi

# (h) no projected rules left in any shipped always-load file
# Step 6c reset them. This is the check that they are actually empty in the
# committed export, since a rule that ships is the owner's private graph read as
# the project's own doctrine.
if [ "${#MANAGED_FILES[@]}" -eq 0 ]; then
  echo "h. managed regions: PASS (no always-load files in the export)"
elif node "$RESET_GEN" --check "${MANAGED_FILES[@]}"; then
  echo "h. managed regions: PASS (${#MANAGED_FILES[@]} always-load file(s), every managed region empty)"
else
  echo "h. managed regions: FAIL (a shipped managed region still carries projected rules)"
  fail "projected rules present in a shipped managed region"
fi

# (i) size
file_count="$(cd "$DEST" && git ls-files -z | tr -cd '\0' | wc -c)"
total_size="$(du -sh --exclude=.git "$DEST" | cut -f1)"
echo "i. contents: $file_count tracked file(s), $total_size on disk (excluding .git)"

echo "======================================================================"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "RESULT: FAIL"
  for m in "${FAILURES[@]}"; do echo "  - $m"; done
  exit 1
fi
echo "RESULT: PASS"
echo
echo "Export ready at $DEST"
echo "Nothing was pushed. Publishing is a deliberate human step. When you have read"
echo "the block above and want it public, run this yourself:"
echo
echo "    cd $DEST && gh repo create cockpit-oss --public --source=. --remote=origin --push"
echo
