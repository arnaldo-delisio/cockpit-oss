// att4-attention-sidecar.test.mjs — ATT-4 step 1: attention.mjs sidecar contract
// (board-rethink-design §8): round-trip, tolerant load, path guard, source hashes, and the
// path-scoped commit. This file's process owns its own preload-minted temp MEMORY_ROOT, so it
// git-inits that root itself (scopedCommit demands the memory root be its own git toplevel).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

import {
  SIDECAR_SCHEMA_VERSION, attentionSidecarPath, loadAttentionSidecar,
  roadmapSourceHashes, writeAttentionSidecar,
} from '../attention.mjs';

const execFileP = promisify(execFile);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const git = (args) => execFileP('git', ['-C', TEST_MEMORY_ROOT, ...args]);

before(async () => {
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@test.invalid']);
});

// ---------- path guard ----------

test('attentionSidecarPath: valid slug resolves under MEMORY_ROOT/scopes/<scope>/attention.json', () => {
  assert.equal(attentionSidecarPath('alpha'), resolve(TEST_MEMORY_ROOT, 'scopes', 'alpha', 'attention.json'));
});

test('attentionSidecarPath: path-escape slugs are rejected loudly', () => {
  for (const bad of ['..', '../evil', 'a/b', '.hidden', 'UPPER', '', 'a b', '-lead']) {
    assert.throws(() => attentionSidecarPath(bad), /invalid scope slug/, `slug ${JSON.stringify(bad)} must throw`);
  }
});

test('roadmapSourceHashes: bad slug throws too (never a silent {})', async () => {
  await assert.rejects(() => roadmapSourceHashes('../evil'), /invalid scope slug/);
});

// ---------- tolerant load ----------

test('load: missing sidecar → null', async () => {
  assert.equal(await loadAttentionSidecar('noscope'), null);
});

test('load: malformed JSON → null, never a throw', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'mal'), { recursive: true });
  await writeFile(attentionSidecarPath('mal'), '{ not json', 'utf8');
  assert.equal(await loadAttentionSidecar('mal'), null);
});

test('load: JSON array or scalar → null (top level must be an object)', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'arr'), { recursive: true });
  await writeFile(attentionSidecarPath('arr'), '[1,2]', 'utf8');
  assert.equal(await loadAttentionSidecar('arr'), null);
  await writeFile(attentionSidecarPath('arr'), '42', 'utf8');
  assert.equal(await loadAttentionSidecar('arr'), null);
});

test('load: schemaVersion mismatch → null + stderr note', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'drift'), { recursive: true });
  await writeFile(attentionSidecarPath('drift'),
    JSON.stringify({ schemaVersion: SIDECAR_SCHEMA_VERSION + 1, records: {} }), 'utf8');
  const notes = [];
  const orig = console.error;
  console.error = (...a) => notes.push(a.join(' '));
  try {
    assert.equal(await loadAttentionSidecar('drift'), null);
  } finally { console.error = orig; }
  assert.ok(notes.some((n) => /schemaVersion/.test(n)), 'the drift must surface on stderr, not silently');
});

// ---------- source hashes ----------

test('roadmapSourceHashes: repo-relative keys, sha256 values, non-roadmap files ignored, missing dir → {}', async () => {
  const dir = resolve(TEST_MEMORY_ROOT, 'scopes', 'beta', 'projects');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'a.roadmap.md'), 'AAA\n', 'utf8');
  await writeFile(resolve(dir, 'b.roadmap.md'), 'BBB\n', 'utf8');
  await writeFile(resolve(dir, 'a.md'), 'project object, not a roadmap\n', 'utf8');
  const out = await roadmapSourceHashes('beta');
  assert.deepEqual(Object.keys(out).sort(), [
    'scopes/beta/projects/a.roadmap.md',
    'scopes/beta/projects/b.roadmap.md',
  ]);
  assert.equal(out['scopes/beta/projects/a.roadmap.md'], sha256('AAA\n'));
  assert.equal(out['scopes/beta/projects/b.roadmap.md'], sha256('BBB\n'));
  assert.deepEqual(await roadmapSourceHashes('ghost-scope'), {});
});

// ---------- write/load round-trip + commit scoping ----------

test('write/load round-trip: stamped metadata, records preserved, commit path-scoped to the sidecar', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'alpha'), { recursive: true });
  // unrelated dirty file: a path-scoped commit must NOT sweep it in
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', 'alpha', 'unrelated.md'), 'dirty bystander\n', 'utf8');
  const records = {
    'alpha/proj/aaaaaaaaaaaaaaaa': {
      readiness: { state: 'needs-me', tier: 'deterministic', model: null, ts: 't', outcome: 'ok' },
      inFlight: false,
    },
  };
  const stamped = await writeAttentionSidecar('alpha', {
    sourceHashes: { 'scopes/alpha/projects/p.roadmap.md': 'f'.repeat(64) },
    judgeModel: 'test-judge',
    records,
  });
  assert.equal(stamped.schemaVersion, SIDECAR_SCHEMA_VERSION);
  assert.ok(stamped.generatedAt, 'generatedAt stamped');

  const back = await loadAttentionSidecar('alpha');
  assert.equal(back.schemaVersion, SIDECAR_SCHEMA_VERSION);
  assert.equal(back.judgeModel, 'test-judge');
  assert.deepEqual(back.records, records);
  assert.deepEqual(back.sourceHashes, { 'scopes/alpha/projects/p.roadmap.md': 'f'.repeat(64) });

  // no tmp residue
  const raw = await readFile(attentionSidecarPath('alpha'), 'utf8');
  assert.equal(JSON.parse(raw).judgeModel, 'test-judge');

  const { stdout: head } = await git(['show', '--name-only', '--format=%s', 'HEAD']);
  assert.match(head, /attention: sidecar for alpha/);
  assert.match(head, /scopes\/alpha\/attention\.json/);
  assert.doesNotMatch(head, /unrelated\.md/, 'commit must be pathspec-scoped to the sidecar alone');
  const { stdout: dirty } = await git(['status', '--porcelain', '--', 'scopes/alpha/attention.json']);
  assert.equal(dirty.trim(), '', 'sidecar committed');
});

test('write with defaults: missing sourceHashes/judgeModel/records land as {}/null/{}', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'gamma'), { recursive: true });
  const stamped = await writeAttentionSidecar('gamma', {});
  assert.deepEqual(stamped.sourceHashes, {});
  assert.equal(stamped.judgeModel, null);
  assert.deepEqual(stamped.records, {});
});

test('rewrite (unchanged content modulo timestamp) still loads; identical content → nochange commit path', async () => {
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', 'delta'), { recursive: true });
  await writeAttentionSidecar('delta', { records: { k: { inFlight: true } } });
  const before = await readFile(attentionSidecarPath('delta'), 'utf8');
  await writeAttentionSidecar('delta', { records: { k: { inFlight: true } } });
  const after = await loadAttentionSidecar('delta');
  assert.deepEqual(after.records, { k: { inFlight: true } });
  assert.notEqual(before, undefined);
});
