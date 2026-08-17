// bootstrap-memory-repo.test.mjs — the seed commit reflects the repo, not one run's memory.
//
// The bug this pins: bootstrap used to decide what to commit from its in-process `created` list,
// which records only what THAT invocation wrote. A first run that dies partway (knowledge/INDEX.md
// gets written, then a later step throws) leaves files on disk. The next run finds them already
// there, writes nothing, records nothing, and commits nothing — so memory/ stays dirty at those
// paths forever and the very first documented reconcile aborts on the crash guard
// (locks.mjs knowledgeTreeDirty).
//
// The safety property that must survive the fix: bootstrap stages paths IT owns, decided by the
// template (ensureFile() is called on them from bootstrap's own seeding code) AND by the bytes on
// disk matching that template, never a file the user put in memory/. The unrelated user file below
// is the first probe for that, checked byte for byte across both a fresh run and a resumed one; the
// second block of tests puts a user file directly ON a seed path, which is where the guarantee
// actually broke.
//
// Runs bootstrap as a child process against its own throwaway root via COCKPIT_MEMORY_ROOT, so
// nothing here can reach a real memory repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const BOOTSTRAP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bootstrap.mjs');
const USER_FILE = 'MY-OWN-NOTE.md';
const USER_BYTES = 'a note the user wrote, which bootstrap must never touch\n';

async function freshRoot(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'cockpit-bootstrap-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Never inherit the suite's own COCKPIT_MEMORY_ROOT (setup.mjs) — this child gets its own.
async function runBootstrap(root) {
  const env = { ...process.env, COCKPIT_MEMORY_ROOT: root };
  try {
    await execFileP(process.execPath, [BOOTSTRAP], { env });
    return 0;
  } catch (err) {
    return err.code ?? 1;
  }
}

// Same child run, with the exit code AND stderr, for the cases that must refuse loudly.
async function runBootstrapVerbose(root) {
  const env = { ...process.env, COCKPIT_MEMORY_ROOT: root };
  try {
    const { stderr } = await execFileP(process.execPath, [BOOTSTRAP], { env });
    return { code: 0, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stderr: err.stderr ?? '' };
  }
}

const git = async (root, args) => (await execFileP('git', ['-C', root, ...args])).stdout;

async function seedUserState(root) {
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'scopes.json'), '["cockpit"]\n', 'utf8');
  await writeFile(resolve(root, USER_FILE), USER_BYTES, 'utf8');
}

// A first run that dies PARTWAY, leaving bootstrap's own bytes on disk uncommitted. Neither a
// missing scopes.json nor a malformed one produces that any more: both checks run before the first
// write, so those refusals leave an empty root. This crashes it later instead, on a VALID scope
// name whose directory cannot be created — past the knowledge/ seed, inside ensureScope(), because
// a regular file already sits where scopes/cockpit/identity/ must go. The blocker is removed after
// the crash, so the resumed run can complete.
async function crashAfterSeed(root) {
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'scopes.json'), '["cockpit"]\n', 'utf8');
  const blocker = resolve(root, 'scopes', 'cockpit', 'identity');
  await mkdir(dirname(blocker), { recursive: true });
  await writeFile(blocker, 'not a directory\n', 'utf8');
  assert.equal(await runBootstrap(root), 1, 'the crash setup must actually fail');
  await rm(blocker);
}

test('a resumed bootstrap commits the files a crashed first run orphaned', async (t) => {
  const root = await freshRoot(t);

  await crashAfterSeed(root);
  assert.ok(await readFile(resolve(root, 'knowledge', 'INDEX.md'), 'utf8'));

  // Run 2 creates none of that: INDEX.md is already on disk and ensureFile() never clobbers.
  await seedUserState(root);
  assert.equal(await runBootstrap(root), 0);

  const tracked = (await git(root, ['ls-files'])).split('\n').filter(Boolean);
  assert.ok(
    tracked.includes('knowledge/INDEX.md'),
    `the orphaned seed file was left uncommitted; tracked: ${tracked.join(', ')}`,
  );

  // Clean except the user's own file, so the reconciler's knowledge/ crash guard passes.
  const status = (await git(root, ['status', '--porcelain'])).split('\n').filter(Boolean);
  assert.deepEqual(status, [`?? ${USER_FILE}`]);
  assert.equal((await git(root, ['status', '--porcelain', '--', 'knowledge/'])).trim(), '');

  assert.equal(await readFile(resolve(root, USER_FILE), 'utf8'), USER_BYTES);
});

// Validate-before-write, for the roster itself. loadScopes() used to check only "non-empty array",
// so an entry like "../escape" reached ensureScope() with knowledge/ and INDEX.md already written:
// the refusal left the user's data root half-initialized. Every entry is slug-gated before the
// first write now, and a rejected roster must leave the root EXACTLY as it was found.
for (const [name, json] of Object.entries({
  'path escape': '["cockpit","../escape"]\n',
  'a number': '["cockpit",7]\n',
  'null': '["cockpit",null]\n',
  'a nested array': '["cockpit",["nested"]]\n',
  'an object': '["cockpit",{"name":"cockpit"}]\n',
  'an empty string': '["cockpit",""]\n',
})) {
  test(`scopes.json with ${name} is refused before any write, leaving the memory root untouched`, async (t) => {
    const root = await freshRoot(t);
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, 'scopes.json'), json, 'utf8');

    const { code, stderr } = await runBootstrapVerbose(root);
    assert.equal(code, 1, 'a malformed roster must refuse');
    assert.match(stderr, /invalid scope name/, 'the refusal must say what is wrong');
    assert.match(stderr, /Nothing was written/, 'and that nothing was written');

    // The offending entry is named, so the operator can find it in a long roster.
    const offender = JSON.parse(json)[1];
    assert.ok(stderr.includes(JSON.stringify(offender)), `the offending entry was not named: ${stderr}`);

    // Untouched means untouched: only the file the test itself wrote is there. No knowledge/,
    // no INDEX.md, no scopes/, no git repo.
    assert.deepEqual((await readdir(root)).sort(), ['scopes.json'],
      'the refused run left files behind in the memory root');
  });
}

test('a fresh bootstrap leaves an unrelated user file untracked and byte-identical', async (t) => {
  const root = await freshRoot(t);
  await seedUserState(root);

  assert.equal(await runBootstrap(root), 0);

  const tracked = (await git(root, ['ls-files'])).split('\n').filter(Boolean);
  assert.ok(!tracked.includes(USER_FILE), `bootstrap staged the user's own file: ${tracked.join(', ')}`);
  assert.ok(tracked.includes('knowledge/INDEX.md'));
  assert.deepEqual((await git(root, ['status', '--porcelain'])).split('\n').filter(Boolean), [`?? ${USER_FILE}`]);
  assert.equal(await readFile(resolve(root, USER_FILE), 'utf8'), USER_BYTES);
});

// ---------------------------------------------------------------------------------------------
// The regression the byte check closes: claiming a path as bootstrap-owned said nothing about who
// WROTE the file sitting on it, so a user's own file at a seed path (knowledge/INDEX.md is the
// obvious one) was staged and committed by bootstrap. Ownership is now path AND content: a path
// bootstrap claimed is staged only when it is a regular file whose bytes are exactly the template
// bootstrap would have written there. That is what separates a crashed run's orphan (bootstrap's
// own bytes) from a user's file (anything else), and both properties are pinned below.

const SEED_PATH = 'knowledge/INDEX.md';
const MINE_BYTES = '# my own index\n\nnot the bootstrap template at all\n';

async function writeUserSeed(root, relPath, bytes) {
  const abs = resolve(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes, 'utf8');
}

test('a fresh bootstrap leaves the user\'s own knowledge/INDEX.md untracked and byte-identical', async (t) => {
  const root = await freshRoot(t);
  await seedUserState(root);
  await writeUserSeed(root, SEED_PATH, MINE_BYTES);

  assert.equal(await runBootstrap(root), 0);

  const tracked = (await git(root, ['ls-files'])).split('\n').filter(Boolean);
  assert.ok(!tracked.includes(SEED_PATH), `bootstrap committed the user's own ${SEED_PATH}: ${tracked.join(', ')}`);
  // The rest of the seed still lands, so the fix is a filter and not a blanket refusal to commit.
  assert.ok(tracked.some((p) => p.startsWith('scopes/cockpit/')), `nothing was seeded at all: ${tracked.join(', ')}`);
  assert.equal(await readFile(resolve(root, SEED_PATH), 'utf8'), MINE_BYTES);
});

test('a resumed bootstrap leaves the user\'s own knowledge/INDEX.md untracked and byte-identical', async (t) => {
  const root = await freshRoot(t);
  await writeUserSeed(root, SEED_PATH, MINE_BYTES);

  // Run 1 refuses in loadScopes(): no scopes.json yet, and that check runs before any write, so the
  // user's INDEX.md is untouched and still on disk, untracked, when run 2 arrives.
  assert.equal(await runBootstrap(root), 1);
  assert.equal(await readFile(resolve(root, SEED_PATH), 'utf8'), MINE_BYTES);

  await seedUserState(root);
  assert.equal(await runBootstrap(root), 0);

  const tracked = (await git(root, ['ls-files'])).split('\n').filter(Boolean);
  assert.ok(!tracked.includes(SEED_PATH), `the resumed run committed the user's own ${SEED_PATH}: ${tracked.join(', ')}`);
  assert.equal(await readFile(resolve(root, SEED_PATH), 'utf8'), MINE_BYTES);
});

test('a crashed run\'s orphan is still committed while a user file at another seed path is not', async (t) => {
  const root = await freshRoot(t);

  // Run 1 writes bootstrap's own knowledge/INDEX.md, then dies inside ensureScope().
  await crashAfterSeed(root);
  const orphan = await readFile(resolve(root, 'knowledge', 'INDEX.md'), 'utf8');

  // The user then drops their own file on a DIFFERENT claimed path, the cockpit identity stub.
  const IDENTITY = 'scopes/cockpit/identity/cockpit.md';
  await seedUserState(root);
  await writeUserSeed(root, IDENTITY, MINE_BYTES);

  assert.equal(await runBootstrap(root), 0);

  const tracked = (await git(root, ['ls-files'])).split('\n').filter(Boolean);
  assert.ok(tracked.includes('knowledge/INDEX.md'), `the orphan was not committed: ${tracked.join(', ')}`);
  assert.ok(!tracked.includes(IDENTITY), `the user's identity file was committed: ${tracked.join(', ')}`);
  assert.equal(await readFile(resolve(root, 'knowledge', 'INDEX.md'), 'utf8'), orphan);
  assert.equal(await readFile(resolve(root, IDENTITY), 'utf8'), MINE_BYTES);
});

test('a symlink at a seed path is never staged and is left as a symlink', async (t) => {
  const root = await freshRoot(t);
  await seedUserState(root);

  // Point it at a real file OUTSIDE the memory root: committing this would record the link, and
  // following it would write through to somebody else's file.
  const outside = await mkdtemp(resolve(tmpdir(), 'cockpit-bootstrap-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const targetFile = resolve(outside, 'elsewhere.md');
  await writeFile(targetFile, MINE_BYTES, 'utf8');
  await mkdir(resolve(root, 'knowledge'), { recursive: true });
  await symlink(targetFile, resolve(root, SEED_PATH));

  assert.equal(await runBootstrap(root), 0);

  const tracked = (await git(root, ['ls-files'])).split('\n').filter(Boolean);
  assert.ok(!tracked.includes(SEED_PATH), `bootstrap staged a symlink at ${SEED_PATH}: ${tracked.join(', ')}`);
  assert.ok((await lstat(resolve(root, SEED_PATH))).isSymbolicLink(), 'the symlink was replaced');
  assert.equal(await readFile(targetFile, 'utf8'), MINE_BYTES);
});

test('a symlinked ANCESTOR directory is refused: nothing is written or staged outside the memory root', async (t) => {
  const root = await freshRoot(t);
  await seedUserState(root);

  // memory/knowledge is a symlink to an external directory. exists()/stat() follow it, so every
  // check used to pass while mkdir and writeFile landed knowledge/nodes and INDEX.md out there.
  const outside = await mkdtemp(resolve(tmpdir(), 'cockpit-bootstrap-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, resolve(root, 'knowledge'));

  const { code, stderr } = await runBootstrapVerbose(root);
  assert.notEqual(code, 0, 'bootstrap must refuse, not write through the symlink');
  assert.match(stderr, /knowledge is a symlink/, `the offending component was not named: ${stderr}`);

  // Nothing landed outside the root, by any name.
  assert.deepEqual(await readdir(outside), [], 'bootstrap wrote through the symlink');
  // And nothing outside it was staged: the refusal comes before the repo is even initialized.
  assert.equal(await lstat(resolve(root, '.git')).then(() => true, () => false), false);
  assert.ok((await lstat(resolve(root, 'knowledge'))).isSymbolicLink(), 'the symlink was replaced');
});
