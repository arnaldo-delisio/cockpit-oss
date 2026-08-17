// publish-managed-region.test.mjs — the export's managed-region guard is fail-closed.
//
// Two bugs are pinned here.
//
// 1. publish/reset-managed-region.mjs handled only the FIRST fence in a file. A file with two
//    managed regions got region one reset, and --check then saw that empty region one and exited 0
//    while region two, possibly carrying the owner's private projected rules, shipped unchanged.
//    Both modes now validate the whole file: at most one well-formed region, or a hard failure.
//
// 2. publish/publish.sh selected its targets with `find -name CLAUDE.md -o -name SOUL.md`, so every
//    exported file with one of those names was rewritten, documentation and examples included. The
//    target list now comes from the reconciler's own routing (projection.mjs repoProjectionPaths()).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoProjectionPaths } from '../projection.mjs';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const RESET = resolve(HERE, '..', '..', 'publish', 'reset-managed-region.mjs');
const FIXTURE = resolve(HERE, 'fixtures', 'docs', 'CLAUDE.md');

const EMPTY_FENCE = '<!-- managed:reconciler:begin schema=2 inputs=none -->\n'
  + '## Rules (projected from memory: do not edit; edit the source node)\n'
  + '_(no rules currently meet the always-load bar; see retrieval-gated memory)_\n'
  + '<!-- managed:reconciler:end -->\n';

const fence = (body) => '<!-- managed:reconciler:begin schema=2 inputs=abc -->\n'
  + `## Rules (projected from memory: do not edit; edit the source node)\n${body}\n`
  + '<!-- managed:reconciler:end -->\n';

async function run(mode, files) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [RESET, mode, ...files]);
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

async function scratch(t, name, text) {
  const dir = await mkdtemp(resolve(tmpdir(), 'cockpit-managed-region-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = resolve(dir, name);
  await writeFile(file, text, 'utf8');
  return file;
}

test('a second non-empty fence fails verification instead of passing on the first', async (t) => {
  const file = await scratch(t, 'CLAUDE.md',
    `# head\n\n${EMPTY_FENCE}\nsome prose\n\n${fence('- a private projected rule [[some-node]]')}\ntail\n`);

  const checked = await run('--check', [file]);
  assert.equal(checked.code, 1, `--check passed a file with a second non-empty region:\n${checked.out}`);
  assert.match(checked.out, /malformed managed region/);

  // --reset must refuse it too, rather than emptying one region and leaving the other.
  const before = await readFile(file, 'utf8');
  const resetRun = await run('--reset', [file]);
  assert.equal(resetRun.code, 1, `--reset silently accepted two regions:\n${resetRun.out}`);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('one non-empty region is still reset, and one empty region still passes --check', async (t) => {
  const file = await scratch(t, 'CLAUDE.md', `# head\n\n${fence('- a rule [[n]]')}\ntail\n`);
  assert.equal((await run('--check', [file])).code, 1);
  assert.equal((await run('--reset', [file])).code, 0);
  // FENCE_RE swallows the region's trailing newline, so the blank line that followed it survives.
  assert.equal(await readFile(file, 'utf8'), `# head\n\n${EMPTY_FENCE}\ntail\n`);
  assert.equal((await run('--check', [file])).code, 0);
});

test('an unbalanced fence is a failure, and a file with no markers is a skip', async (t) => {
  const truncated = await scratch(t, 'CLAUDE.md',
    '# head\n\n<!-- managed:reconciler:begin schema=2 inputs=abc -->\n- a rule [[n]]\n');
  assert.equal((await run('--check', [truncated])).code, 1);
  assert.equal((await run('--reset', [truncated])).code, 1);

  // shells/CLAUDE.md and shells/SOUL.md are projection targets the reconciler has not written yet.
  const plain = await scratch(t, 'SOUL.md', '# a shell with no projected region yet\n');
  assert.equal((await run('--check', [plain])).code, 0);
  assert.equal((await run('--reset', [plain])).code, 0);
});

test('the export targets the reconciler\'s own projection paths, not every CLAUDE.md', async () => {
  const paths = repoProjectionPaths();
  assert.deepEqual(paths, ['CLAUDE.md', 'shells/CLAUDE.md', 'shells/SOUL.md']);

  // The fixture is documentation that quotes the markers. It must never be a target.
  assert.ok(!paths.includes('memory-engine/test/fixtures/docs/CLAUDE.md'));
  for (const p of paths) assert.ok(!p.includes('/test/'), `a test path became a projection target: ${p}`);

  // And it must carry a non-empty region, so that a regression to basename selection would be
  // caught loudly by publish.sh check (h) rather than silently rewriting the file.
  const text = await readFile(FIXTURE, 'utf8');
  assert.match(text, /managed:reconciler:begin/);
  assert.ok(!text.includes(EMPTY_FENCE), 'the canary fixture must hold a NON-empty sample region');
});

// Data scopes route into memory/, which never ships, so they can never add a repo path. Pins the
// SYSTEM_SCOPES assumption repoProjectionPaths() is built on.
test('a data scope contributes no in-repo projection path', async () => {
  for (const p of repoProjectionPaths()) {
    assert.ok(!p.startsWith('memory/'), `a memory/ path reached the export target list: ${p}`);
    assert.ok(!p.startsWith('..'), `a projection path escaped the repo: ${p}`);
  }
});
