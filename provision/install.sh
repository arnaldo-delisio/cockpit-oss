#!/usr/bin/env bash
# install.sh, the Block B stack install (port layout §11). Runs ON the VPS as the non-root
# user created by cloud-init (over ssh or in a local shell there), never on the laptop.
#
# Default is DRY: prints the plan (the exact commands) and exits; pass --apply to execute
# (first-execution-dry-run doctrine). Idempotent: every step checks before acting, so
# re-running after a partial failure is safe.
#
# Order per layout §11: stack install → clone engine to both trees → private memory repo →
# secrets file → scopes.json boot roster → bootstrap --cutover → systemd user units +
# timers → lingering.

set -euo pipefail

APPLY=0
if [ "${1:-}" = "--apply" ]; then APPLY=1; fi

# Git identity for the nested memory repo (local config, vps-fresh-start pre-cutover
# checklist: engine write paths commit there and fail without it). Override per box if needed.
# No defaults: a fake placeholder identity would silently author real commits, so a missing
# value fails loudly below instead.
GIT_NAME="${COCKPIT_GIT_NAME:-}"
GIT_EMAIL="${COCKPIT_GIT_EMAIL:-}"

# SSH form, not HTTPS: the repo is private, and HTTPS would hang on an interactive
# credential prompt during a headless first apply. Per-VPS keys (layout §9): the box gets
# its own read-only deploy key on the engine repo. No default: the engine repo is yours.
ENGINE_REMOTE="${COCKPIT_ENGINE_REMOTE:-}"

missing=""
[ -n "$GIT_NAME" ] || missing="$missing COCKPIT_GIT_NAME"
[ -n "$GIT_EMAIL" ] || missing="$missing COCKPIT_GIT_EMAIL"
[ -n "$ENGINE_REMOTE" ] || missing="$missing COCKPIT_ENGINE_REMOTE"
if [ -n "$missing" ]; then
  echo "install.sh: these environment variables are required:$missing" >&2
  echo "  COCKPIT_GIT_NAME / COCKPIT_GIT_EMAIL: git identity for the nested memory repo" >&2
  echo "  COCKPIT_ENGINE_REMOTE: ssh URL of your engine repo, e.g. git@github.com:you/cockpit.git" >&2
  # Dry mode still prints the plan: the whole point of the default run is to show it on a
  # fresh box, before any of these are set. Only --apply fails hard.
  if [ "$APPLY" -eq 1 ]; then exit 1; fi
  echo "install.sh: WARNING, unset in this dry run; set them before --apply." >&2
fi
# No release tags exist yet: default ref is `main`. Switches to annotated release
# tags at the first tagged release (layout §8), by setting COCKPIT_ENGINE_REF=vN.N.N.
ENGINE_REF="${COCKPIT_ENGINE_REF:-main}"
# Memory repo upstream: real remote if provided, placeholder otherwise (finding 4: timer
# enablement is gated on a real remote, the nightly pushes there).
MEMORY_REMOTE="${COCKPIT_MEMORY_REMOTE:-}"
COCKPIT_DIR="$HOME/cockpit"
TEMPLATE_DIR="$HOME/cockpit-template"
MEMORY_DIR="$COCKPIT_DIR/memory"
ENV_FILE="$HOME/.config/cockpit/env"
UNIT_SRC="$COCKPIT_DIR/provision/systemd"
UNIT_DST="$HOME/.config/systemd/user"

run() {
  if [ "$APPLY" -eq 1 ]; then echo "+ $*"; "$@"; else echo "DRY: $*"; fi
}

# For steps that need shell constructs (redirection, heredocs): takes a description and a
# function name; dry mode prints the description only.
step() {
  local desc="$1" fn="$2"
  if [ "$APPLY" -eq 1 ]; then echo "+ $desc"; "$fn"; else echo "DRY: $desc"; fi
}

[ "$APPLY" -eq 1 ] || echo "install.sh: DRY RUN, pass --apply to execute. Plan:"

# ── 1. Base packages: git, build essentials, headed-browser lane (Xvfb + x11vnc) ──────────
# ffmpeg/yt-dlp serve the core `watch` skill (manifest: skills/skills.json).
# jq is shell glue for skills/hooks.
# ripgrep serves the memory engine's recall lexical gate (memory-engine/retrieval.mjs).
if ! command -v git >/dev/null || ! command -v gcc >/dev/null || ! command -v Xvfb >/dev/null \
  || ! command -v x11vnc >/dev/null || ! command -v unzip >/dev/null \
  || ! command -v mosh-server >/dev/null || ! command -v ffmpeg >/dev/null \
  || ! command -v yt-dlp >/dev/null || ! command -v jq >/dev/null \
  || ! command -v rg >/dev/null \
  || ! python3 -c 'import venv' 2>/dev/null; then
  run sudo apt-get update
  run sudo apt-get install -y git build-essential xvfb x11vnc curl ca-certificates python3 python3-venv unzip mosh ffmpeg yt-dlp jq ripgrep
else
  echo "skip: git/build-essential/xvfb/x11vnc/python3-venv/mosh/ffmpeg/yt-dlp/jq/ripgrep already installed"
fi

# ── 2. Node LTS (NodeSource, the distro-appropriate method on Ubuntu 24.04: the archive's
#       own nodejs is not current LTS) ────────────────────────────────────────────────────
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  echo "skip: node $(node --version) already installed"
else
  nodesource() {
    # Vendor-official curl|bash: accepted trust-on-first-use risk on a single-owner box
    # (Codex finding, overruled: checksum pinning is over-spec here).
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  }
  step "install Node LTS via NodeSource apt repo" nodesource
fi

# ── 3. Chrome for the headed lane (google-chrome via Google's apt repo; Ubuntu's chromium
#       is a snap, a worse fit for driven automation) ─────────────────────────────────────
if command -v google-chrome >/dev/null; then
  echo "skip: google-chrome already installed"
else
  chrome() {
    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
    sudo apt-get install -y /tmp/chrome.deb
    rm -f /tmp/chrome.deb
  }
  step "install google-chrome-stable from Google's .deb" chrome
fi

# ── 4. Claude Code (mirrors the laptop: native installer layout, ~/.local/share/claude
#       versions dir + ~/.local/bin/claude symlink) ───────────────────────────────────────
if command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ]; then
  echo "skip: claude already installed"
else
  # Vendor-official curl|bash: accepted trust-on-first-use risk on a single-owner box.
  claude_install() { curl -fsSL https://claude.ai/install.sh | bash; }
  step "install Claude Code via native installer (curl https://claude.ai/install.sh | bash)" claude_install
fi

# ── 4a. uv (Astral's Python package/script runner; serves the core `watch` skill, manifest:
#        skills/skills.json, whose script shebang is `#!/usr/bin/env -S uv run --script`) ──
if command -v uv >/dev/null || [ -x "$HOME/.local/bin/uv" ]; then
  echo "skip: uv already installed"
else
  # Vendor-official curl|bash: accepted trust-on-first-use risk on a single-owner box.
  uv_install() { curl -LsSf https://astral.sh/uv/install.sh | sh; }
  step "install uv via native installer (curl https://astral.sh/uv/install.sh | sh)" uv_install
fi

# ── 5. Codex CLI (mirrors the laptop: npm global, verified via npm ls -g) ─────────────────
if command -v codex >/dev/null; then
  echo "skip: codex already installed"
else
  run sudo npm install -g @openai/codex
fi

# ── 6. Hermes (laptop layout: git clone of NousResearch/hermes-agent at
#       ~/.hermes/hermes-agent, python venv inside it, thin wrapper in ~/.local/bin) ──────
if command -v hermes >/dev/null || [ -x "$HOME/.local/bin/hermes" ]; then
  echo "skip: hermes already installed"
else
  hermes_install() {
    mkdir -p "$HOME/.hermes"
    [ -d "$HOME/.hermes/hermes-agent" ] || git clone https://github.com/NousResearch/hermes-agent.git "$HOME/.hermes/hermes-agent"
    # TODO(verify at apply time): the laptop venv predates this script and the exact pip
    # invocation used was not recorded; pyproject.toml exists, so editable install is the
    # standard path, but confirm against the repo's own install docs before relying on it.
    python3 -m venv "$HOME/.hermes/hermes-agent/venv"
    "$HOME/.hermes/hermes-agent/venv/bin/pip" install -e "$HOME/.hermes/hermes-agent"
    mkdir -p "$HOME/.local/bin"
    printf '#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "%s" "$@"\n' \
      "$HOME/.hermes/hermes-agent/venv/bin/hermes" > "$HOME/.local/bin/hermes"
    chmod +x "$HOME/.local/bin/hermes"
  }
  step "install Hermes (clone hermes-agent, venv, pip install -e, ~/.local/bin wrapper)" hermes_install
fi

# ── 7. Clone engine to both trees (layout §1: instance + never-populated template) ────────
# Pin GitHub's published SSH host keys so the first network call neither prompts nor
# trusts-on-first-use. Key material verified against
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
# (keys are stable; rotations are announced by GitHub well in advance).
hostkeys() {
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/known_hosts"
  while IFS= read -r k; do
    grep -qF "$k" "$HOME/.ssh/known_hosts" || printf '%s\n' "$k" >> "$HOME/.ssh/known_hosts"
  done <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
EOF
}
step "pin GitHub SSH host keys in ~/.ssh/known_hosts (idempotent)" hostkeys

# All git-over-ssh calls in this script run noninteractively: a missing/changed host key or
# absent deploy key fails clearly instead of prompting a headless apply.
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"

# Preflight the remote before touching anything: a missing deploy key must fail loudly
# here, not midway through a clone.
if [ "$APPLY" -eq 1 ] && ! git ls-remote "$ENGINE_REMOTE" HEAD >/dev/null; then
  # Empty passphrase is deliberate: the box is unattended, the key is read-only-scoped,
  # machine-local, and per-VPS (fleet rule, layout §9); a passphrase-protected key would
  # deadlock under BatchMode.
  echo "install.sh: cannot reach $ENGINE_REMOTE. Generate a key on this box:" >&2
  echo "    ssh-keygen -t ed25519 -N \"\" -f ~/.ssh/id_ed25519 -C \"cockpit-vps-deploy\"" >&2
  echo "  add ~/.ssh/id_ed25519.pub as a READ-ONLY deploy key on the engine repo, then retry." >&2
  exit 1
fi

# Convergence, not skip: a rerun after a partial first apply must land on the pinned ref,
# not whatever the default branch left behind. Trailing `--` forces ref interpretation:
# `port` is also a directory in the tree, and a bare checkout aborts as ambiguous.
if [ -d "$COCKPIT_DIR/.git" ]; then
  run git -C "$COCKPIT_DIR" fetch
  run git -C "$COCKPIT_DIR" checkout "$ENGINE_REF" --
else
  run git clone "$ENGINE_REMOTE" "$COCKPIT_DIR"
  run git -C "$COCKPIT_DIR" checkout "$ENGINE_REF" --
fi
if [ -d "$TEMPLATE_DIR/.git" ]; then
  run git -C "$TEMPLATE_DIR" fetch
  run git -C "$TEMPLATE_DIR" checkout "$ENGINE_REF" --
else
  run git clone "$ENGINE_REMOTE" "$TEMPLATE_DIR"
  run git -C "$TEMPLATE_DIR" checkout "$ENGINE_REF" --
fi

# ── 8. Per-surface installs (npm ci in memory-engine) ─────────────────────────────────────
# No skip gate here: the install converges to the lockfile by design, so it runs on every
# apply (a stale node_modules never survives a rerun).
npmci() { cd "$COCKPIT_DIR/memory-engine" && npm ci; }
step "npm ci in $COCKPIT_DIR/memory-engine" npmci

# ── 9. Private memory repo, its OWN git repo with local identity and the browser-profiles
#       gitignore BEFORE any profile dir exists (layout §10, Codex finding 5; identity per
#       the pre-cutover checklist: engine write paths commit here) ────────────────────────
if [ -d "$MEMORY_DIR/.git" ]; then
  echo "skip: $MEMORY_DIR is already a git repo"
else
  memrepo() {
    mkdir -p "$MEMORY_DIR"
    git -C "$MEMORY_DIR" init
    git -C "$MEMORY_DIR" config user.name "$GIT_NAME"
    git -C "$MEMORY_DIR" config user.email "$GIT_EMAIL"
    printf 'browser-profiles/\n' > "$MEMORY_DIR/.gitignore"
    # Upstream (layout §2: own private remote per box, never shared). Real remote if
    # COCKPIT_MEMORY_REMOTE is set; otherwise a placeholder, and the nightly timer stays
    # unenabled in step 13 until the real remote exists (its push step needs it live before
    # the first unattended run, pre-cutover checklist).
    git -C "$MEMORY_DIR" remote add origin "${MEMORY_REMOTE:-git@github.com:CHANGEME/cockpit-memory.git}"
    git -C "$MEMORY_DIR" add .gitignore
    git -C "$MEMORY_DIR" commit -m "memory repo init: gitignore browser-profiles before it exists"
  }
  step "init $MEMORY_DIR as its own repo (local identity, browser-profiles gitignore, upstream placeholder)" memrepo
fi

# ── 10. Secrets file, touch-if-missing, never overwritten; secrets entered by hand later
#        over SSH (layout §7) ─────────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  echo "skip: $ENV_FILE exists (never overwritten)"
  run chmod 600 "$ENV_FILE"
else
  envfile() {
    mkdir -p "$(dirname "$ENV_FILE")"
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  }
  step "create empty $ENV_FILE mode 600 (fill by hand; names in .env.example)" envfile
fi

# ── 10a. Interactive shells source the env file (layout §7, one line in .bashrc) ──────────
if grep -qs 'config/cockpit/env' "$HOME/.bashrc"; then
  echo "skip: .bashrc already sources $ENV_FILE"
else
  bashrc() { printf '[ -f ~/.config/cockpit/env ] && set -a && . ~/.config/cockpit/env && set +a\n' >> "$HOME/.bashrc"; }
  step "append env-source line to ~/.bashrc" bashrc
fi

# ── 10b. claudex launcher (fleet-standard name), permission prompts opt-out only ──────────
# The migration (drop any legacy permissive alias, then append the function block) lives in
# provision/claudex-bashrc.sh so it is idempotent, testable against a scratch file, and stated
# once. It is a no-op on a bashrc that already has the block.
claudex_launcher() { bash "$COCKPIT_DIR/provision/claudex-bashrc.sh" "$HOME/.bashrc"; }
step "install claudex launcher function in ~/.bashrc, dropping any legacy 'alias claudex=' (prompts on unless COCKPIT_SKIP_PERMISSIONS=1)" claudex_launcher

# ── 11. Boot scope roster BEFORE first bootstrap (layout §5) ──────────────────────────────
if [ -f "$MEMORY_DIR/scopes.json" ]; then
  echo "skip: $MEMORY_DIR/scopes.json exists"
else
  scopes() { printf '["cockpit","personal","studio"]\n' > "$MEMORY_DIR/scopes.json"; }
  step "write boot scopes.json ([cockpit, personal, studio])" scopes
fi

# ── 11a. Browser-profiles ignore, idempotent regardless of how memory/ came to exist: the
#         exact line must be present BEFORE the browser lane can ever create the dir
#         (layout §10, Codex finding 5). ─────────────────────────────────────────────────
if grep -qxF 'browser-profiles/' "$MEMORY_DIR/.gitignore" 2>/dev/null; then
  echo "skip: memory/.gitignore already carries browser-profiles/"
else
  gitignore_line() { mkdir -p "$MEMORY_DIR"; printf 'browser-profiles/\n' >> "$MEMORY_DIR/.gitignore"; }
  step "ensure browser-profiles/ line in $MEMORY_DIR/.gitignore" gitignore_line
fi

# ── 12. Bootstrap with the cutover flag: on a fresh VPS the out-of-tree writes (hermes
#        SOUL link, ~/.claude/settings.json hooks) are exactly what we want ───────────────
run node "$COCKPIT_DIR/bootstrap.mjs" --cutover

# ── 12a. Commit the bootstrap-seeded memory tree: reconcile.mjs refuses real runs on a
#         dirty knowledge/ tree, so an uncommitted seed would wedge every nightly while the
#         service looks healthy. The timer-gate push in step 13 then publishes it. ────────
memcommit() {
  git -C "$MEMORY_DIR" add -A
  if git -C "$MEMORY_DIR" diff --cached --quiet; then
    echo "skip: memory tree already committed"
  else
    git -C "$MEMORY_DIR" commit -m "bootstrap: initial memory tree"
  fi
}
step "commit the bootstrap-seeded memory tree (idempotent)" memcommit

# ── 13. Systemd user units + timers, then lingering so they run without a login session ───
# cockpit-dashboard.service is NOT in $UNIT_SRC any more: the dashboard repo owns its own unit
# (dashboard/cockpit-dashboard.service). An already enabled copy on this box is left alone on
# purpose; provisioning never stops or removes a running service. Printed outside step() so the
# notice shows in both dry and apply output.
echo "NOTE: cockpit-dashboard.service is no longer engine-managed."
echo "  An existing enabled unit keeps running untouched; this script never stops or removes it."
echo "  Its lifecycle now belongs to the dashboard repo (dashboard/cockpit-dashboard.service)."
units() {
  mkdir -p "$UNIT_DST"
  cp "$UNIT_SRC"/*.service "$UNIT_SRC"/*.timer "$UNIT_DST/"
  systemctl --user daemon-reload
  # Nightly timer is gated on a REAL memory remote: dream.sh's push step fails every night
  # against the placeholder (finding 4).
  # Read the URL first: a failing get-url inside the condition must gate, not fall through
  # to the enable branch. Absent origin counts as not real.
  origin_url="$(git -C "$MEMORY_DIR" remote get-url origin 2>/dev/null || true)"
  if [ -z "$origin_url" ] || printf '%s' "$origin_url" | grep -q 'CHANGEME'; then
    echo "NOT ENABLED: cockpit-reconcile.timer (memory remote is absent or still the placeholder)."
    echo "  Set it, verify a push, then enable:"
    echo "    git -C $MEMORY_DIR remote set-url origin <real-private-remote>"
    echo "    git -C $MEMORY_DIR push -u origin \$(git -C $MEMORY_DIR branch --show-current)"
    echo "    systemctl --user enable --now cockpit-reconcile.timer"
  # A real origin is not enough: dream.sh's push step needs upstream TRACKING. Verify by
  # pushing -u once; this push runs only at --apply on the VPS (units() is only called
  # through step(), the script stays dry everywhere else).
  elif git -C "$MEMORY_DIR" push -u origin "$(git -C "$MEMORY_DIR" branch --show-current)"; then
    systemctl --user enable --now cockpit-reconcile.timer
  else
    echo "NOT ENABLED: cockpit-reconcile.timer (push -u to $origin_url failed; fix access, then):"
    echo "    git -C $MEMORY_DIR push -u origin \$(git -C $MEMORY_DIR branch --show-current)"
    echo "    systemctl --user enable --now cockpit-reconcile.timer"
  fi
  systemctl --user enable --now xvfb.service
  # x11vnc needs its password file first (see the unit header); enable it, start by hand
  # after creating ~/.config/cockpit/x11vnc.pass.
  systemctl --user enable x11vnc.service
}
step "install systemd user units from $UNIT_SRC and enable timers" units
run loginctl enable-linger "$USER"

echo "install.sh: done ($([ "$APPLY" -eq 1 ] && echo applied || echo 'dry run, nothing executed'))."
