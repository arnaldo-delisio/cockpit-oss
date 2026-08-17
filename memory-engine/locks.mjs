#!/usr/bin/env node
// locks.mjs — the reconciler's single-writer lockfile fence (MEM-9), shared home (MEM-38 step 6).
// Moved verbatim from reconcile.mjs so accept.mjs (the ATT-3 transaction owner) and the reconciler
// fence on the SAME lock without either duplicating the stale-pid logic. Blocking-acquire
// (acquireLock) stays reconcile's shape; tryAcquireLock is the non-blocking variant accept uses:
// it clears a stale lock exactly the same way, but a live holder means `false`, never a wait.

import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MEMORY_ROOT } from './nodes.mjs';

const execFileP = promisify(execFile);

const RECON_DIR = resolve(MEMORY_ROOT, '.reconciler');
export const LOCK_FILE = resolve(RECON_DIR, 'lock');                // gitignored: transient fence

const nowISO = () => new Date().toISOString();

export async function acquireLock() {
  await mkdir(RECON_DIR, { recursive: true });
  try {
    const fh = await open(LOCK_FILE, 'wx');                 // atomic create-or-fail
    await fh.writeFile(JSON.stringify({ pid: process.pid, at: nowISO() }));
    await fh.close();
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // someone holds it — steal only if that pid is dead (crash recovery)
    let held = {};
    try { held = JSON.parse(await readFile(LOCK_FILE, 'utf8')); } catch { /* garbled */ }
    if (held.pid && isAlive(held.pid)) {
      console.error(`reconcile: another instance is running (pid ${held.pid}, since ${held.at}). Exiting.`);
      return false;
    }
    console.error(`reconcile: clearing stale lock (pid ${held.pid || '?'} not alive).`);
    await unlink(LOCK_FILE).catch(() => {});
    return acquireLock();
  }
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export async function releaseLock() { await unlink(LOCK_FILE).catch(() => {}); }

// MEM-31 catch #5 (moved from reconcile.mjs, same step): is the canonical knowledge/ tree dirty
// (uncommitted changes)? Used at lock-acquire to refuse writing over an unknown half-written
// state. Tolerant: if git itself fails, treat as clean.
export async function knowledgeTreeDirty() {
  try {
    const { stdout } = await execFileP('git', ['-C', MEMORY_ROOT, 'status', '--porcelain', '--', 'knowledge/']);
    return stdout.trim().length > 0;
  } catch { return false; }
}

// Non-blocking acquire: single wx attempt; a held-but-STALE lock is cleared (same stale-pid logic
// as acquireLock) and retried once via recursion; a held-and-alive lock returns false immediately.
export async function tryAcquireLock() {
  await mkdir(RECON_DIR, { recursive: true });
  try {
    const fh = await open(LOCK_FILE, 'wx');
    await fh.writeFile(JSON.stringify({ pid: process.pid, at: nowISO() }));
    await fh.close();
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = {};
    try { held = JSON.parse(await readFile(LOCK_FILE, 'utf8')); } catch { /* garbled */ }
    if (held.pid && isAlive(held.pid)) return false;        // live holder — never block, never steal
    await unlink(LOCK_FILE).catch(() => {});
    return tryAcquireLock();
  }
}
