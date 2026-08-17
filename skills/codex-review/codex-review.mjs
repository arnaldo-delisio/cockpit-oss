#!/usr/bin/env node
// codex-review.mjs, the local reviewer lane wrapper around the Codex CLI.
//
// Exists to fix two defects in the vendor plugin's reviewer lane:
//   1. Its rescue forwarder returns nothing when Codex cannot be invoked, so a reviewer
//      that DIED looks exactly like a reviewer that FOUND NOTHING.
//   2. Its review commands pass the prompt as `codex-companion.mjs review "$ARGUMENTS"`.
//      Textual substitution into a double-quoted bash string means backticks and $(...)
//      inside authored prose get EXECUTED by the shell, silently corrupting the prompt.
//
// The fix, both halves:
//   * Prompts travel by FILE and STDIN. The prompt text never becomes a shell word:
//     the child is started with spawn() and an argument array, never shell: true.
//   * The outcome is a machine-checkable three-state exit code, not free text.
//
// Doctrine: "A verification that did not run is not one that passed. Empty reviewer
// result = not reviewed."
//
// Usage:
//   node codex-review.mjs <prompt-file> [--cwd <dir>] [--model <m>] [--effort <e>]
//                                       [--timeout <seconds>] [--json]
//                                       [--sandbox read-only|danger-full-access]
//
// --sandbox (default read-only): danger-full-access exists for hosts where Codex's bundled
// sandbox cannot start (Ubuntu's apparmor_restrict_unprivileged_userns breaks its bwrap
// setup with "loopback: Failed RTM_NEWADDR"; first seen on the cockpit VPS, 2026-07-28).
// Only ever point it at a DISPOSABLE COPY of the repo, never the working tree: the flag
// removes the read-only guarantee, so the copy is what restores it structurally.
//
// Exit codes (the core contract):
//   0  REVIEWED.          Codex ran and returned a valid, schema-shaped verdict.
//                         Zero findings with verdict "approve" is a legitimate 0.
//   2  RAN BUT UNUSABLE.  Exited 0 but no JSON block, a block that is not the final thing in
//                         the transcript, unparseable JSON, or wrong shape.
//   3  DID NOT RUN.       Spawn failure, prompt delivery failure, non-zero exit, killed by
//                         signal, wall clock or idle timeout, output cap exceeded, or empty
//                         stdout. An unreadable or empty prompt file is also 3, because no
//                         review ran.
//   1  Bad CLI usage only (unknown flag, missing or extra argument).
// Codes 2 and 3 both print a NOT REVIEWED banner and never print anything that could be
// mistaken for review findings.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

const TOP_KEYS = ['verdict', 'summary', 'findings', 'next_steps'];
const FINDING_KEYS = ['severity', 'title', 'body', 'file', 'line_start', 'line_end', 'confidence', 'recommendation'];

// TOOL-10 usage pattern (2026-07-28): the reviewer lane runs on Terra by default, pinned here so
// it does not ride the Codex CLI's mutable default; Luna is the opt-in --model for mechanical
// passes. Sol is a deliberate per-invocation escalation only (Plus-plan quota burn).
const DEFAULT_MODEL = 'gpt-5.6-terra';

const DEFAULT_WALL_MS = 15 * 60 * 1000;   // whole run, overridable with --timeout <seconds>
const IDLE_MS = 5 * 60 * 1000;            // no stdout or stderr byte for this long, treated as stalled
const OUTPUT_CAP = 8 * 1024 * 1024;       // per stream, tail kept for diagnostics

const OUTPUT_CONTRACT = `

---
OUTPUT CONTRACT (mandatory, machine parsed)

End your reply with a single fenced json block, nothing after it. It must match exactly:

\`\`\`json
{
  "verdict": "approve" | "needs-attention",
  "summary": "one paragraph, non-empty",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "short title",
      "body": "what is wrong and why it matters",
      "file": "path/to/file",
      "line_start": 1,
      "line_end": 1,
      "confidence": 0.9,
      "recommendation": "what to do about it"
    }
  ],
  "next_steps": ["actionable step"]
}
\`\`\`

Rules: every listed key is required on every finding; no extra keys; line_start and
line_end are integers >= 1; confidence is a number between 0 and 1; findings may be an
empty array (use verdict "approve" when you found nothing material); next_steps may be an
empty array. Emit exactly one such block.
`;

function usage() {
  return 'usage: codex-review.mjs <prompt-file> [--cwd <dir>] [--model <m>] [--effort <e>] [--timeout <seconds>] [--json] [--sandbox read-only|danger-full-access]';
}

const SANDBOX_MODES = ['read-only', 'danger-full-access'];

function parseArgs(argv) {
  const opts = { promptFile: null, cwd: null, model: null, effort: null, json: false, wallMs: DEFAULT_WALL_MS, sandbox: 'read-only' };
  let timeout = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--cwd') opts.cwd = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--effort') opts.effort = argv[++i];
    else if (arg === '--sandbox') {
      const mode = argv[++i];
      if (!SANDBOX_MODES.includes(mode)) throw new Error(`--sandbox must be one of: ${SANDBOX_MODES.join(', ')}`);
      opts.sandbox = mode;
    }
    else if (arg === '--timeout') timeout = argv[++i];
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else if (opts.promptFile === null) opts.promptFile = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!opts.promptFile) throw new Error('missing <prompt-file>');
  for (const key of ['cwd', 'model', 'effort']) {
    if (opts[key] !== null && (opts[key] === undefined || opts[key].startsWith('-'))) {
      throw new Error(`--${key} needs a value`);
    }
  }
  if (timeout !== null) {
    const secs = Number(timeout);
    if (!Number.isFinite(secs) || secs <= 0) throw new Error('--timeout needs a positive number of seconds');
    opts.wallMs = secs * 1000;
  }
  return opts;
}

// Runs the Codex CLI. The prompt goes in over stdin; argv is an array, so nothing here is
// ever parsed by a shell.
function runCodex(opts, prompt) {
  const args = ['exec', '--sandbox', opts.sandbox];
  if (opts.cwd) args.push('--cd', opts.cwd);
  args.push('--model', opts.model || DEFAULT_MODEL);
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  args.push('-');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ spawnError: String(err && err.message ? err.message : err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let stdinDelivered = false;
    let aborted = null;      // set when we kill the child ourselves, becomes the exit 3 reason
    let settled = false;
    let idleTimer = null;
    let killTimer = null;

    // Kill the child and report. SIGTERM first, SIGKILL if it is still alive shortly after.
    // We report on that same deadline rather than waiting for 'close', because a stalled child
    // can leave a grandchild holding the stdio pipes open forever, which is precisely the hang
    // this wrapper exists to turn into a loud NOT REVIEWED.
    const abort = (reason) => {
      if (aborted !== null) return;
      aborted = reason;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish({ code: null, signal: 'SIGKILL' });
      }, 5000);
    };

    const wallTimer = setTimeout(
      () => abort(`codex exceeded the wall clock timeout of ${Math.round(opts.wallMs / 1000)}s`),
      opts.wallMs,
    );
    const touchIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abort(`codex produced no output for ${Math.round(IDLE_MS / 1000)}s (stalled)`),
        IDLE_MS,
      );
    };
    touchIdle();

    // Cap each stream, keeping the tail: diagnostics live at the end, and an unbounded
    // transcript is its own failure mode.
    const collect = (name) => (chunk) => {
      touchIdle();
      if (name === 'out') stdout += chunk; else stderr += chunk;
      const size = name === 'out' ? stdout.length : stderr.length;
      if (size > OUTPUT_CAP) {
        if (name === 'out') stdout = stdout.slice(-OUTPUT_CAP); else stderr = stderr.slice(-OUTPUT_CAP);
        abort(`codex ${name === 'out' ? 'stdout' : 'stderr'} exceeded the ${OUTPUT_CAP} byte cap`);
      }
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr, stdinError, stdinDelivered, aborted, ...extra });
    };

    child.on('error', (err) => finish({ spawnError: String(err.message) }));
    child.on('close', (code, signal) => finish({ code, signal }));

    // Prompt delivery is load bearing: a truncated prompt can still yield well formed JSON,
    // which would be a false exit 0. Track it instead of swallowing the error.
    child.stdin.on('error', (err) => { stdinError = String(err.message); });
    child.stdin.end(prompt, () => { if (stdinError === null) stdinDelivered = true; });
  });
}

// The verdict block must be the LAST thing in the transcript. Anchoring matters: our own
// OUTPUT_CONTRACT carries an example ```json block, so an echoed prompt is a realistic spoof
// source, and only the trailing block is the model's actual answer.
// Returns { block } on success, or { error } describing why nothing usable was found.
function extractJsonBlock(text) {
  const re = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let last = null;
  let m = re.exec(text);
  while (m !== null) {
    last = m;
    m = re.exec(text);
  }
  if (last === null) return { error: 'codex ran but emitted no fenced json verdict block' };
  const trailing = text.slice(last.index + last[0].length);
  if (trailing.trim() !== '') {
    return { error: 'the final fenced json block is followed by other content, so it is not the verdict block' };
  }
  return { block: last[1] };
}

function validate(obj) {
  const errs = [];
  const isStr = (v) => typeof v === 'string' && v.length > 0;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return ['not a JSON object'];
  const unknownTop = Object.keys(obj).filter((k) => !TOP_KEYS.includes(k));
  if (unknownTop.length > 0) errs.push(`unknown top level keys: ${unknownTop.join(', ')}`);
  if (obj.verdict !== 'approve' && obj.verdict !== 'needs-attention') errs.push('verdict must be "approve" or "needs-attention"');
  if (!isStr(obj.summary)) errs.push('summary must be a non-empty string');
  if (!Array.isArray(obj.findings)) errs.push('findings must be an array');
  if (!Array.isArray(obj.next_steps)) errs.push('next_steps must be an array');
  else if (!obj.next_steps.every(isStr)) errs.push('next_steps must contain non-empty strings');
  if (Array.isArray(obj.findings)) {
    obj.findings.forEach((f, i) => {
      const at = `findings[${i}]`;
      if (f === null || typeof f !== 'object' || Array.isArray(f)) { errs.push(`${at} is not an object`); return; }
      const unknown = Object.keys(f).filter((k) => !FINDING_KEYS.includes(k));
      if (unknown.length > 0) errs.push(`${at} has unknown keys: ${unknown.join(', ')}`);
      if (!Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, f.severity)) errs.push(`${at}.severity invalid`);
      for (const k of ['title', 'body', 'file']) if (!isStr(f[k])) errs.push(`${at}.${k} must be a non-empty string`);
      for (const k of ['line_start', 'line_end']) if (!Number.isInteger(f[k]) || f[k] < 1) errs.push(`${at}.${k} must be an integer >= 1`);
      if (Number.isInteger(f.line_start) && Number.isInteger(f.line_end) && f.line_end < f.line_start) {
        errs.push(`${at}.line_end must be >= line_start`);
      }
      if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) errs.push(`${at}.confidence must be a number 0..1`);
      if (typeof f.recommendation !== 'string') errs.push(`${at}.recommendation must be a string`);
    });
  }
  return errs;
}

function notReviewed(reason, detail, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: 'not-reviewed', reason })}\n`);
  } else {
    process.stdout.write('NOT REVIEWED\n');
    process.stdout.write(`Reason: ${reason}\n`);
    if (detail) process.stdout.write(`\n${detail}\n`);
  }
}

function lastLines(text, n) {
  return String(text || '').split('\n').filter((l) => l.trim() !== '').slice(-n).join('\n');
}

function printReport(result) {
  const out = [];
  out.push('Codex review');
  out.push(`Verdict: ${result.verdict}`);
  out.push('');
  out.push(result.summary);
  out.push('');
  if (result.findings.length === 0) {
    out.push('No material findings.');
  } else {
    const sorted = [...result.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    for (const f of sorted) {
      out.push(`- [${f.severity}] ${f.title} (${f.file}:${f.line_start}-${f.line_end})`);
      out.push(`    ${f.body}`);
      if (f.recommendation) out.push(`    Fix: ${f.recommendation}`);
    }
  }
  if (result.next_steps.length > 0) {
    out.push('');
    out.push('Next steps:');
    for (const s of result.next_steps) out.push(`- ${s}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    process.exit(1);
  }

  let promptText;
  try {
    promptText = readFileSync(opts.promptFile, 'utf8');
  } catch (err) {
    notReviewed(`cannot read prompt file ${opts.promptFile}: ${err.code || err.message}`, null, opts.json);
    process.exit(3);
  }
  if (promptText.trim() === '') {
    notReviewed(`prompt file ${opts.promptFile} is empty`, null, opts.json);
    process.exit(3);
  }

  const res = await runCodex(opts, promptText + OUTPUT_CONTRACT);

  if (res.spawnError) {
    notReviewed(`codex could not be invoked: ${res.spawnError}`, lastLines(res.stderr, 20), opts.json);
    process.exit(3);
  }
  if (res.aborted) {
    // Both tails: an abort can be tripped by either stream, and the cap keeps the tail of the
    // one that overflowed precisely so it can be shown here.
    const tails = [
      res.stdout.trim() ? `stdout tail:\n${lastLines(res.stdout, 20)}` : null,
      res.stderr.trim() ? `stderr tail:\n${lastLines(res.stderr, 20)}` : null,
    ].filter(Boolean).join('\n\n');
    notReviewed(res.aborted, tails || null, opts.json);
    process.exit(3);
  }
  if (res.stdinError !== null || !res.stdinDelivered) {
    notReviewed(`the prompt was not fully delivered to codex: ${res.stdinError || 'stdin closed before the write completed'}`, lastLines(res.stderr, 20), opts.json);
    process.exit(3);
  }
  if (res.signal) {
    notReviewed(`codex was killed by signal ${res.signal}`, lastLines(res.stderr, 20), opts.json);
    process.exit(3);
  }
  if (res.code !== 0) {
    notReviewed(`codex exited with code ${res.code}`, lastLines(res.stderr, 20), opts.json);
    process.exit(3);
  }
  if (res.stdout.trim() === '') {
    notReviewed('codex produced no output', lastLines(res.stderr, 20), opts.json);
    process.exit(3);
  }

  const { block, error } = extractJsonBlock(res.stdout);
  if (error) {
    notReviewed(error, `Raw final output:\n${lastLines(res.stdout, 40)}`, opts.json);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    notReviewed(`verdict block is not valid JSON: ${err.message}`, `Raw block:\n${block}`, opts.json);
    process.exit(2);
  }
  const errs = validate(parsed);
  if (errs.length > 0) {
    notReviewed(`verdict block violates the schema: ${errs.join('; ')}`, `Raw block:\n${block}`, opts.json);
    process.exit(2);
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  else printReport(parsed);
  process.exit(0);
}

main();
