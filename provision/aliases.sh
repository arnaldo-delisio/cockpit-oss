# aliases.sh, laptop-side launchers for a cockpit VPS (thin-terminal pattern).
# Source this from your shell rc: `source ~/cockpit/provision/aliases.sh` (any local
# checkout path works). Requires a `Host cockpit-vps` block in ~/.ssh/config (see the
# README client-setup guide) and mosh installed locally.
#
# No default scopes ship with the engine (registration is a deliberate act, layout §5),
# so per-scope launchers are the generic function below; define short aliases for your
# own scopes in your local rc, e.g. `alias claudex.per='claudex.scope personal'`.
#
# ── PERMISSION PROMPTS: OFF BY DEFAULT HERE, AND OPT IN ───────────────────────────────
# Claude Code normally asks before it runs a command, edits a file, or reaches the
# network. `--dangerously-skip-permissions` removes every one of those prompts for the
# whole session: the agent then reads, writes, deletes, and executes anywhere it can
# reach on the VPS, with no confirmation and no chance to say no. That is a real choice
# about your machine, so these launchers do NOT make it for you.
#
# They run plain `claude`. To opt in, export the variable below before sourcing this
# file (or anywhere in your shell rc):
#
#   export COCKPIT_SKIP_PERMISSIONS=1
#
# Unset it, or set it to anything other than 1, to get the prompts back. The flag is
# reasonable on a dedicated single-purpose VPS holding nothing you cannot lose, and it
# is a bad idea anywhere else.

_claudex_claude_cmd() {
  if [ "${COCKPIT_SKIP_PERMISSIONS:-0}" = "1" ]; then
    printf '%s' 'claude --dangerously-skip-permissions'
  else
    printf '%s' 'claude'
  fi
}

# Land in the engine root on the VPS with Claude Code running.
claudex.cockpit() {
  mosh cockpit-vps -- bash -lc "cd ~/cockpit && $(_claudex_claude_cmd)"
}

# Land in the named scope workspace: `claudex.scope <scope-name>`. The name is validated
# as a plain scope slug before it reaches the remote shell string (no injection/traversal).
claudex.scope() {
  case "$1" in
    *[!a-z0-9-]*|-*|"") echo "usage: claudex.scope <scope-name> (lowercase kebab-case, e.g. my-venture)" >&2; return 1;;
  esac
  mosh cockpit-vps -- bash -lc "cd ~/cockpit/scopes/$1 && $(_claudex_claude_cmd)"
}
