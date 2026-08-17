// coverage-imports.test.mjs — the dedup corpus must count @-imported doctrine as coverage.
//
// Port regression: `shells/CLAUDE.md` became a 19-line loader whose first directive is
// `@doctrine.md`, so both dedup consumers (the SUPPRESS_COS backstop, projection.mjs:501, and the
// LLM gate's STANDING POLICY, projection.mjs:331) saw ~10% of the always-loaded doctrine. These
// tests pin the one seam every coverage text goes through (projection.mjs coverageText), not the
// suppression outcome: the embedding model is disabled suite-wide (test/setup.mjs), so the
// backstop is unreachable here by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coverageText } from '../projection.mjs';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

// scratch files live under the temp memory root, which setup.mjs removes on exit.
async function scratch(files) {
  const dir = await mkdtemp(resolve(TEST_MEMORY_ROOT, 'coverage-'));
  for (const [rel, body] of Object.entries(files)) {
    const path = resolve(dir, rel);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, body, 'utf8');
  }
  return dir;
}
const load = async (dir, rel) => {
  const path = resolve(dir, rel);
  return coverageText(await readFile(path, 'utf8'), path);
};

test('an @-imported file text becomes coverage', async () => {
  const dir = await scratch({
    'CLAUDE.md': '# Loader\n\n@doctrine.md\n\n## Identity\n\n- loader-only line\n',
    'doctrine.md': '# Doctrine\n\n- ground in the decisions before building anything\n',
  });
  const text = await load(dir, 'CLAUDE.md');
  assert.match(text, /ground in the decisions before building anything/);
  assert.match(text, /loader-only line/);           // the importing file's own text survives
  assert.doesNotMatch(text, /@doctrine\.md/);       // the directive is replaced, not kept
});

test('a nested import resolves, relative to the importing file', async () => {
  const dir = await scratch({
    'CLAUDE.md': '@shells/loader.md\n',
    'shells/loader.md': 'loader level text here\n@sub/deep.md\n',
    'shells/sub/deep.md': 'deep doctrine line reached through two hops\n',
  });
  const text = await load(dir, 'CLAUDE.md');
  assert.match(text, /loader level text here/);
  assert.match(text, /deep doctrine line reached through two hops/);
});

test('a missing import neither throws nor adds coverage', async () => {
  const dir = await scratch({ 'CLAUDE.md': 'kept line of real doctrine here\n@nope.md\n' });
  const text = await load(dir, 'CLAUDE.md');
  assert.match(text, /kept line of real doctrine here/);
  assert.doesNotMatch(text, /nope/);
});

test('a circular import terminates', async () => {
  const dir = await scratch({
    'CLAUDE.md': 'root doctrine line one here\n@a.md\n',
    'a.md': 'a doctrine line one here\n@b.md\n',
    'b.md': 'b doctrine line one here\n@a.md\n@CLAUDE.md\n',
  });
  const text = await load(dir, 'CLAUDE.md');
  assert.match(text, /a doctrine line one here/);
  assert.match(text, /b doctrine line one here/);
  assert.equal(text.match(/b doctrine line one here/g).length, 1);   // no re-entry
});

// pins fail-open behavior for a non-regular target (readFile on a directory rejects EISDIR, so this
// would also pass without the isFile() guard); the FIFO test below is what proves the guard.
test('a directory import target neither throws nor adds coverage', async () => {
  const dir = await scratch({
    'CLAUDE.md': 'kept line of real doctrine here\n@adir\n',
    'adir/inside.md': 'text that must not be reachable through a directory import\n',
  });
  const text = await load(dir, 'CLAUDE.md');
  assert.match(text, /kept line of real doctrine here/);
  assert.doesNotMatch(text, /must not be reachable/);
  assert.doesNotMatch(text, /@adir/);
});

// break-it proof for the isFile() guard: reading a writer-less FIFO blocks forever, so without the
// guard this test fails on its timeout instead of returning instantly. POSIX only.
test('a FIFO import target returns promptly instead of hanging', { timeout: 3000 }, async (t) => {
  const dir = await scratch({ 'CLAUDE.md': 'kept line of real doctrine here\n@pipe.md\n' });
  const fifo = resolve(dir, 'pipe.md');
  const r = spawnSync('mkfifo', [fifo]);
  if (r.error || r.status !== 0) {
    t.skip(`mkfifo unavailable or failed (${r.error?.message || `exit ${r.status}`}): POSIX-only test`);
    return;
  }
  try {
    const text = await load(dir, 'CLAUDE.md');
    assert.match(text, /kept line of real doctrine here/);
    assert.doesNotMatch(text, /@pipe\.md/);
  } finally {
    await unlink(fifo).catch(() => {});
  }
});

test('an oversized import target neither throws nor adds coverage', async () => {
  const dir = await scratch({
    'CLAUDE.md': 'kept line of real doctrine here\n@big.md\n',
    'big.md': `oversized doctrine marker line\n${'x'.repeat(256 * 1024)}\n`,   // over IMPORT_MAX_BYTES
  });
  const text = await load(dir, 'CLAUDE.md');
  assert.match(text, /kept line of real doctrine here/);
  assert.doesNotMatch(text, /oversized doctrine marker line/);
});

test('a non-string text is coerced at the seam instead of throwing', async () => {
  const dir = await scratch({ 'CLAUDE.md': 'unused\n' });
  const path = resolve(dir, 'CLAUDE.md');
  assert.equal(await coverageText({ includes: () => true }, path), '');
  assert.equal(await coverageText(undefined, path), '');
  assert.equal(await coverageText(null, path), '');
});

test('an import-free shell is passed through byte-identically', async () => {
  const dir = await scratch({ 'CLAUDE.md': '# Inline\n\n- all doctrine inline, no imports\n' });
  const raw = await readFile(resolve(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(await load(dir, 'CLAUDE.md'), raw);
});

test('an email-like or mid-line @ is not treated as an import', async () => {
  const dir = await scratch({ 'CLAUDE.md': 'mail the owner at a@b.com when this rule bites\n' });
  const raw = await readFile(resolve(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(await load(dir, 'CLAUDE.md'), raw);
});
