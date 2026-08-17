#!/usr/bin/env node
// sidecar-tasks.mjs — direct roadmap-sidecar task writes + their per-target locks (MEM-38 step 6).
// Extracted verbatim from the since-removed inbox.mjs (cut in step 8) so the ATT-3 on_accept
// families (step 7) can write sidecar tasks; accept.mjs is the consumer now.

import { readFile, mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { MEMORY_ROOT } from './nodes.mjs';

const RECONCILER_DIR = resolve(MEMORY_ROOT, '.reconciler');
const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

// ---------- per-item exclusive-create routing lock (same pattern as semantic-insights.mjs's
// per-target locks) — guards against a fire-and-forget `route` child racing a same-night `drain`
// call for the same item (Codex adversarial review, 2026-07-16, finding 1). ----------
const ROUTE_LOCK_STALE_MS = 15 * 60_000;   // a route/drain child killed mid-route (laptop sleep) must not wedge the item open forever
function routeLockPath(id) { return resolve(RECONCILER_DIR, `inbox-route-lock-${sha8(id)}.lock`); }
async function acquireRouteLock(id) {
  await mkdir(RECONCILER_DIR, { recursive: true });
  const path = routeLockPath(id);
  try { await writeFile(path, String(process.pid), { flag: 'wx' }); return path; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const { mtimeMs } = await stat(path);
      if (Date.now() - mtimeMs < ROUTE_LOCK_STALE_MS) return null;   // genuinely contended, not stale
    } catch { return null; }   // lock vanished between the failed create and stat — treat as contended, retry next call
    try { await rm(path, { force: true }); await writeFile(path, String(process.pid), { flag: 'wx' }); return path; }
    catch { return null; }   // someone else reclaimed it first — contended, not an error
  }
}
async function releaseRouteLock(path) { if (path) await rm(path, { force: true }); }

// ---------- direct sidecar write (promote + route's existing-project-task path share this) ----------
// Idempotent: embeds the inbox item id as an inline marker so a retried write (crash between the
// sidecar write and the terminal event append) never duplicates the checklist line (Codex
// adversarial review, finding 3). Requires an EXACT `## Next` heading (dashboard's own parseRoadmap
// convention) — a missing sidecar or missing heading is a GATE, not an auto-create (finding 7).
// Wrapped in the same exclusive-create lock (keyed on the sidecar path, a distinct namespace from
// per-item locks) so two concurrent direct writes to the SAME sidecar (an auto-route racing a manual
// promote for a different item targeting the same project) can't lose one under a read-modify-rename
// (Codex code review, 2026-07-16, finding 3).
export async function writeSidecarTask(sidecarPath, itemId, text) {
  const lock = await acquireRouteLock(`sidecar:${sidecarPath}`);
  if (!lock) return { ok: false, reason: 'sidecar-locked' };
  try {
    let current;
    try { current = await readFile(sidecarPath, 'utf8'); } catch { return { ok: false, reason: 'no-sidecar' }; }
    const marker = `<!-- inbox:${itemId} -->`;
    if (current.includes(marker)) return { ok: true, deduped: true };   // already written — idempotent retry
    const heading = current.match(/^## Next[ \t]*$/m);
    if (!heading) return { ok: false, reason: 'no-next-heading' };
    const insertAt = heading.index + heading[0].length;
    const line = `\n- [ ] ${text}  ${marker}`;
    const next = current.slice(0, insertAt) + line + current.slice(insertAt);
    const tmp = `${sidecarPath}.tmp-${process.pid}`;
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, sidecarPath);
    return { ok: true, deduped: false };
  } finally {
    await releaseRouteLock(lock);
  }
}
