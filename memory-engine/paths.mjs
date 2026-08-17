// paths.mjs — the single root resolution rule (port layout §6).
//
// The repo root IS the instance tree: memory/ (private data repo) and scopes/<scope>/
// (scope workspaces) live inside it, gitignored. Everything resolves from this file's
// own location, so a clone works wherever it is checked out. Secrets live outside the
// tree at ~/.config/cockpit/env (layout §7).

import { resolve, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Private DATA repo. COCKPIT_MEMORY_ROOT overrides it (single-point seam) so a
// confidential/co-owned scope can run against an isolated local root — MEM-32.
export const MEMORY_ROOT = process.env.COCKPIT_MEMORY_ROOT
  ? resolve(process.env.COCKPIT_MEMORY_ROOT)
  : resolve(REPO_ROOT, 'memory');

// True when the engine runs against a walled non-default root (MEM-32). Projection uses it
// to refuse writing any target outside MEMORY_ROOT.
export const IS_ISOLATED_ROOT = MEMORY_ROOT !== resolve(REPO_ROOT, 'memory');

// Scope WORKSPACES, inside the tree (layout §1).
export const SCOPES_ROOT = resolve(REPO_ROOT, 'scopes');

// Secrets file, outside both trees (layout §7).
export const ENV_FILE = resolve(homedir(), '.config', 'cockpit', 'env');

// ---------- owner identity (the one resolver) ----------
// The engine has exactly two author identities: the human who owns the install, and the fixed
// agent identity `hermes`. The human's name is per install, never compiled in. Resolution order:
//   1. COCKPIT_OWNER, the explicit seam
//   2. the first name in `git config user.name` read from the memory/ repo, since INSTALL step 5
//      tells the user to set their identity there (`git -C ~/cockpit/memory config user.name`).
//      This also picks up a global identity, because a repo-local read falls back to the global
//      config when the repo has no local value.
//   3. the first name in `git config user.name` read from the engine repo root, for a box whose
//      identity lives only there.
// All are reduced to a lowercase single-word slug, so "Ada Lovelace" resolves to "ada". An
// unresolvable name returns null, and each caller decides what to do about it (the decision CLI
// refuses the pin family, the attention matcher drops its owner-named phrases).
export const AGENT_AUTHOR = 'hermes';

const OWNER_SLUG = /^[a-z][a-z0-9-]*$/;

function slugifyOwner(raw) {
  const first = String(raw || '').trim().split(/\s+/)[0] || '';
  const slug = first.toLowerCase();
  return OWNER_SLUG.test(slug) && slug !== AGENT_AUTHOR ? slug : null;
}

let _owner;
export function ownerName() {
  if (_owner !== undefined) return _owner;
  let name = slugifyOwner(process.env.COCKPIT_OWNER);
  for (const cwd of [MEMORY_ROOT, REPO_ROOT]) {
    if (name) break;
    try {
      name = slugifyOwner(execFileSync('git', ['config', 'user.name'], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch { /* no git, no such dir, no config, or no name set */ }
  }
  return (_owner = name);
}

// How a model prompt names the reader: this install's owner, capitalized for prose, or a
// neutral "the owner" when no owner name is set. Prompt-facing counterpart of ownerName().
export function ownerLabel() {
  const name = ownerName();
  return name ? name[0].toUpperCase() + name.slice(1) : 'the owner';
}

export const OWNER_UNSET_HINT =
  'cannot resolve the owner identity: set COCKPIT_OWNER=<yourname> or `git -C <repo>/memory config user.name "Your Name"`';

// Scope-slug gate: a scope name reaching the filesystem must never be a path escape
// ('.', '..', separators, absolute paths) — reject anything off-pattern.
const SCOPE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const isScopeSlug = (s) => typeof s === 'string' && SCOPE_SLUG.test(s);

// Registered scopes (memory/scopes.json). Registration is deliberate (layout §5):
// anything absent from this list is never auto-adopted. Cached per process, keyed on the
// file's CONTENT so an in-process write to scopes.json is seen on the next call (no stale cache).
// Content, not mtime, for the same reason scopeAliases() below uses it: two rewrites inside one
// filesystem timestamp tick share an mtime, and an mtime-keyed cache would then serve the stale list
// for the rest of the process, deregistering nothing. The registry is a bare array of slugs, so
// reading it on every call is cheap, and its bytes are the only identity that cannot go stale.
let _registered = null;
let _registeredText = null;
export function registeredScopes() {
  const file = resolve(MEMORY_ROOT, 'scopes.json');
  let text = null;
  try { text = readFileSync(file, 'utf8'); } catch { /* absent (fresh clone) */ }
  if (_registered && text === _registeredText) return _registered;
  _registeredText = text;
  try {
    const raw = JSON.parse(text);
    if (Array.isArray(raw) && raw.length) return (_registered = raw.map(String));
  } catch { /* absent or malformed */ }
  return (_registered = ['cockpit']);
}

// Scope ALIASES (memory/scope-aliases.json), a hand-authored sidecar: scope slug -> the names that
// identify that scope's work in a node's own content. Read by the reconciler's scope derivation, which
// corrects a cwd-derived stamp. Cached on the alias file's CONTENT plus the registered-scope set. Content, not
// mtime: two rewrites inside one filesystem timestamp tick share an mtime, and an mtime-keyed cache would then
// serve the first parse for the rest of the process. The sidecar is tiny, so reading it on every call is cheap,
// and its bytes are the only cache identity that cannot go stale. Gated by the registry
// (an alias key for an unregistered scope is dropped) and by a 4-character floor (short aliases match
// too much). Absent/unreadable/malformed file -> {}, i.e. a total no-op: a fresh clone behaves as before.
let _aliases = null;
let _aliasesText = null;
let _aliasesRegistryKey = null;
export function scopeAliases() {
  const file = resolve(MEMORY_ROOT, 'scope-aliases.json');
  let text = null;
  try { text = readFileSync(file, 'utf8'); } catch { /* absent or unreadable (fresh clone) */ }
  // The cached map is registry-FILTERED, so the registry is part of its identity: a scope
  // deregistered in scopes.json must drop its aliases even when the alias file never changed.
  const registered = registeredScopes();
  const registryKey = registered.join('\u0000');
  if (_aliases && text === _aliasesText && registryKey === _aliasesRegistryKey) return _aliases;
  _aliasesText = text;
  _aliasesRegistryKey = registryKey;
  const out = {};
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [slug, list] of Object.entries(raw)) {
        if (!registered.includes(slug) || !Array.isArray(list)) continue;
        const names = list.filter((a) => typeof a === 'string' && a.length >= 4);
        if (names.length) out[slug] = names;
      }
    }
  } catch { /* absent or malformed */ }
  return (_aliases = out);
}

// cwd -> scope, deepest match first (layout §6, Codex finding 3):
//   <repo>/scopes/<x>[/...]  -> x, ONLY if x is registered in memory/scopes.json
//                               (unregistered workspace dirs never capture, layout §5)
//   inside the repo but NOT under scopes/ -> cockpit
//   anywhere else -> null (no fabricated scope)
export function mappedScope(cwd) {
  if (!cwd) return null;
  const c = resolve(cwd);
  if (c.startsWith(SCOPES_ROOT + sep)) {
    const top = relative(SCOPES_ROOT, c).split(sep)[0];
    if (top) return registeredScopes().includes(top) ? top : null;
  }
  if (c === REPO_ROOT || c.startsWith(REPO_ROOT + sep)) return 'cockpit';
  return null;
}

// ---------- symlink containment (one home for both walls) ----------
// `stat`/`access` follow symlinks, so a symlinked component (say memory/knowledge pointing at
// another tree, or a sources/*.md symlink pointing at knowledge/) makes every existence check
// pass while the read and the write land OUTSIDE the root. Returns the root-relative path of the
// first symlinked directory component beneath `root`, or null when the chain is clean. Paths
// outside `root` are not this wall's business and return null.
// The FINAL component is NOT checked: bootstrap leaves an existing symlink at a seed path alone,
// and callers that must also reject a symlinked leaf (reconcile's --forget-scope) lstat it
// themselves.
export async function symlinkedAncestor(p, root = MEMORY_ROOT) {
  const r = relative(root, p);
  if (!r || r.startsWith('..') || r.startsWith('/')) return null;
  const parts = r.split(sep).slice(0, -1);
  let cur = root;
  for (const part of parts) {
    cur = resolve(cur, part);
    let st;
    try { st = await lstat(cur); } catch { return null; }   // missing: a later mkdir creates it real
    if (st.isSymbolicLink()) return relative(root, cur);
  }
  return null;
}
