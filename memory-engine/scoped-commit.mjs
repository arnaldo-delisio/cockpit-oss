// scoped-commit.mjs — the path-scoped git commit helper (ATT-4 step 1), extracted from
// accept.mjs so every write verb of the transaction contract (roadmap.mjs, decisions.mjs,
// attention.mjs, accept.mjs) commits through ONE implementation. The lessons it carries:
// projection.mjs commitIfOwn's repo-toplevel guard (`git -C` on a non-toplevel root silently
// operates on the PARENT repo — verify once, refuse loudly), the locale-proof staged check
// (probe the index, never parse stderr text), nothing-to-commit is not an error, and a REAL
// git failure is reported (thrown), never swallowed. Helpers throw plain Errors; callers with
// a refuse()/exitCode contract wrap them.

import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Bare git runner rooted at `root` — exported so callers needing extra plumbing (status,
// ls-files, show) share the same invocation shape instead of redeclaring it.
export async function gitAt(root, args) { return execFileP('git', ['-C', root, ...args]); }

// Repo-ownership guard, cached per root for the life of the process.
const verifiedRoots = new Set();
export async function assertOwnRepo(root) {
  const abs = resolve(root);
  if (verifiedRoots.has(abs)) return;
  let toplevel;
  try { ({ stdout: toplevel } = await gitAt(abs, ['rev-parse', '--show-toplevel'])); }
  catch { throw new Error(`root is not a git repo (${abs}); refusing to commit`); }
  toplevel = resolve(toplevel.trim());
  if (toplevel !== abs) {
    throw new Error(`root is not its own git repo (toplevel: ${toplevel}); refusing to commit`);
  }
  verifiedRoots.add(abs);
}

// Commit with bootstrap's no-identity fallback (bootstrap.mjs seedCommit). A box with no
// discoverable git identity fails inside `git commit` with "unable to auto-detect email
// address", which aborted the first reconcile AFTER its nodes were already on disk. The
// retry only ever runs once the plain commit has already failed, so an identity the user set
// at ANY level (local, global, system, env) is used as-is and never overridden.
//
// And it only runs once git has POSITIVELY said it cannot resolve a committer identity, probed
// with `git var GIT_COMMITTER_IDENT` (the same resolution `git commit` uses, with no side
// effects). Retrying every failure was wrong in kind, not only in taste: a commit rejected for
// some OTHER reason, say a hook that rejects the configured author, would then land under the
// fallback identity, which is exactly the override this fallback promises never to do. Any
// non-identity failure rethrows the ORIGINAL error, untouched and unretried.
const FALLBACK_IDENTITY = ['-c', 'user.name=cockpit reconcile', '-c', 'user.email=reconcile@cockpit.local'];
let announcedFallback = false;
export async function commitAt(root, commitArgs) {
  try { return await gitAt(root, ['commit', ...commitArgs]); }
  catch (err) {
    try { await gitAt(root, ['var', 'GIT_COMMITTER_IDENT']); }
    catch { /* git cannot resolve an identity: the one case the fallback exists for */
      return await fallbackCommit(root, commitArgs, err);
    }
    throw err;
  }
}

async function fallbackCommit(root, commitArgs, err) {
  let out;
  try { out = await gitAt(root, [...FALLBACK_IDENTITY, 'commit', ...commitArgs]); }
  catch { throw err; }
  if (!announcedFallback) {
    announcedFallback = true;
    console.warn('cockpit: no git identity found. Committed as "cockpit reconcile <reconcile@cockpit.local>".');
    console.warn('cockpit: later commits use the fallback too unless you set your own:');
    console.warn(`  git -C ${root} config user.name "Your Name"`);
    console.warn(`  git -C ${root} config user.email "you@example.com"`);
  }
  return out;
}

// The scoped commit: add exactly `paths`, commit only if that add staged something, pathspec
// both the guard and the commit so pre-staged unrelated work neither triggers nor rides along.
// Returns 'nochange' or 'committed'.
export async function scopedCommit(root, message, paths) {
  await assertOwnRepo(root);
  await gitAt(root, ['add', ...paths]);
  // commit only if the scoped add staged something (locale-proof index check, reconcile's pattern)
  try { await gitAt(root, ['diff', '--cached', '--quiet', '--', ...paths]); return 'nochange'; }
  catch { /* non-zero ⇒ staged changes exist in scope ⇒ proceed */ }
  await commitAt(root, ['-m', message, '--quiet', '--', ...paths]);
  return 'committed';
}
