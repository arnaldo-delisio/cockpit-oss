// claudex-alias-migration.test.mjs — provision/claudex-bashrc.sh, the ~/.bashrc migration
// install.sh §10b performs on an existing box.
//
// The defect, from a Codex finding: the removal matched `^alias claudex=` only. `alias   claudex=`,
// an indented declaration, and single-quoted or unquoted forms are all valid shell that declares
// the same alias, and all survived. A surviving alias SHADOWS the new function, so the box kept the
// permissive launcher (`claude --dangerously-skip-permissions`, no prompts, ever) while the
// migration reported success. Belt and braces now: the removal matches any valid spelling, and the
// generated block unaliases the name before defining the function.
//
// Runs the real script against scratch files under the test root, never a real HOME, and asserts on
// what a real `bash -i`-style source of the result actually resolves `claudex` to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';

const execFileP = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, '..', '..', 'provision', 'claudex-bashrc.sh');
const SCRATCH = resolve(TEST_MEMORY_ROOT, 'bashrc-fixtures');

// Every valid spelling of the legacy permissive alias. All of them shadow a function of the
// same name, so all of them must be gone after the migration.
const SPELLINGS = {
  'plain-double-quoted': 'alias claudex="claude --dangerously-skip-permissions"\n',
  'single-quoted': "alias claudex='claude --dangerously-skip-permissions'\n",
  'unquoted': 'alias claudex=claude\n',
  'extra-spaces': 'alias    claudex="claude --dangerously-skip-permissions"\n',
  'tab-separated': 'alias\tclaudex="claude --dangerously-skip-permissions"\n',
  'indented': '  alias claudex="claude --dangerously-skip-permissions"\n',
  'indented-and-spaced': '\t alias   claudex=\'claude --dangerously-skip-permissions\'\n',
};

const PREAMBLE = '# existing user rc\nexport EDITOR=vim\n';

async function runMigration(rc) {
  return execFileP('bash', [SCRIPT, rc], { env: { PATH: '/usr/bin:/bin' } });
}

// Same run, but for the cases that must FAIL: exit code plus both streams.
async function runMigrationCode(rc) {
  try {
    const { stdout, stderr } = await runMigration(rc);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// What `claudex` resolves to in a shell that sourced this rc: 'function', 'alias', or 'none'.
// This is the property that matters; the file's text is only how it is achieved.
async function resolvesTo(rc) {
  const probe = `shopt -s expand_aliases; . ${rc} >/dev/null 2>&1; `
    + 'if alias claudex >/dev/null 2>&1; then echo alias; '
    + 'elif declare -F claudex >/dev/null 2>&1; then echo function; else echo none; fi';
  const { stdout } = await execFileP('bash', ['-c', probe], { env: { PATH: '/usr/bin:/bin', HOME: SCRATCH } });
  return stdout.trim();
}

for (const [name, line] of Object.entries(SPELLINGS)) {
  test(`legacy alias spelling "${name}" is removed, and claudex resolves to the function`, async () => {
    await mkdir(SCRATCH, { recursive: true });
    const rc = resolve(SCRATCH, `bashrc-${name}`);
    await writeFile(rc, PREAMBLE + line, 'utf8');

    const first = await runMigration(rc);
    assert.match(first.stdout, /removed legacy permissive/, 'the migration must report the removal it made');

    const text = await readFile(rc, 'utf8');
    assert.doesNotMatch(text, /^[ \t]*alias[ \t]+claudex=/m, `the ${name} declaration survived the migration`);
    assert.match(text, /^export EDITOR=vim$/m, 'unrelated rc lines must be left alone');
    assert.match(text, /^unalias claudex 2>\/dev\/null \|\| true$/m,
      'the block must unalias the name before defining the function, so any survivor cannot shadow it');
    assert.equal(await resolvesTo(rc), 'function', 'claudex must resolve to the prompting function, not the alias');

    // Re-run: idempotent, no second block, still the function.
    const second = await runMigration(rc);
    assert.match(second.stdout, /^skip: claudex launcher already in/m, 'a re-run must skip, not append again');
    const after = await readFile(rc, 'utf8');
    assert.equal(after, text, 'a re-run must leave the file byte-identical');
    assert.equal((after.match(/^# cockpit: claudex launcher/gm) || []).length, 1, 'exactly one launcher block');
    assert.equal(await resolvesTo(rc), 'function');
  });
}

// A compound line is the USER's code, not the old installer's. The migration is line-based, so
// deleting it would take the trailing command with it. It must survive byte-identically, and the
// block's `unalias` is what stops the alias from shadowing the function.
const COMPOUND = "alias claudex='claude --dangerously-skip-permissions'; export PATH=/custom/bin:$PATH\n";

test('a compound line keeps its unrelated command byte-identically, and claudex still resolves to the function', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-compound');
  await writeFile(rc, PREAMBLE + COMPOUND, 'utf8');

  const first = await runMigration(rc);
  const text = await readFile(rc, 'utf8');
  assert.ok(text.includes(COMPOUND), 'the whole user line, trailing export included, must survive untouched');
  assert.match(text, /export PATH=\/custom\/bin:\$PATH/, 'the unrelated command must not be deleted');
  assert.doesNotMatch(first.stdout, /removed legacy permissive/, 'nothing was removed, so nothing may claim it was');
  assert.match(first.stdout, /left untouched \(not ours to rewrite\)/, 'the operator must be told the line was left in place');
  assert.match(first.stdout, /^ +3:alias claudex=/m, 'the report must point at the line, with its number');
  assert.equal(await resolvesTo(rc), 'function', 'the block unalias must beat the surviving compound alias');

  const second = await runMigration(rc);
  assert.match(second.stdout, /^skip: claudex launcher already in/m, 'a re-run must skip, not append again');
  assert.equal(await readFile(rc, 'utf8'), text, 'a re-run must leave the file byte-identical');
  assert.equal(await resolvesTo(rc), 'function');
});

// The one state the migration cannot fix: the box still launches claudex with
// --dangerously-skip-permissions. Reporting success here is how the permissive default survives, so
// the script exits NON-ZERO and install.sh (set -e) aborts on the step instead of recording it done.
test('a compound line BELOW the launcher block FAILS the migration, not just a warning', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-compound-below');
  await writeFile(rc, PREAMBLE, 'utf8');
  await runMigration(rc);
  await writeFile(rc, await readFile(rc, 'utf8') + COMPOUND, 'utf8');

  const r = await runMigrationCode(rc);
  assert.notEqual(r.code, 0, 'a still-permissive box must never be reported as a successful step');
  assert.match(r.stdout, /STILL SHADOWS the function/, 'the one case the unalias cannot fix must be named loudly');
  assert.match(r.stderr, /FAILED:/, 'the failure must reach stderr, where a failed step is read');
  assert.equal(await resolvesTo(rc), 'alias', 'and the box really is still permissive');
  assert.ok((await readFile(rc, 'utf8')).includes(COMPOUND), 'and the user line is still not ours to rewrite');
});

// The mirror case: ABOVE the block, the block's own `unalias` neutralizes it, so the box is safe
// and the step is a clean success with its report. Only a survivor BELOW is the failure.
test('a compound line ABOVE the launcher block stays a clean exit 0 with its report', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-compound-above');
  await writeFile(rc, PREAMBLE + COMPOUND, 'utf8');

  const first = await runMigrationCode(rc);
  assert.equal(first.code, 0, 'a harmless compound line must not fail the step');
  assert.match(first.stdout, /left untouched \(not ours to rewrite\)/);
  assert.equal(await resolvesTo(rc), 'function');

  // And on a re-run, with the block already present, it still reports and still succeeds.
  const second = await runMigrationCode(rc);
  assert.equal(second.code, 0, 'a re-run over the same harmless line must stay exit 0');
  assert.match(second.stdout, /^skip: claudex launcher already in/m);
  assert.doesNotMatch(second.stdout, /STILL SHADOWS/, 'a line above the block never shadows anything');
  assert.equal(await resolvesTo(rc), 'function');
});

// The same failure by another spelling. A line-anchored scan sees nothing here: the declaration
// sits inside an `if`, mid-line. Sourced, it still defines the alias after the function, so the box
// is still permissive and the step must still fail.
const INLINE = "if :; then alias claudex='claude --dangerously-skip-permissions'; fi\n";

test('an INLINE alias below the launcher block FAILS the migration, and the text is left alone', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-inline-below');
  await writeFile(rc, PREAMBLE, 'utf8');
  await runMigration(rc);
  await writeFile(rc, await readFile(rc, 'utf8') + INLINE, 'utf8');
  assert.equal(await resolvesTo(rc), 'alias', 'control: the inline form really does shadow the function');

  const r = await runMigrationCode(rc);
  assert.notEqual(r.code, 0, 'a still-permissive box must never be reported as a successful step');
  assert.match(r.stdout, /STILL SHADOWS the function/, 'the inline form must be named as loudly as the compound one');
  assert.match(r.stderr, /FAILED:/, 'the failure must reach stderr, where a failed step is read');
  assert.ok((await readFile(rc, 'utf8')).includes(INLINE), 'detect and refuse: arbitrary shell is never rewritten');
  assert.equal(await resolvesTo(rc), 'alias', 'and the box really is still permissive');
});

// Above the block, the block's own `unalias` runs last and wins, so this one is harmless.
test('an INLINE alias ABOVE the launcher block stays clean, on the first run and the re-run', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-inline-above');
  await writeFile(rc, PREAMBLE + INLINE, 'utf8');

  const first = await runMigrationCode(rc);
  assert.equal(first.code, 0, 'a harmless inline alias must not fail the step');
  assert.doesNotMatch(first.stdout, /STILL SHADOWS/, 'a line above the block never shadows anything');
  assert.equal(await resolvesTo(rc), 'function');

  const second = await runMigrationCode(rc);
  assert.equal(second.code, 0, 'a re-run over the same harmless line must stay exit 0');
  assert.doesNotMatch(second.stdout, /STILL SHADOWS/);
  assert.equal(await resolvesTo(rc), 'function');
});

// The block writes `unalias claudex` and `claudex()`. An unanchored scan for the alias must not
// mistake the block's own text for a user alias and fail a correctly installed file.
test('a correctly installed file with no user alias re-runs clean, with no false shadow report', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-clean-rerun');
  await writeFile(rc, PREAMBLE, 'utf8');
  await runMigration(rc);
  const text = await readFile(rc, 'utf8');

  const second = await runMigrationCode(rc);
  assert.equal(second.code, 0, 'the launcher block must never flag itself as a shadowing alias');
  assert.match(second.stdout, /^skip: claudex launcher already in/m);
  assert.doesNotMatch(second.stdout, /STILL SHADOWS/, 'no false shadow report');
  assert.doesNotMatch(second.stdout, /left untouched/, 'and nothing to report as left untouched');
  assert.equal(await readFile(rc, 'utf8'), text, 'a re-run must leave the file byte-identical');
  assert.equal(await resolvesTo(rc), 'function');
});

// The third spelling in three review rounds (extra whitespace, then inline, now a line
// continuation), which is why the VERDICT stopped being lexical. No pattern here is matched: the
// declaration is split across two lines. Sourced, it still shadows the function, and the
// behavioural probe sees exactly that.
const CONTINUED = "alias \\\n  claudex='claude --dangerously-skip-permissions'\n";

test('a line-CONTINUED alias below the launcher block FAILS the migration, caught behaviourally', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-continued-below');
  await writeFile(rc, PREAMBLE, 'utf8');
  await runMigration(rc);
  await writeFile(rc, await readFile(rc, 'utf8') + CONTINUED, 'utf8');
  assert.equal(await resolvesTo(rc), 'alias', 'control: the continued form really does shadow the function');

  const r = await runMigrationCode(rc);
  assert.equal(r.code, 3, 'a still-permissive box must never be reported as a successful step');
  assert.match(r.stderr, /FAILED: .*still resolves claudex to an alias/, 'the verdict must come from what bash resolves');
  assert.ok((await readFile(rc, 'utf8')).includes(CONTINUED), 'detect and refuse: arbitrary shell is never rewritten');
  assert.equal(await resolvesTo(rc), 'alias', 'and the box really is still permissive');
});

// The same spelling ABOVE the block is defeated by the block's own `unalias`, so it must stay a
// clean pass. A lexical scan would have to know it is above; the probe just sees the function.
test('a line-CONTINUED alias ABOVE the launcher block stays a clean exit 0', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-continued-above');
  await writeFile(rc, PREAMBLE + CONTINUED, 'utf8');

  const first = await runMigrationCode(rc);
  assert.equal(first.code, 0, 'a harmless continued alias must not fail the step');
  assert.equal(await resolvesTo(rc), 'function');
  const second = await runMigrationCode(rc);
  assert.equal(second.code, 0, 'and the re-run stays clean too');
  assert.equal(await resolvesTo(rc), 'function');
});

// A check that did not run is not a check that passed. Two ways the probe can come back with no
// answer, both of which must fail the step rather than wave it through.
test('an rc that exits before the block leaves the probe with no answer, and the step FAILS', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-early-exit');
  await writeFile(rc, PREAMBLE, 'utf8');
  await runMigration(rc);
  // The block is already at the end; an early `return` above it means it never defines anything.
  const text = await readFile(rc, 'utf8');
  await writeFile(rc, text.replace(PREAMBLE, `${PREAMBLE}return 0\n`), 'utf8');

  const r = await runMigrationCode(rc);
  assert.equal(r.code, 4, 'an unanswerable probe must fail, not pass');
  assert.match(r.stderr, /could not determine/, 'and say the check could not run');
  assert.match(r.stderr, /unverified migration is not a successful one/);
});

test('no timeout binary means the probe cannot run safely, and the step FAILS rather than skipping it', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-no-timeout');
  await writeFile(rc, PREAMBLE, 'utf8');

  // A PATH carrying everything the script needs EXCEPT timeout.
  const { symlink, rm } = await import('node:fs/promises');
  const bin = resolve(SCRATCH, 'bin-no-timeout');
  await rm(bin, { recursive: true, force: true });
  await mkdir(bin, { recursive: true });
  for (const tool of ['bash', 'grep', 'sed', 'awk', 'cut', 'head', 'tail', 'mv', 'touch', 'cat']) {
    const found = (await execFileP('bash', ['-c', `command -v ${tool}`], { env: { PATH: '/usr/bin:/bin' } })).stdout.trim();
    await symlink(found, resolve(bin, tool));
  }

  const r = await execFileP('bash', [SCRIPT, rc], { env: { PATH: bin } })
    .then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code ?? 1, stderr: e.stderr ?? '' }));
  assert.equal(r.code, 4, 'an unrunnable probe is a check that did not run, never a pass');
  assert.match(r.stderr, /lacks bash or timeout/, 'and the operator must be told what is missing');
});

test('an alias that appears AFTER the launcher block is still defeated on the next migration run', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-survivor');
  await writeFile(rc, PREAMBLE, 'utf8');
  await runMigration(rc);
  // Someone (an old rc snippet, another tool) re-adds it below the block: last definition wins.
  await writeFile(rc, await readFile(rc, 'utf8') + '   alias  claudex="claude --dangerously-skip-permissions"\n', 'utf8');
  assert.equal(await resolvesTo(rc), 'alias', 'control: a later alias really does shadow the function');

  await runMigration(rc);
  assert.equal(await resolvesTo(rc), 'function', 'the migration must defeat a survivor wherever it sits');
});

test('a bashrc with no legacy alias just gains the launcher, and says nothing about a removal', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-fresh');
  await writeFile(rc, PREAMBLE, 'utf8');

  const r = await runMigration(rc);
  assert.doesNotMatch(r.stdout, /removed legacy/, 'nothing was removed, so nothing may claim it was');
  assert.match(r.stdout, /appended claudex launcher/);
  assert.equal(await resolvesTo(rc), 'function');
});

test('the launcher runs plain claude unless COCKPIT_SKIP_PERMISSIONS=1', async () => {
  await mkdir(SCRATCH, { recursive: true });
  const rc = resolve(SCRATCH, 'bashrc-optin');
  await writeFile(rc, PREAMBLE, 'utf8');
  await runMigration(rc);

  // A fake `claude` on PATH prints the flags it was handed.
  const bin = resolve(SCRATCH, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(resolve(bin, 'claude'), '#!/bin/sh\necho "claude $*"\n', 'utf8');
  const { chmod } = await import('node:fs/promises');
  await chmod(resolve(bin, 'claude'), 0o755);

  const invoke = async (env) => (await execFileP('bash', ['-c', `. ${rc} >/dev/null 2>&1; claudex --print`],
    { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: SCRATCH, ...env } })).stdout.trim();

  assert.equal(await invoke({}), 'claude --print', 'prompts stay on by default');
  assert.equal(await invoke({ COCKPIT_SKIP_PERMISSIONS: '1' }), 'claude --dangerously-skip-permissions --print',
    'and the opt-in is read at call time');
});
