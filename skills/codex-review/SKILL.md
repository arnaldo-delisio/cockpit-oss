---
name: codex-review
description: Run the Codex reviewer lane with a shell-safe prompt path and a machine-checkable three-state outcome (reviewed / ran but unusable / did not run). Use whenever the build doctrine calls for the reviewer lane before finalizing, and in place of the vendor plugin's /codex:review, which Claude cannot invoke and which corrupts prompts containing backticks or $(...).
version: 1.0.0
model: sonnet
triggers: [codex review, reviewer lane, adversarial review, second opinion, review this build]
tags: [review, verification, codex]
allowed-tools: Bash Read Write
---

# codex-review, the reviewer lane wrapper

The vendor plugin's reviewer lane has two defects for our use. Its rescue forwarder returns
nothing when Codex cannot be invoked, so a reviewer that **died** is indistinguishable from one
that **found nothing**. And its commands pass the prompt as `codex-companion.mjs review
"$ARGUMENTS"`, so backticks and `$(...)` in authored prose are executed by the shell before Codex
ever sees them.

This wrapper is the local fix for both: the prompt travels by file and stdin (never as a shell
word), and the outcome is an exit code you can branch on.

## Run

```bash
# write the review prompt to a file first, never pass prose on the command line
node ~/cockpit/skills/codex-review/codex-review.mjs <prompt-file> \
  [--cwd <repo-dir>] [--model <m>] [--effort <e>] [--timeout <seconds>] [--json]
```

- `--cwd` sets the repository Codex reads (`codex exec --cd`). Codex runs `--sandbox read-only`.
- `--timeout` sets the wall clock budget (default 900s). A separate idle timer fires after 300s
  with no output at all. Either expiry kills Codex and exits 3, so a hang can never look like a
  pass.
- `--json` prints the validated verdict object for programmatic callers; on a failed review it
  prints `{"status":"not-reviewed","reason":...}` instead.

## Contract (do not silently change)

- **Exit 0 = REVIEWED.** Codex ran and returned a valid, schema-shaped verdict. Zero findings
  with verdict `approve` is a legitimate 0: that is "ran and found nothing".
- **Exit 2 = RAN BUT UNUSABLE.** Codex exited 0 but emitted no fenced json block, or the last
  block was followed by other content (so it is not the verdict), or the block failed to parse,
  or it parsed but violated the shape. The verdict block is anchored to the **end** of the
  transcript, because the output contract this wrapper appends itself contains an example json
  block and an echoed prompt would otherwise spoof a verdict.
- **Exit 3 = DID NOT RUN.** Spawn failure, prompt delivery failure, non-zero exit, killed by
  signal, wall clock or idle timeout, output cap exceeded (8 MB per stream), empty stdout, or an
  unreadable/empty prompt file.
- **Exit 1 = bad CLI usage only** (unknown flag, missing or extra argument). A missing prompt
  file is 3, not 1, because no review ran.
- Exits 2 and 3 print an unmistakable `NOT REVIEWED` banner and never print anything that could
  be mistaken for findings. Treat both as "the verification did not happen"; a verification that
  did not run is not one that passed.
- **Prompts are passed as files, never as shell arguments.** The child is started with an
  argument array (no `shell: true`), and the prompt reaches it over stdin, so no authored prose
  is ever parsed by a shell.
- The verdict shape mirrors the vendor plugin's own review-output schema (external to this
  repo, which ships no copy of it): `verdict`,
  `summary`, `findings[]` (severity, title, body, file, line_start, line_end, confidence,
  recommendation), `next_steps[]`.
- Zero npm dependencies, Node built-ins only.
