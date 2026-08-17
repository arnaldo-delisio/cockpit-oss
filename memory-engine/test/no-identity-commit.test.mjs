// no-identity-commit.test.mjs — the first-run defect: on a box with no discoverable git identity,
// the first reconcile did its work and THEN died inside `git commit` with "unable to auto-detect
// email address", leaving the nodes on disk and the tree dirty. bootstrap.mjs already fell back to
// a per-command identity for its seed commit; commitAt (scoped-commit.mjs) now gives every commit
// site in the reconcile path the same treatment.
//
// The three properties pinned here:
//   1. no identity anywhere  -> the commit succeeds, authored by the fallback, and says so;
//   2. a LOCAL identity      -> used as-is, no fallback, no announcement;
//   3. a GLOBAL identity     -> same.
//
// The environment is scrubbed per test (HOME, GIT_CONFIG_GLOBAL/SYSTEM, GIT_AUTHOR_*, EMAIL) so the
// developer's own git config cannot make the no-identity case silently pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scopedCommit } from '../scoped-commit.mjs';

const execFileP = promisify(execFile);

const IDENTITY_VARS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'HOME'];

async function freshRepo() {
  const root = await mkdtemp(resolve(tmpdir(), 'cockpit-identity-'));
  await execFileP('git', ['-C', root, 'init', '--quiet']);
  await mkdir(resolve(root, '.reconciler'), { recursive: true });
  await writeFile(resolve(root, '.reconciler/state.json'), '{"consumed":{}}\n', 'utf8');
  return root;
}

// Runs `fn` with every identity source removed from the environment, then restores it.
async function withoutIdentity(overrides, fn) {
  const saved = Object.fromEntries(IDENTITY_VARS.map((k) => [k, process.env[k]]));
  for (const k of IDENTITY_VARS) delete process.env[k];
  process.env.HOME = resolve(tmpdir(), 'cockpit-identity-nonexistent-home');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  Object.assign(process.env, overrides);
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try { return await fn(warnings); }
  finally {
    console.warn = warn;
    for (const k of IDENTITY_VARS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const authorOf = async (root) => (await execFileP('git', ['-C', root, 'log', '-1', '--pretty=%an <%ae>'])).stdout.trim();

test('no git identity anywhere: the commit still lands, on the fallback identity, and announces it', async () => {
  const root = await freshRepo();
  const warnings = await withoutIdentity({}, async (warnings) => {
    const result = await scopedCommit(root, 'reconcile: first run', ['.reconciler/state.json']);
    assert.equal(result, 'committed');
    return warnings;
  });
  assert.equal(await authorOf(root), 'cockpit reconcile <reconcile@cockpit.local>');
  const said = warnings.join('\n');
  assert.match(said, /no git identity found/);
  assert.match(said, /reconcile@cockpit\.local/);
  assert.match(said, /config user\.email/);
  // The commit is the whole point: nothing may be left staged or dirty behind it.
  const { stdout: status } = await execFileP('git', ['-C', root, 'status', '--porcelain']);
  assert.equal(status.trim(), '');
});

test('a local identity wins over the fallback', async () => {
  const root = await freshRepo();
  await execFileP('git', ['-C', root, 'config', 'user.name', 'Local User']);
  await execFileP('git', ['-C', root, 'config', 'user.email', 'local@example.invalid']);
  const warnings = await withoutIdentity({}, async (warnings) => {
    await scopedCommit(root, 'reconcile: first run', ['.reconciler/state.json']);
    return warnings;
  });
  assert.equal(await authorOf(root), 'Local User <local@example.invalid>');
  assert.deepEqual(warnings, []);
});

test('a global identity wins over the fallback', async () => {
  const root = await freshRepo();
  const gitconfig = resolve(root, 'probe-gitconfig');
  await writeFile(gitconfig, '[user]\n\tname = Global User\n\temail = global@example.invalid\n', 'utf8');
  const warnings = await withoutIdentity({ GIT_CONFIG_GLOBAL: gitconfig }, async (warnings) => {
    await scopedCommit(root, 'reconcile: first run', ['.reconciler/state.json']);
    return warnings;
  });
  assert.equal(await authorOf(root), 'Global User <global@example.invalid>');
  assert.deepEqual(warnings, []);
});

// A fourth property, from a Codex finding: the fallback is for a MISSING identity, and nothing else.
// commitAt used to retry ANY failed commit under `-c user.name=cockpit reconcile`, so a commit
// rejected for another reason (here: a hook that rejects the configured author, the realistic case)
// succeeded on the second try under an identity the user never chose. That is the exact override the
// fallback promises it will never do. commitAt now probes `git var GIT_COMMITTER_IDENT` first and
// rethrows the original error untouched when git can resolve an identity.
test('a commit that fails for a NON-identity reason surfaces the original error and is never retried', async () => {
  const root = await freshRepo();
  await execFileP('git', ['-C', root, 'config', 'user.name', 'Local User']);
  await execFileP('git', ['-C', root, 'config', 'user.email', 'local@example.invalid']);
  // A pre-commit hook that rejects this author. It also records every invocation, so a silent
  // retry cannot hide: the fallback would run the hook a second time.
  const hooks = resolve(root, '.git', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(resolve(hooks, 'pre-commit'),
    '#!/bin/sh\necho run >> "$(git rev-parse --git-dir)/hook-runs"\n'
    + 'echo "policy: this author may not commit here" >&2\nexit 1\n', 'utf8');
  await chmod(resolve(hooks, 'pre-commit'), 0o755);

  const { err, warnings } = await withoutIdentity({}, async (warnings) => {
    let err;
    try { await scopedCommit(root, 'reconcile: blocked run', ['.reconciler/state.json']); }
    catch (e) { err = e; }
    return { err, warnings };
  });

  assert.ok(err, 'a rejected commit must throw, never be papered over by a second attempt');
  assert.match(String(err.stderr || err.message), /policy: this author may not commit here/,
    'the ORIGINAL git error must be what the caller sees');
  assert.deepEqual(warnings, [], 'no fallback ran, so nothing announces one');

  const runs = (await readFile(resolve(root, '.git', 'hook-runs'), 'utf8')).trim().split('\n');
  assert.equal(runs.length, 1, `the commit must be attempted exactly once, not retried (attempts: ${runs.length})`);

  const log = await execFileP('git', ['-C', root, 'log', '--oneline'])
    .then((r) => r.stdout.trim()).catch(() => '');
  assert.equal(log, '', 'no commit may exist: not the rejected one, and above all not a fallback one');
});
