#!/usr/bin/env bash
# browser-lane.sh — start the headed Chrome that holds a scope's logged-in browser session.
#
#   provision/browser-lane.sh <scope> [start-url]
#
# One Chrome per scope, because two identities on the same platform cannot share cookies.
# Each scope gets its own profile directory and its own CDP port, so agents attach to the
# right identity by port and can never reach another scope's session by accident.
#
# Profiles live in the private memory repo at memory/browser-profiles/<scope>/ and are
# gitignored (cookies and tokens must never reach git). They are machine-local and never
# synced (port/layout.md).
#
# The browser runs headed on the shared Xvfb display, per doctrine: browser work runs on a
# real logged-in profile, never a fresh headless one. Log in by hand once, through VNC; the
# session then survives restarts.
#
# CDP is bound to loopback only. Anything on this box that can reach the port drives the
# session, which is the point (Claude Code and Hermes both attach the same way) and also the
# reason it is never exposed off-box.
set -euo pipefail

DISPLAY_NUM="${COCKPIT_DISPLAY:-:99}"
COCKPIT_DIR="${COCKPIT_DIR:-$HOME/cockpit}"
PROFILES_DIR="$COCKPIT_DIR/memory/browser-profiles"

# Explicit scope -> port map. Explicit rather than hashed: the mapping is read by humans
# debugging "which browser is this", and a hash makes that unanswerable at a glance.
# Add a line when a scope needs its own browser identity.
scope_port() {
  case "$1" in
    personal) echo 9222 ;;
    studio)   echo 9223 ;;
    *) echo "browser-lane: no port assigned for scope '$1' (add one to scope_port)" >&2; return 1 ;;
  esac
}

SCOPE="${1:-}"
if [ -z "$SCOPE" ]; then
  echo "usage: browser-lane.sh <scope> [start-url]" >&2
  exit 1
fi
case "$SCOPE" in
  *[!a-z0-9-]*|-*) echo "browser-lane: scope must be lowercase kebab-case" >&2; exit 1 ;;
esac

PORT="$(scope_port "$SCOPE")"
PROFILE="$PROFILES_DIR/$SCOPE"
START_URL="${2:-about:blank}"

if curl -s --max-time 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "browser-lane: $SCOPE already running on port $PORT"
  exit 0
fi

mkdir -p "$PROFILE"
export DISPLAY="$DISPLAY_NUM"
exec google-chrome \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  --window-size=1920,1040 --window-position=0,0 \
  --no-first-run --no-default-browser-check \
  "$START_URL"
