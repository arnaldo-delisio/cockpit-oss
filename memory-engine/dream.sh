#!/usr/bin/env bash
# dream.sh — the nightly unattended dispatcher; called by the one existing timer (DESIGN §5/§8;
# STATE dreaming; DESIGN §6a.8 for the insights step; ATT-2 B4 scheduled-rotation amendment for the
# semantic-rotate step).
#
# Five sequential steps, each a thin wrapper for the same unattended-run concerns (minimalism
# rung 6 — the minimum that actually works; folded into ONE script + ONE timer rather than a third
# systemd/launchd unit, since all three are cheap nightly passes with the same operational needs):
#   1. PATH — judge() shells to `hermes`, which lives in ~/.local/bin; the timer's default PATH
#      does NOT include it, so an un-wrapped run would fail every night with "hermes: not found".
#   2. Observability — tee stdout+stderr to a rolling log per step (memory/.reconciler/), so a human
#      has one place to read each pass's last run; systemd's journal captures both independently.
#   3. Failure visibility — exit non-zero if EITHER step failed, so a bad run shows `failed` in
#      `systemctl --user status cockpit-reconcile.service` (and the journal) instead of silently
#      "succeeding" — the two steps are independent (an insights failure doesn't skip reconcile, and
#      vice versa), but either failing marks the whole run failed.
#
# mechanical-insights.mjs scan mints real findings (not --dry-run) — this is its ONLY automated invocation path;
# apply/promote/dismiss are exclusively human-invoked (DESIGN §6a.8's hard rule). Nightly runs export
# JUDGE_ADAPTER=hermes below, which forces every tier onto the Hermes adapter, insights' cosmetic
# Haiku-tier phrasing pass included — and that tier isn't wired there (judge-hermes.mjs only has
# hard/bulk), so it falls back to the deterministic template every night (mechanical-insights.mjs's
# phraseFinding() already swallows any judge() failure — verified, never blocks minting). Manual runs
# with no JUDGE_ADAPTER set take judge.mjs's per-tier default, which keeps the mechanical tier on the
# Claude adapter, so they get the full pass. Accepted quality-only gap, not a crash risk — drop the
# export below, or extend judge-hermes.mjs's tier map, if nightly prose quality ever actually matters.
#
# semantic-insights.mjs rotate scans exactly ONE target per night (a deterministic rotation, not a
# blind sweep — see the ATT-2 B4 scheduled-rotation amendment); it uses only the 'bulk' judge() tier,
# which IS wired on the Hermes adapter, so nightly semantic scans get real classification, unlike
# mechanical-insights.mjs's cosmetic phrasing pass above.
#
# In-repo + path-relative (resolves its own dir) => clone-clean. No secrets, no hardcoded absolute paths.

set -uo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")" && pwd -P)"   # <repo>/memory-engine
# MEM-32 seam, bash mirror of bootstrap.mjs's MEMORY_ROOT resolution (fixed here — the original
# single-step dream.sh hardcoded this relative to ENGINE_DIR, so an isolated-root run's logs still
# landed in the shared repo; only found once a second log path made the leak visible in testing).
MEMORY_ROOT="${COCKPIT_MEMORY_ROOT:-$ENGINE_DIR/../memory}"
RECONCILE_LOG="$MEMORY_ROOT/.reconciler/dreaming.log"        # gitignored; sits beside .reconciler/audit/
INSIGHTS_LOG="$MEMORY_ROOT/.reconciler/insights-scan.log"    # gitignored; sibling rolling log
SEMANTIC_LOG="$MEMORY_ROOT/.reconciler/semantic-rotate.log"  # gitignored; sibling rolling log
RELEVANCE_LOG="$MEMORY_ROOT/.reconciler/relevance.log"       # sibling rolling log (NOT gitignored:
                                                             # memory/.gitignore covers only lock +
                                                             # dreaming.log, as for the three above)
ATTENTION_LOG="$MEMORY_ROOT/.reconciler/attention.log"       # sibling rolling log (ATT-4 step 2)

# hermes (judge()'s model access; required for the hard tier, and for every tier under the export
# below) is in ~/.local/bin; node is in /usr/bin.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export JUDGE_ADAPTER=hermes   # force ALL tiers onto Hermes/Codex for the unattended run; unset it to
                              # take judge.mjs's per-tier default (hard->hermes, bulk/mechanical->claude)

ts() { date -Is 2>/dev/null || date "+%Y-%m-%dT%H:%M:%S%z"; }   # GNU date / macOS date

# keep a log bounded (last ~2000 lines) so an unattended nightly run can't grow it without limit.
trim_log() {
  if [ -f "$1" ] && [ "$(wc -l < "$1" 2>/dev/null || echo 0)" -gt 5000 ]; then
    tail -n 2000 "$1" > "$1.tmp" 2>/dev/null && mv "$1.tmp" "$1"
  fi
}

mkdir -p "$(dirname "$RECONCILE_LOG")"
trim_log "$RECONCILE_LOG"
trim_log "$INSIGHTS_LOG"
trim_log "$SEMANTIC_LOG"
trim_log "$RELEVANCE_LOG"
trim_log "$ATTENTION_LOG"

# Step 1 — reconcile --reflect (run inside a pipeline to tee; capture status via PIPESTATUS).
{
  echo "===== dreaming reflect START $(ts) (host $(hostname)) ====="
  node "$ENGINE_DIR/reconcile.mjs" --reflect
  rc=$?
  echo "===== dreaming reflect END   $(ts) exit=$rc ====="
  exit $rc
} 2>&1 | tee -a "$RECONCILE_LOG"
reconcile_rc="${PIPESTATUS[0]}"

# Step 2 — insights scan (DESIGN §6a.8: the nightly path only ever mints, never apply/promote/dismiss).
{
  echo "===== insights scan START $(ts) (host $(hostname)) ====="
  node "$ENGINE_DIR/mechanical-insights.mjs" scan
  rc=$?
  echo "===== insights scan END   $(ts) exit=$rc ====="
  exit $rc
} 2>&1 | tee -a "$INSIGHTS_LOG"
insights_rc="${PIPESTATUS[0]}"

# Step 3 — semantic rotate (ATT-2 B4 scheduled-rotation amendment: ONE target/night, never a sweep).
{
  echo "===== semantic rotate START $(ts) (host $(hostname)) ====="
  node "$ENGINE_DIR/semantic-insights.mjs" rotate
  rc=$?
  echo "===== semantic rotate END   $(ts) exit=$rc ====="
  exit $rc
} 2>&1 | tee -a "$SEMANTIC_LOG"
semantic_rc="${PIPESTATUS[0]}"

# (Step 4, inbox drain, removed: MEM-38 step 8 cut 1; numbering kept stable for the tests that
# anchor on the step labels below.)

# Step 5 — relevance sidecar (MEM-38 step 4: recall.mjs now reads .reconciler/relevance.json as the
# third factor of its ranking product, so the sidecar has to be recomputed on a schedule instead of
# by a human remembering to run `relevance.mjs --write`). --commit so the recompute lands as its own
# pathspec-scoped commit; placed BEFORE the push step so the night that computes it also ships it.
{
  echo "===== relevance sidecar START $(ts) (host $(hostname)) ====="
  node "$ENGINE_DIR/relevance.mjs" --write --commit
  rc=$?
  echo "===== relevance sidecar END   $(ts) exit=$rc ====="
  exit $rc
} 2>&1 | tee -a "$RELEVANCE_LOG"
relevance_rc="${PIPESTATUS[0]}"

# Step 5b — attention pass (ATT-4 step 2: scopes.json → roadmaps enumerator, readiness judge +
# composition, budget-capped; publishes per-scope attention.json sidecars under the shared lock).
{
  echo "===== attention pass START $(ts) (host $(hostname)) ====="
  node "$ENGINE_DIR/attention-nightly.mjs"
  rc=$?
  echo "===== attention pass END   $(ts) exit=$rc ====="
  exit $rc
} 2>&1 | tee -a "$ATTENTION_LOG"
attention_rc="${PIPESTATUS[0]}"

# Step 6 — memory auto-push (AR-3 direction 4: private memory backup = push after the nightly
# reconcile commit; standing push approval covers this repo, no deploy is wired to it). Pushes only
# when the local branch is ahead, so a no-op night stays a no-op. Failure (e.g. offline) marks the
# run failed for visibility but harms nothing: the next successful night pushes the backlog.
{
  echo "===== memory push START $(ts) (host $(hostname)) ====="
  if ! git -C "$MEMORY_ROOT" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    echo "no upstream configured (or detached HEAD) — backup invariant not evaluable"
    rc=1
  elif ahead="$(git -C "$MEMORY_ROOT" rev-list '@{upstream}'..HEAD --count)"; then
    if [ "$ahead" -gt 0 ]; then
      # push HEAD to its tested upstream explicitly (independent of push.default);
      # GIT_TERMINAL_PROMPT=0 makes a missing-credential night fail fast instead of hanging.
      GIT_TERMINAL_PROMPT=0 git -C "$MEMORY_ROOT" push origin HEAD
      rc=$?
    else
      echo "nothing to push"
      rc=0
    fi
  else
    echo "ahead-detection failed (rev-list error)"
    rc=1
  fi
  echo "===== memory push END   $(ts) exit=$rc ====="
  exit $rc
} 2>&1 | tee -a "$RECONCILE_LOG"
push_rc="${PIPESTATUS[0]}"

[ "$reconcile_rc" -eq 0 ] && [ "$insights_rc" -eq 0 ] && [ "$semantic_rc" -eq 0 ] \
  && [ "$relevance_rc" -eq 0 ] && [ "$attention_rc" -eq 0 ] && [ "$push_rc" -eq 0 ]
exit $?
