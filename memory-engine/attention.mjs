// attention.mjs — the attention sidecar contract + deterministic readiness pre-pass
// (ATT-4 step 1, board-rethink-design §4/§8). The nightly enumerator (step 2) is the writer
// and owns the lock + per-scope re-hash precondition; the dashboard middleware is the reader.
//
// Sidecar (one file per scope, derived but git-committed, so NOT under .reconciler):
// memory/scopes/<scope>/attention.json. Top level: { schemaVersion, generatedAt,
// sourceHashes (map: repo-relative roadmap path → sha256 of the file read), judgeModel,
// records }. `records` is keyed by the composite item identity (item-identity.mjs
// compositeItemKey). Per record (§8):
//   rank inputs (programRank tuple, roadmap section + position),
//   readiness: { state: 'needs-me'|'agent-ready', tier: 'deterministic'|'judge', model, ts,
//                outcome ∈ ok|timeout|skipped-budget|parse-fail },
//   greyArea: { rationale, resolve_prompt } (retained; clears only on explicit contrary
//              judgment or the item leaving the roadmap),
//   composed: { headline, description, why_now, session_prompt, ... },
//   inFlight: boolean (activity-derived, orthogonal badge, no rank effect).
// Records whose composite identity matches no open item survive one generation (rebind
// window), then drop. Publication is atomic per scope (tmp+rename, one path-scoped commit);
// a partial run keeps each unwritten scope's last good file untouched.

import { readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { MEMORY_ROOT } from './nodes.mjs';
import { REPO_ROOT, isScopeSlug, ownerName } from './paths.mjs';
import { scopedCommit } from './scoped-commit.mjs';

export const SIDECAR_SCHEMA_VERSION = 1;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function attentionSidecarPath(scope) {
  if (!isScopeSlug(scope)) throw new Error(`invalid scope slug: ${JSON.stringify(scope)}`);
  return resolve(MEMORY_ROOT, 'scopes', scope, 'attention.json');
}

// Tolerant read: missing or malformed → null, never throw (the board falls back to raw
// items). A schemaVersion mismatch is also null, with a stderr note so a silent format drift
// surfaces in logs instead of rendering garbage.
export async function loadAttentionSidecar(scope) {
  const path = attentionSidecarPath(scope);
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== SIDECAR_SCHEMA_VERSION) {
    console.error(`attention: ${path} has schemaVersion ${parsed.schemaVersion}, expected ${SIDECAR_SCHEMA_VERSION}; ignoring`);
    return null;
  }
  return parsed;
}

// sha256 per roadmap sidecar in the scope, keyed by repo-relative path — the enumerator's
// sourceHashes input and its publish-time re-hash precondition (§8).
export async function roadmapSourceHashes(scope) {
  if (!isScopeSlug(scope)) throw new Error(`invalid scope slug: ${JSON.stringify(scope)}`);
  const dir = resolve(MEMORY_ROOT, 'scopes', scope, 'projects');
  let files;
  try { files = await readdir(dir); } catch { return {}; }
  const out = {};
  for (const f of files.sort()) {
    if (!f.endsWith('.roadmap.md')) continue;
    out[`scopes/${scope}/projects/${f}`] = sha256(await readFile(resolve(dir, f)));
  }
  return out;
}

// Atomic publish + one path-scoped commit. The caller (the nightly enumerator) supplies
// sourceHashes (roadmapSourceHashes at enumeration time) and judgeModel and holds the lock;
// this helper stamps the generation metadata and never bypasses records it is handed.
export async function writeAttentionSidecar(scope, sidecar) {
  const path = attentionSidecarPath(scope);
  const stamped = {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceHashes: sidecar.sourceHashes ?? {},
    judgeModel: sidecar.judgeModel ?? null,
    records: sidecar.records ?? {},
  };
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
    await rename(tmp, path);   // atomic on the same filesystem
  } catch (e) {
    await unlink(tmp).catch(() => {});   // best-effort cleanup; the original error is what matters
    throw e;
  }
  await scopedCommit(MEMORY_ROOT, `attention: sidecar for ${scope}`, [`scopes/${scope}/attention.json`]);
  return stamped;
}

// ---------- deterministic readiness pre-pass (§4) ----------
// MONOTONIC: a deterministic needs-me is FINAL, the judge can never upgrade it; NOTHING here
// ever outputs agent-ready (the judge alone can, and only on non-final items). Two signals:
//
// 1. Explicit human-gate phrases, case-insensitive word-boundary matches. The list is a
//    build-time parameter (audit it at the verdict gate); longer phrases first so the reason
//    names the most specific hit.
//    The owner-named phrases are built from this install's owner name (paths.mjs), lowercased to
//    match the lowercased item text; with no owner resolvable only the owner-free phrases apply.
const OWNER = ownerName();
export const HUMAN_GATE_PHRASES = [
  ...(OWNER ? [
    `decide with ${OWNER}`,
    `with ${OWNER}'s go`,
    `${OWNER} decides`,
    `${OWNER}'s go`,
  ] : []),
  'decision needed',
  'asktool',
  'decide',
];
//
// 2. `→ decisions/<name>.md` pointers: a pointer whose referent does NOT exist in any of the
//    decisions dirs is a deterministic needs-me (unresolved grounding). A RESOLVED pointer is
//    returned as evidence for the judge (a settling doc supports agent-ready), never as a
//    deterministic verdict — the item stays { state: 'ambiguous', final: false }.
//
// decisionsDirs: caller-supplied absolute dirs the `decisions/` prefix resolves against;
// defaults to the engine repo's own decisions/ (REPO_ROOT via paths.mjs — never a hardcoded
// live-tree path, the port tree must resolve against itself).
export function deterministicReadiness(itemRaw, { decisionsDirs = [resolve(REPO_ROOT, 'decisions')] } = {}) {
  const text = String(itemRaw);
  const lower = text.toLowerCase();
  for (const phrase of HUMAN_GATE_PHRASES) {
    // word-boundary on both ends; escape regex specials in the phrase (apostrophes are literal)
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(lower)) {
      return { state: 'needs-me', final: true, reason: `human-gate: ${phrase}` };
    }
  }
  const evidence = [];
  for (const m of text.matchAll(/→\s*(decisions\/[a-z0-9][a-z0-9._-]*\.md)/g)) {
    const rel = m[1];
    // the pointer's `decisions/` prefix names the dir itself; resolve the remainder inside each
    const resolved = decisionsDirs.some((dir) => existsSync(resolve(dir, rel.replace(/^decisions\//, ''))));
    if (!resolved) {
      return { state: 'needs-me', final: true, reason: `unresolved decision pointer: ${rel}` };
    }
    evidence.push({ pointer: rel, resolved: true });
  }
  return { state: 'ambiguous', final: false, ...(evidence.length ? { evidence } : {}) };
}
