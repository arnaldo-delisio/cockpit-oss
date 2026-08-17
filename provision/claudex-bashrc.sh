#!/usr/bin/env bash
# claudex-bashrc.sh — installs the `claudex` launcher into a bashrc, idempotently.
#
# Called by provision/install.sh (§10b) with the target file as $1, and directly by
# memory-engine/test/claudex-alias-migration.test.mjs against a scratch file. It lives in its
# own script so the migration can be tested without running the whole VPS install.
#
# A function, not an alias: the choice is read at call time from COCKPIT_SKIP_PERMISSIONS,
# matching provision/aliases.sh on the laptop side. Older boxes got a hardcoded
# `alias claudex="claude --dangerously-skip-permissions"` here, and an alias shadows a
# function of the same name, so the legacy line is removed before the block is written.
#
# The removal matches any VALID spelling of that declaration, not the one literal form the
# first version happened to write: leading whitespace, extra spaces around `alias`, and any
# quoting all declare the same alias and all shadow the function. The generated block also
# unaliases the name before defining the function, so a survivor anywhere (a spelling nobody
# anticipated, another tool's rc snippet) cannot keep the permissive launcher alive.
#
# The removal is line-based, so it only ever deletes a line that is NOTHING BUT that alias
# declaration. A line like `alias claudex='claude ...'; export PATH=/custom/bin:$PATH` is the
# user's own code, and deleting the whole line would silently take the `export` with it. We do
# not try to split such a line: finding where the alias value ends means parsing shell quoting
# with a regex, which is the mistake that produces this class of bug in the first place. So a
# compound line is left byte-identical and reported to the operator, and the `unalias` in the
# block below is what neutralizes it. That works because the block is appended at the END of
# the file, after the compound line, and the last definition wins. The one case it cannot fix
# is a compound line sitting BELOW an already-installed block. That one case exits NON-ZERO: the
# box really does still launch `claudex` with --dangerously-skip-permissions, and a step that
# reports success while the machine sits in exactly the state this migration exists to remove is
# worse than a failed install. install.sh runs under `set -e`, so the run aborts there; it is
# idempotent, and the fix is one line in the operator's own bashrc, so a re-run finishes the job.
# A compound line ABOVE the block is harmless (the block's `unalias` runs after it) and stays a
# clean exit 0 with its report.
#
# The report above is line-anchored, so it only sees a line that STARTS with the declaration. An
# alias can also be declared inline, as in `if :; then alias claudex='claude ...'; fi`, and below
# the block that shadows the function just as hard. A line continuation (`alias \` then the name on
# the next line) is a third spelling, `eval`, a sourced file, and a function that runs `alias` are
# more, and that class has no end. Each regex patch invites the next one, so the VERDICT is not
# lexical at all: after the migration has done its work, we ask bash what the name actually
# resolves to when the file is sourced. A non-interactive bash sources the target and reports
# `type -t claudex`; `alias` fails the step, `function` passes. The lexical scans stay, but only as
# the EXPLANATION of a failure (which line, what to delete), never as the test.
#
# Sourcing the operator's own bashrc executes arbitrary code, which is acceptable here and only
# here: install.sh already runs as the operator on the box it is provisioning, the file is the
# operator's own, and a login shell on that box sources it seconds later anyway. The probe adds no
# reach the caller did not already have. Two guards keep an odd file from becoming a hang or a
# false pass: stdin is /dev/null and the probe runs under `timeout`, so a prompt or a sleep ends
# the probe instead of the install; and any answer that is not `alias` or `function` (an rc that
# exits early, a missing bash or timeout, a probe that died) is treated as a check that DID NOT
# RUN, which exits non-zero. A verification that could not run never reports success.

set -euo pipefail

RC="${1:?usage: claudex-bashrc.sh <path-to-bashrc>}"
[ -f "$RC" ] || touch "$RC"

# `alias`, optionally indented, then one or more spaces/tabs, then claudex= . POSIX allows no
# space before `=`, so this is the complete set of valid declarations of this alias.
LEGACY_ALIAS='^[[:blank:]]*alias[[:blank:]]+claudex='
# The same declaration ALONE on its line: a double-quoted, single-quoted, or bare value, then
# nothing but trailing blanks. Anything else on the line (a `;`, a `&&`, a second word) fails
# this and is treated as the user's own compound line.
STANDALONE_ALIAS="${LEGACY_ALIAS}(\"[^\"]*\"|'[^']*'|[^[:space:];&|()]*)[[:blank:]]*\$"

if grep -Eqs "$STANDALONE_ALIAS" "$RC"; then
  grep -Ev "$STANDALONE_ALIAS" "$RC" > "$RC.cockpit-tmp"
  mv "$RC.cockpit-tmp" "$RC"
  echo "removed legacy permissive 'alias claudex=' line(s) from $RC"
fi

# `alias`, whitespace, `claudex=`, ANYWHERE in a line. This catches the inline forms the
# line-anchored pattern above misses, such as `if :; then alias claudex='...'; fi`. The launcher
# block's own text never matches it: the block writes `unalias claudex 2>/dev/null` and
# `claudex()`, neither of which is `alias` + blank + `claudex=`.
INLINE_ALIAS='alias[[:blank:]]+claudex='

BLOCK_LINE="$(grep -n '^# cockpit: claudex launcher' "$RC" | head -1 | cut -d: -f1 || true)"

# Whatever still declares the alias is a compound line we refuse to rewrite.
SHADOWED=0
COMPOUND="$(grep -En "$LEGACY_ALIAS" "$RC" || true)"
if [ -n "$COMPOUND" ]; then
  echo "left untouched (not ours to rewrite): $RC carries 'alias claudex=' on a line with other commands:"
  printf '%s\n' "$COMPOUND" | sed 's/^/  /'
  echo "  the launcher block below unaliases the name, so the function still wins; delete the alias by hand to tidy up."
  if [ -n "$BLOCK_LINE" ]; then
    LAST_COMPOUND="$(printf '%s\n' "$COMPOUND" | tail -1 | cut -d: -f1)"
    if [ "$LAST_COMPOUND" -gt "$BLOCK_LINE" ]; then
      echo "  WARNING: that line sits BELOW the launcher block, so it STILL SHADOWS the function and 'claudex'"
      echo "  still runs with --dangerously-skip-permissions. Remove the alias from that line to fix it."
      SHADOWED=1
    fi
  fi
fi

# The same failure by another spelling: an alias declared inline (inside an `if`, after a `&&`,
# behind a `;`) below the block. Nothing we can safely edit, so detect and refuse.
if [ "$SHADOWED" -eq 0 ] && [ -n "$BLOCK_LINE" ]; then
  INLINE="$(grep -En "$INLINE_ALIAS" "$RC" | awk -F: -v start="$BLOCK_LINE" '$1 > start' || true)"
  if [ -n "$INLINE" ]; then
    echo "$RC declares 'alias claudex=' inline BELOW the launcher block:"
    printf '%s\n' "$INLINE" | sed 's/^/  /'
    echo "  WARNING: that line sits BELOW the launcher block, so it STILL SHADOWS the function and 'claudex'"
    echo "  still runs with --dangerously-skip-permissions. Remove the alias from that line to fix it."
    echo "  (the text is left byte-identical: arbitrary shell is not ours to rewrite.)"
    SHADOWED=1
  fi
fi

# The verdict: what does a shell that sourced this file actually resolve `claudex` to? Run after
# the migration has finished writing, and answer only in terms of observed behaviour.
#   function -> the launcher won, exit 0
#   alias    -> the box is still permissive, exit 3
#   anything else (empty, a timeout, no bash, no timeout binary) -> the check did not run, exit 4
verdict() {
  if ! command -v bash >/dev/null 2>&1 || ! command -v timeout >/dev/null 2>&1; then
    echo "FAILED: cannot verify $RC: this box lacks bash or timeout, so what 'claudex' resolves to is unknown." >&2
    echo "  An unverified migration is not a successful one. Install coreutils/bash and re-run." >&2
    exit 4
  fi
  local answer
  # --norc --noprofile: source ONLY the target file, so the answer is about this file and not the
  # probe shell's own startup. expand_aliases makes a non-interactive shell honour aliases, which
  # is the behaviour an interactive login shell has and the whole point of the check.
  answer="$(timeout 10 bash --norc --noprofile -c \
    'shopt -s expand_aliases; . "$1" >/dev/null 2>&1; type -t claudex' _ "$RC" </dev/null 2>/dev/null || true)"
  case "$answer" in
    function)
      return 0 ;;
    alias)
      echo "FAILED: $RC still resolves claudex to an alias, so the box still launches it with" >&2
      echo "  --dangerously-skip-permissions. Delete that alias declaration and re-run." >&2
      if [ "$SHADOWED" -eq 1 ]; then echo "  (the report above points at the line.)" >&2; fi
      exit 3 ;;
    *)
      echo "FAILED: could not determine what $RC resolves 'claudex' to (probe answered ${answer:-nothing})." >&2
      echo "  The file may exit early, prompt, or hang when sourced. Fix that and re-run: an" >&2
      echo "  unverified migration is not a successful one." >&2
      exit 4 ;;
  esac
}

if grep -qs '^# cockpit: claudex launcher' "$RC"; then
  echo "skip: claudex launcher already in $RC"
  verdict
  exit 0
fi

cat >> "$RC" <<'CLAUDEX'

# cockpit: claudex launcher. Runs Claude Code here on the box.
# Claude Code normally asks before it runs a command, edits a file, or reaches the
# network. `--dangerously-skip-permissions` removes every one of those prompts: the agent
# then reads, writes, deletes, and executes anywhere it can reach on this machine, with no
# confirmation. So this launcher does not make that choice for you. To opt in, put
#   export COCKPIT_SKIP_PERMISSIONS=1
# in this file above these lines. Unset it, or set it to anything but 1, for prompts back.
# An alias of the same name would shadow this function, so drop any that survived.
unalias claudex 2>/dev/null || true
claudex() {
  if [ "${COCKPIT_SKIP_PERMISSIONS:-0}" = "1" ]; then
    claude --dangerously-skip-permissions "$@"
  else
    claude "$@"
  fi
}
CLAUDEX
echo "appended claudex launcher function to $RC (prompts on unless COCKPIT_SKIP_PERMISSIONS=1)"
verdict
