#!/usr/bin/env node
// generate-image.mjs, the cockpit's image lane wrapper around the Codex CLI.
//
// Codex ships a built-in image_gen tool billed through the ChatGPT subscription: no API
// key, no per-image cost. This wrapper turns that into a machine-checkable step: the
// prompt travels by FILE and STDIN (authored prose never travels as a shell word), the
// child is started with spawn() and an argument array (never shell: true), and the
// outcome is an exit code you can branch on.
//
// Usage:
//   node generate-image.mjs <prompt-file> --out <output-path> [--timeout <seconds>]
//
// Exit codes (the core contract):
//   0  GENERATED.              The image exists at --out, non-empty; its absolute path
//                              is printed on stdout.
//   2  IMAGE TOOL UNAVAILABLE. Codex ran but reported no image generation tool.
//   3  DID NOT GENERATE.       Spawn failure, prompt delivery failure, non-zero exit,
//                              killed by signal, timeout, missing or empty output file,
//                              or an unreadable/empty prompt file.
//   1  Bad CLI usage only (unknown flag, missing or extra argument).
// Codes 2 and 3 print an unmistakable banner; a failure never looks like success.

import { spawn } from 'node:child_process';
import { readFileSync, copyFileSync, renameSync, unlinkSync, lstatSync, rmSync, mkdtempSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const DEFAULT_WALL_MS = 300 * 1000;
const OUTPUT_CAP = 8 * 1024 * 1024; // per stream, tail kept for diagnostics
const SENTINEL = 'IMAGE_TOOL_UNAVAILABLE';

function usage() {
  return 'usage: generate-image.mjs <prompt-file> --out <output-path> [--timeout <seconds>]';
}

function parseArgs(argv) {
  const opts = { promptFile: null, out: null, wallMs: DEFAULT_WALL_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      opts.out = argv[++i];
      if (opts.out === undefined || opts.out.startsWith('-')) throw new Error('--out needs a value');
    } else if (arg === '--timeout') {
      const secs = Number(argv[++i]);
      if (!Number.isFinite(secs) || secs <= 0) throw new Error('--timeout needs a positive number of seconds');
      if (secs > 2147483) throw new Error('--timeout must be 2147483 seconds or less');
      opts.wallMs = secs * 1000;
    } else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else if (opts.promptFile === null) opts.promptFile = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!opts.promptFile) throw new Error('missing <prompt-file>');
  if (!opts.out) throw new Error('missing --out <output-path>');
  return opts;
}

// Runs the Codex CLI in workDir. The instruction goes in over stdin; argv is an array,
// so nothing here is ever parsed by a shell.
function runCodex(instruction, workDir, wallMs) {
  const args = ['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-'];
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('codex', args, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolvePromise({ spawnError: String(err && err.message ? err.message : err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let stdinDelivered = false;
    let aborted = null;
    let settled = false;
    let killTimer = null;

    // Signal the whole process group (codex spawns helpers); fall back to the child alone.
    const signalTree = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };

    const abort = (reason) => {
      if (aborted !== null) return;
      aborted = reason;
      signalTree('SIGTERM');
      killTimer = setTimeout(() => {
        signalTree('SIGKILL');
        // Give 'close' a bounded chance to fire with the real exit facts; finish is
        // idempotent, so this is only the fallback for a grandchild holding the pipes.
        setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2000);
      }, 5000);
    };

    const wallTimer = setTimeout(
      () => abort(`codex exceeded the wall clock timeout of ${Math.round(wallMs / 1000)}s`),
      wallMs,
    );

    // Byte-based cap: chunks arrive as raw Buffers (no encoding set), so chunk.length is
    // bytes; once a stream trips the cap, stop appending and keep the string tail for
    // diagnostics.
    const bytes = { out: 0, err: 0 };
    const capped = { out: false, err: false };
    const collect = (name) => (chunk) => {
      if (capped[name]) return;
      bytes[name] += chunk.length;
      if (name === 'out') stdout += chunk; else stderr += chunk;
      if (bytes[name] > OUTPUT_CAP) {
        capped[name] = true;
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
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ stdout, stderr, stdinError, stdinDelivered, aborted, ...extra });
    };

    child.on('error', (err) => finish({ spawnError: String(err.message) }));
    child.on('close', (code, signal) => finish({ code, signal }));

    child.stdin.on('error', (err) => { stdinError = String(err.message); });
    child.stdin.end(instruction, () => { if (stdinError === null) stdinDelivered = true; });
  });
}

function lastLines(text, n) {
  return String(text || '').split('\n').filter((l) => l.trim() !== '').slice(-n).join('\n');
}

function fail(banner, reason, detail) {
  process.stdout.write(`${banner}\n`);
  process.stdout.write(`Reason: ${reason}\n`);
  if (detail) process.stdout.write(`\n${detail}\n`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    return 1;
  }

  let promptText;
  try {
    promptText = readFileSync(opts.promptFile, 'utf8');
  } catch (err) {
    fail('NOT GENERATED', `cannot read prompt file ${opts.promptFile}: ${err.code || err.message}`);
    return 3;
  }
  if (promptText.trim() === '') {
    fail('NOT GENERATED', `prompt file ${opts.promptFile} is empty`);
    return 3;
  }

  const outPath = resolve(opts.out);
  const imageName = basename(outPath);
  const instruction = `Use your built-in image generation tool to create the following image and save it as ${imageName} in the current directory. If no image generation tool is available, print exactly ${SENTINEL} and stop.\n\n${promptText}`;

  let workDir;
  try {
    workDir = mkdtempSync(join(tmpdir(), 'generate-image-'));
  } catch (err) {
    fail('NOT GENERATED', `could not create a temp working directory: ${err.message}`);
    return 3;
  }
  const cleanup = () => { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ } };

  const res = await runCodex(instruction, workDir, opts.wallMs);

  // codex exec echoes the prompt into its transcript, and the instruction itself contains
  // the sentinel, so the echo must be stripped before searching or every run would look
  // like an unavailable tool. split/join removes every literal copy of the instruction.
  const transcript = `${res.stdout || ''}\n${res.stderr || ''}`.split(instruction.trim()).join('');
  // Anchored match: the sentinel must be a standalone line, not a substring of prose.
  const toolUnavailable = transcript.split('\n').some((l) => l.trim() === SENTINEL);

  if (res.spawnError) {
    cleanup();
    fail('NOT GENERATED', `codex could not be invoked: ${res.spawnError}`, lastLines(res.stderr, 20));
    return 3;
  }
  if (res.aborted) {
    cleanup();
    fail('NOT GENERATED', res.aborted, lastLines(res.stderr, 20));
    return 3;
  }
  if (res.stdinError !== null || !res.stdinDelivered) {
    cleanup();
    fail('NOT GENERATED', `the prompt was not fully delivered to codex: ${res.stdinError || 'stdin closed before the write completed'}`, lastLines(res.stderr, 20));
    return 3;
  }
  if (res.signal) {
    cleanup();
    fail('NOT GENERATED', `codex was killed by signal ${res.signal}`, lastLines(res.stderr, 20));
    return 3;
  }
  if (res.code !== 0) {
    cleanup();
    if (toolUnavailable) {
      fail('IMAGE TOOL UNAVAILABLE', 'codex reported it has no image generation tool');
      return 2;
    }
    fail('NOT GENERATED', `codex exited with code ${res.code}`, lastLines(res.stderr, 20));
    return 3;
  }

  // A verified generated file wins over transcript text: only when codex exited 0 but
  // the file is missing or empty does the transcript get consulted for the sentinel.
  const generated = join(workDir, imageName);
  let size = 0;
  try {
    const st = lstatSync(generated);
    if (st.isFile()) size = st.size; // anything else (symlink, dir, fifo) counts as missing
  } catch { /* handled below as size 0 */ }
  if (size === 0) {
    cleanup();
    if (toolUnavailable) {
      fail('IMAGE TOOL UNAVAILABLE', 'codex reported it has no image generation tool');
      return 2;
    }
    fail('NOT GENERATED', `codex exited 0 but ${imageName} was not created or is empty`, lastLines(res.stdout, 20));
    return 3;
  }

  // Atomic install: copy into a same-directory tmp file, then rename over --out, so a
  // pre-existing --out is never left half written on failure.
  const tmpOut = `${outPath}.tmp-${process.pid}`;
  try {
    // COPYFILE_EXCL: refuse to write through a pre-existing staging path (collision or
    // planted symlink); EEXIST lands in the catch without unlinking a file we did not create.
    copyFileSync(generated, tmpOut, fsConstants.COPYFILE_EXCL);
    renameSync(tmpOut, outPath);
  } catch (err) {
    if (err.code !== 'EEXIST') { try { unlinkSync(tmpOut); } catch { /* best effort */ } }
    cleanup();
    fail('NOT GENERATED', `could not move the image to ${outPath}: ${err.message}`);
    return 3;
  }
  cleanup();
  process.stdout.write(`${outPath}\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; });
