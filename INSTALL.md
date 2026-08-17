# Installing cockpit

Setup instructions for a cockpit instance tree. For what the system is and how it works, see [README.md](README.md).

---

## Getting started

**Prerequisites**

- Linux (systemd user timer) or macOS 10.15+ (launchd user agent), for the nightly dreaming pass
- Claude Code subscription (builder brain)
- [Hermes](https://github.com/NousResearch/hermes-agent) (operator brain): an open-source agent CLI from Nous Research, free to install. `provision/install.sh` clones it to `~/.hermes/hermes-agent` and installs it into a Python venv, with a wrapper in `~/.local/bin`. On a laptop, install it yourself from that repo. **Required for the reconciler**, not only for the operator role: the engine's heavy tier routes through `hermes -z`.
- Codex CLI, logged in: the reconciler's heavy tier (distill, conflict resolution, centrality) makes its model calls through `hermes -z` pinned to the `openai-codex` provider, so those calls ride your Codex login. **Also required.** Without Hermes plus a valid Codex login the reconciler cannot distill anything, and a heavy-tier call fails with a message naming what is missing rather than quietly returning nothing.
- Node.js 20+
- Python + `uv` (for the `watch` skill; optional)

No API key needed for the engine itself: both model adapters route through subscription-based CLIs. The engine picks the adapter per tier, so a normal install needs both: the heavy tier on Codex through Hermes, the lighter tiers (triage, classify, summarize, phrasing) on the Claude Code CLI.

**1. Clone**

Clone into `~/cockpit`, as the command below does. Every example in this file assumes that path, so if you clone somewhere else, substitute your own path throughout.

```sh
git clone https://github.com/arnaldo-delisio/cockpit-oss ~/cockpit
cd ~/cockpit/memory-engine
npm install
```

**2. Secrets (optional at first)**

```sh
mkdir -p ~/.config/cockpit
cp ~/cockpit/.env.example ~/.config/cockpit/env
chmod 600 ~/.config/cockpit/env
```

Fill in only the keys for the skills you use. Real secrets never enter the repo tree.

**3. Declare your scopes (required)**

Scopes map to the areas of your life or work you want the memory engine to track. Registration is a deliberate act: there are no default scopes, and `bootstrap.mjs` warns and exits if `memory/scopes.json` is missing or empty. (There is no `global` scope; the shell layer in `shells/` replaced it.) The `memory/` directory is gitignored, so a fresh clone does not have it yet. Create it, then create `~/cockpit/memory/scopes.json`:

```sh
mkdir -p ~/cockpit/memory
cat > ~/cockpit/memory/scopes.json <<'JSON'
["cockpit", "personal", "my-venture"]
JSON
```

Add any scope name that corresponds to a project, venture, or area. You can add more later; `bootstrap.mjs` is idempotent.

**4. Bootstrap the tree**

```sh
node ~/cockpit/bootstrap.mjs
```

For every registered scope this materializes: the memory directories (`memory/scopes/<name>/{identity,log,staging,sources,projects}/` plus an identity stub), the `memory/knowledge/` graph store, a scope workspace with its doc spine (`CLAUDE.md` loader pair, `DECISIONS.md`, `decisions/`), and the generated `shells/SOUL.generated.md` (the `shells/SOUL.md` + `shells/doctrine.md` concat Hermes loads). It also seeds a `demo` scope so you can smoke-test the pipeline without real data.

Two scope names are special, so do not expect a directory under `scopes/` for them. A scope named `cockpit` uses the repo root itself as its workspace, and its doc spine is written there rather than in `scopes/cockpit/`. The seeded `demo` scope gets memory directories only, no workspace at all. Every other scope gets `~/cockpit/scopes/<name>/`.

An unregistered directory under `scopes/` gets a warning, never auto-adoption. Scope `CLAUDE.md` files force-load (`@`-import) only load-bearing docs; everything else is reached by pointer, so the always-loaded layer stays thin.

The default run is inert outside the tree: nothing under `~` is touched without an explicit flag (next steps).

**5. Set the identity for the private memory repo**

Bootstrap already made `memory/` its own standalone git repo and committed the seed tree, so there is nothing to initialize by hand. If the box had no git identity at that point, bootstrap used a one-off `cockpit bootstrap` identity for that single commit and said so in its output. Every later commit uses yours, so set one now:

```sh
git -C ~/cockpit/memory config user.name "Your Name"
git -C ~/cockpit/memory config user.email "you@example.com"
```

The reconciler commits with plain `git commit`, so a global identity works too. Set it locally when the box has no global `user.name` / `user.email`, or when you want memory commits under a different identity. With neither, the reconciler falls back to a `cockpit reconcile` identity for its own commits, exactly as bootstrap did, and prints the two commands above the first time it uses it. The run still completes, so this step is safe to do after the smoke test, but every memory commit carries the fallback author until you set your own.

This repo stays local by default. Add a remote and push when you want an off-machine backup. Never share a memory remote across machines.

**6. Wire the out-of-tree system (opt-in flags)**

All home-directory writes are gated behind explicit flags; a flagless run of either bootstrap only reports what it would do.

One exception to note: `update.sh <tag> --apply` writes outside the repo. The apply run performs a bootstrap cutover, which rewrites `~/.claude/settings.json`, and it advances `~/cockpit-template` if that tree exists. The default `update.sh <tag>` prints the plan and writes nothing, so `--apply` is that explicit flag one level up.

```sh
cd ~/cockpit/memory-engine
bash bootstrap.sh --write-loaders    # ~/CLAUDE.md @-import loader + ~/SOUL.md signpost
bash bootstrap.sh --write-hermes     # ~/.hermes/SOUL.md -> shells/SOUL.generated.md symlink
bash bootstrap.sh --write-settings   # capture/recall hooks merged into ~/.claude/settings.json
bash bootstrap.sh --write-timer      # nightly timer: systemd units on Linux, launchd agent on macOS, fires 04:00 local
bash bootstrap.sh --cutover          # all of the above
node bootstrap.mjs --write-skills    # manifest core-skill symlinks into ~/.claude/skills and ~/.hermes/skills
```

`--install-only` (with `--write-timer` or `--cutover`) writes the timer units without enabling them. `bootstrap.sh --cutover` covers the shell steps above. `node bootstrap.mjs` honors its own flag set, including `--write-settings`, `--write-hermes`, `--write-skills`, and `--cutover`, for its out-of-tree steps. The settings hooks are rendered from `hooks/settings.template.json` with the resolved repo root.

**7. Wire Hermes manually**

Two things bootstrap does not handle yet; add them to `~/.hermes/config.yaml`:

```yaml
skills:
  external_dirs:
    - /home/<you>/.hermes/skills          # loads cross-brain shared skills (manifest-owned; bootstrap --write-skills provisions the links here)

hooks:
  on_session_end:
    - node /home/<you>/cockpit/memory-engine/hermes-capture.mjs   # capture hook
  pre_llm_call:
    - node /home/<you>/cockpit/memory-engine/recall-hermes.mjs    # recall hook
```

Use absolute paths in hook commands: `~/` does not expand reliably there.

**8. Add scopes**

Scope workspaces live inside the tree at `~/cockpit/scopes/<name>/`. Add `my-scope` to `memory/scopes.json` and re-run `node ~/cockpit/bootstrap.mjs`: it materializes the scope's memory directories AND its workspace doc spine (`CLAUDE.md` loader, `DECISIONS.md`, `decisions/`), so a new scope cannot be created off-template. The seeded `CLAUDE.md` `@`-imports the reconciler-projected shell at `memory/scopes/my-scope/CLAUDE.md`, which bootstrap creates as an empty managed region so the import resolves from the first session, before any rule has been projected into it.

If you run the tree on a VPS, give the new scope a laptop launcher too: `claudex.scope <name>` works immediately, or add a shorthand alias in your local rc (see the VPS launchers section).

Work inside a scope is tracked as Project objects plus roadmap sidecars (`memory/scopes/<name>/projects/<id>.md` + `<id>.roadmap.md`), the only stored roadmaps. Chronology comes from the capture hooks, roadmap Done lines, ledger dates, and git history rather than a hand-written log.

**9. Smoke test**

The `demo` scope is pre-seeded with two staged conversations and no knowledge nodes, so this exercises the real pipeline instead of reading back a seeded file. Verify it end to end:

```sh
cd ~/cockpit/memory-engine
# Run the reconciler over the demo scope (distill -> consolidate -> project)
node reconcile.mjs --scope demo --require-yield

# Verify recall works
node recall.mjs --scope demo "should I dry-run scripts before running them?"
```

A successful run distills the two seeded conversations into knowledge nodes, commits them to `memory/`, and prints an audit diff. Recall should then return a node the run just created, about dry-run safety. Node ids vary per run, so match on the content, not on a fixed id.

`--require-yield` makes the run exit non-zero unless it produced node changes: nothing durable out of real input, or nothing to read at all. Both are what a correct smoke test must never see. It is opt-in for exactly that reason, since the nightly pass legitimately has quiet nights and does not pass it. A failed model call already exits non-zero without the flag. A failed run consumes nothing: fix the cause and run the same command again.

No environment variable is needed. The engine routes its heavy tier through Codex by default, the same path the nightly pass uses, so a correct install distills out of the box. If Hermes or the Codex login is missing, the run fails with a message naming what to install rather than reporting a successful pass that produced nothing.

`JUDGE_ADAPTER` still exists as a deliberate override: `JUDGE_ADAPTER=hermes` forces the hard and bulk tiers onto Codex (what `dream.sh` does), and the mechanical tier is simply unavailable under it, since the Hermes adapter wires no such tier; the only caller of it, `mechanical-insights.mjs`'s cosmetic phrasing pass, falls back to its deterministic template for that step. `JUDGE_ADAPTER=claude` forces every tier onto the Claude Code CLI. Forcing the Claude adapter is not a way around a missing Hermes install: its heavy tier returns nothing on thin material, which is why the default no longer sends heavy work there.

The engine also ships a unit suite. Run it with `cd ~/cockpit/memory-engine && npm test`; it needs no model access, no network, and no `memory/` data, so it is the fastest check that a clone is intact. The shared landing module has its own stdlib-only test, run with `python3 ~/cockpit/skills/lib/test_sources.py`, needing no network, keys, or `memory/` data.

To start the demo over, drop the nodes the run created AND forget that the demo staging was already read. Both halves are required. The nodes go by hand, because `memory/` is a git repo and the reconciler refuses to run over an uncommitted `knowledge/` tree. The consumed markers go through the engine, so nobody has to hand-edit `.reconciler/state.json`:

```sh
cd ~/cockpit/memory
git rm -r --quiet knowledge/nodes          # removes the files AND stages the removal
git commit --quiet -m "demo: reset knowledge nodes"
mkdir -p knowledge/nodes

cd ~/cockpit/memory-engine
node reconcile.mjs --forget-scope demo     # re-reads demo staging from the top; commits state.json
```

Then re-run the smoke test above. It mints the two nodes again.

Skipping the second command leaves every demo staging file marked consumed, so the re-run has nothing to read. That is what `--require-yield` is for: it fails a run that produced no nodes, including a run that found nothing to read, so an incomplete reset shows up as a failure instead of a green exit over zero work.

Deleting `memory/` entirely and re-running `bootstrap.mjs` is the other way, and it needs no commit.

---

## Running the cockpit on a VPS: laptop launchers

When the instance tree lives on a server, your laptop is a thin terminal. The engine ships the launchers in `provision/aliases.sh`; wiring is three steps.

**1. SSH config.** Add a `Host cockpit-vps` block to `~/.ssh/config` (the aliases reference the host alias, never an IP, so this is the only part you personalize):

```
Host cockpit-vps
  HostName <your-server-ip>
  User <your-user>
  IdentityFile ~/.ssh/cockpit-vps
  IdentitiesOnly yes
```

**2. Provision the server.** `provision/install.sh` runs ON the VPS as your user, never on the laptop. It installs the stack, clones the engine to both trees, creates the private memory repo, and installs the systemd user units. Three variables are required:

```sh
export COCKPIT_GIT_NAME="Your Name"                       # git author name for the nested memory repo
export COCKPIT_GIT_EMAIL="you@example.com"                # git author email for the same repo
export COCKPIT_ENGINE_REMOTE="git@github.com:you/cockpit.git"  # ssh URL of your engine repo

bash ~/cockpit/provision/install.sh            # dry run: prints the plan, changes nothing
bash ~/cockpit/provision/install.sh --apply    # executes it
```

`COCKPIT_MEMORY_REMOTE` stays optional: leave it unset and the memory repo gets a placeholder upstream, with the nightly reconcile timer left disabled until you set a real remote. `COCKPIT_ENGINE_REF` is optional too, defaulting to `main`.

**3. Source the launchers** from your shell rc, and install `mosh` locally (the server side comes from the step above):

```sh
echo 'source ~/cockpit/provision/aliases.sh' >> ~/.bashrc
```

The install script writes a matching `claudex` launcher into the VPS user's `~/.bashrc`, for sessions started on the box itself. It follows the same rule: plain `claude` unless `COCKPIT_SKIP_PERMISSIONS=1` is exported, and the block explains itself in place.

**Permission prompts.** The launchers run plain `claude`, so Claude Code asks before it runs a command, edits a file, or reaches the network. To turn those prompts off for VPS sessions, add `export COCKPIT_SKIP_PERMISSIONS=1` to your shell rc above the `source` line. That passes `--dangerously-skip-permissions`, which lets the agent read, write, delete, and execute anywhere on the VPS with no confirmation. It is a reasonable trade on a dedicated box holding nothing you cannot lose, and a bad idea anywhere else.

**4. Launch.** `claudex.cockpit` opens Claude Code in the engine root on the VPS. `claudex.scope <name>` opens it in the named scope workspace (e.g. `claudex.scope personal`). Both are shell functions, not aliases, though nothing about using them differs. No per-scope launchers ship (scopes are yours, not the engine's); define shorthands for your own scopes in your local rc:

```sh
alias claudex.per='claudex.scope personal'
```
