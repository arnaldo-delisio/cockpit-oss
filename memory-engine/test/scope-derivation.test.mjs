// scope-derivation.test.mjs — the mint-time scope derivation (reconcile.mjs deriveScope).
//
// The bug: a node's `scope` came solely from the capture-time working directory (paths.mjs
// mappedScope stamps anything inside the repo but outside scopes/<x> as `cockpit`), so venture
// work done from the repo root was branded `cockpit` permanently. The fix lets the node's own
// content correct that stamp, through the hand-authored memory/scope-aliases.json sidecar.
//
// Driven through the REAL write seam (applyConsolidation → stageNew), as pool-invariants.mjs does
// for the pool walls: a test that called the private helper would still pass if the derivation
// were unwired from stageNew, which is exactly the regression this file exists to catch.
//
// No LLM call is reachable: stageNew is synchronous and judge-free, and the stageUpdate case below
// keeps centrality and cluster fixed, so guardDecision short-circuits before adjudicate().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, readdir } from 'node:fs/promises';
import { utimesSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, TEST_MEMORY_ROOT } from './fixtures.mjs';

const ALIAS_FILE = resolve(TEST_MEMORY_ROOT, 'scope-aliases.json');
const SCOPES_FILE = resolve(TEST_MEMORY_ROOT, 'scopes.json');
const PENDING_DIR = resolve(TEST_MEMORY_ROOT, '.reconciler', 'pending-review');
const pendingFiles = async () => (await readdir(PENDING_DIR).catch(() => [])).sort();

// Both loaders cache on their file's mtime (paths.mjs), so stamp strictly-increasing mtimes:
// two rewrites inside one millisecond would otherwise share a cache entry (att4-nightly.test.mjs:42).
let mtimeTick = Date.now() / 1000 + 10;
function touch(file) {
  mtimeTick += 2;
  utimesSync(file, mtimeTick, mtimeTick);
}
async function setScopes(names) {
  await writeFile(SCOPES_FILE, JSON.stringify(names), 'utf8');
  touch(SCOPES_FILE);
}
async function setAliases(map) {
  if (map === null) { await rm(ALIAS_FILE, { force: true }); return; }
  await writeFile(ALIAS_FILE, JSON.stringify(map), 'utf8');
  touch(ALIAS_FILE);
}

// same minimal consolidation fixtures pool-invariants.mjs uses: a distill proposal plus the
// work-unit it came from (`_wu`), which is the only place ORIGIN lives.
const wu = () => ({ isSource: false, anchor: 'sessions/2026-08-13', brain: 'claude', turnIndex: { 1: { text: 'a turn of conversation', via: 'claude:typed' } } });
const proposal = ({ title = 'Proposed Rule', products = [], tags = [], idx = 0 }) => ({
  idx, title, type: 'identity', prose: 'Proposed prose.', cluster: 'doctrine',
  centrality: 0.9, tags, entities: { products }, source_turns: ['#1'], _wu: wu(),
});
const freshAudit = () => ({ added: [], modified: [], superseded: [], held: [], autoApplied: [], unmentioned: [], reflectSkipped: [], clamped: [] });

// mint one node from one proposal under `scope`; returns the stored node and the audit.
async function mint(spec, scope = 'cockpit', dryRun = false) {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const pool = [], audit = freshAudit();
  await applyConsolidation([{ action: 'new', backing: [0], centrality: 0.9, cluster: 'doctrine' }],
    [proposal(spec)], [], scope, pool, new Set(), audit, dryRun);
  assert.equal(pool.length, 1, 'the mint should have reached the pool');
  return { node: pool[0], audit };
}

const SEED = { answerable: ['Answerable', 'Search Growth Engine', 'SGE'], 'lsu-review': ['LSU-Review', 'LSU Review'] };

test('setup: register the scopes this file derives into', async () => {
  await setScopes(['cockpit', 'answerable', 'lsu-review']);
});

// ---------------------------------------------------------------- 1. the discrimination case
// Fails before the fix (the node keeps the cwd stamp `cockpit`), passes after.
test('a product hit restamps the cwd scope and names its evidence', async () => {
  await setAliases(SEED);
  const { node, audit } = await mint({ title: 'Acceptance requires driving the real product', products: ['Answerable'] });
  assert.equal(node.frontmatter.scope, 'answerable');
  assert.equal((audit.rescoped || []).length, 1);
  assert.equal(audit.rescoped[0].from, 'cockpit');
  assert.equal(audit.rescoped[0].to, 'answerable');
  assert.match(audit.rescoped[0].evidence, /Answerable/);
  assert.match(audit.rescoped[0].evidence, /products/);
  assert.deepEqual(audit.rescopeHeld || [], []);
});

// ---------------------------------------------------------------- 2. the majority path
test('no hit at all: the cwd stamp survives untouched', async () => {
  await setAliases(SEED);
  const { node, audit } = await mint({ title: 'A generic rule about writing things down', products: [] });
  assert.equal(node.frontmatter.scope, 'cockpit');
  assert.deepEqual(audit.rescoped || [], []);
  assert.deepEqual(audit.rescopeHeld || [], []);
});

// ---------------------------------------------------------------- 3. ambiguity holds
test('two candidate scopes hold the stamp and escalate instead of guessing', async () => {
  await setAliases(SEED);
  const { node, audit } = await mint({ title: 'A cross venture note', products: ['Answerable', 'LSU Review'] });
  assert.equal(node.frontmatter.scope, 'cockpit');
  assert.deepEqual(audit.rescoped || [], []);
  assert.equal(audit.rescopeHeld.length, 1);
  assert.deepEqual(audit.rescopeHeld[0].candidates.sort(), ['answerable', 'lsu-review']);
});

// ---------------------------------------------------------------- 4. tags are weak
test('a tag hit alone never restamps: it holds and escalates', async () => {
  await setAliases(SEED);
  const { node, audit } = await mint({ title: 'A generic rule about writing things down', tags: ['answerable'] });
  assert.equal(node.frontmatter.scope, 'cockpit');
  assert.deepEqual(audit.rescoped || [], []);
  assert.equal(audit.rescopeHeld.length, 1);
  assert.deepEqual(audit.rescopeHeld[0].candidates, ['answerable']);
});

// ---------------------------------------------------------------- 5. the stamp itself matched
test('a hit on the stamped scope wins: deliberate conservative miss', async () => {
  await setAliases({ ...SEED, cockpit: ['Cockpit'] });
  const { node, audit } = await mint({ title: 'Cockpit acceptance', products: ['Answerable'] });
  assert.equal(node.frontmatter.scope, 'cockpit');
  assert.deepEqual(audit.rescoped || [], []);
  assert.deepEqual(audit.rescopeHeld || [], []);
});

// ---------------------------------------------------------------- 6. the registry gates the map
test('an alias key for an unregistered scope never restamps', async () => {
  await setAliases({ ...SEED, 'ghost-scope': ['Phantom Product'] });
  const { node, audit } = await mint({ title: 'A note', products: ['Phantom Product'] });
  assert.equal(node.frontmatter.scope, 'cockpit');
  assert.deepEqual(audit.rescoped || [], []);
  assert.deepEqual(audit.rescopeHeld || [], []);
});

// ---------------------------------------------------------------- 7. word boundaries
test('matching is whole phrase on word boundaries, never a bare substring', async () => {
  await setAliases(SEED);
  const inner = await mint({ title: 'An unanswerable question', products: [] });
  assert.equal(inner.node.frontmatter.scope, 'cockpit');
  assert.deepEqual(inner.audit.rescoped || [], []);

  // a trailing hyphen is a word character for this matcher, so a ticket id never fires the alias.
  // ('SGE-28', the spec's example, is doubly inert here: 'SGE' is below the loader's 4-character
  // floor and is dropped from the map entirely, so the boundary case is shown on a kept alias.)
  const hyphenated = await mint({ title: 'Ticket Answerable-28 needs triage', products: [] });
  assert.equal(hyphenated.node.frontmatter.scope, 'cockpit');
  assert.deepEqual(hyphenated.audit.rescoped || [], []);

  const short = await mint({ title: 'Ticket SGE-28 needs triage', products: [] });
  assert.equal(short.node.frontmatter.scope, 'cockpit');

  // …and the same alias still fires when it stands alone, so the boundary is not simply inert.
  const standalone = await mint({ title: 'Answerable is the growth lane', products: [] });
  assert.equal(standalone.node.frontmatter.scope, 'answerable');
});

// ---------------------------------------------------------------- 8. no sidecar, no behavior change
test('a missing alias file is a total no-op (fresh clone behaves as before)', async () => {
  await setAliases(null);
  for (const spec of [
    { title: 'Acceptance requires driving the real product', products: ['Answerable'] },
    { title: 'A cross venture note', products: ['Answerable', 'LSU Review'] },
    { title: 'A generic rule', tags: ['answerable'] },
  ]) {
    const { node, audit } = await mint(spec);
    assert.equal(node.frontmatter.scope, 'cockpit');
    assert.deepEqual(audit.rescoped || [], []);
    assert.deepEqual(audit.rescopeHeld || [], []);
  }
});

// ---------------------------------------------------------------- 9. deregistration invalidates the cache
// The alias cache is keyed on the alias file's mtime AND on the registered-scope set: dropping a scope
// from scopes.json must stop its aliases from restamping, even though the alias file never changed.
test('deregistering a scope drops its aliases without touching the alias file', async () => {
  await setAliases(SEED);
  // populate the cache while `answerable` is still registered (this mint restamps).
  const warm = await mint({ title: 'Answerable is the growth lane', products: ['Answerable'] });
  assert.equal(warm.node.frontmatter.scope, 'answerable');

  // deregister it; the alias file's mtime is deliberately left alone.
  await setScopes(['cockpit', 'lsu-review']);
  const { node, audit } = await mint({ title: 'Answerable is the growth lane', products: ['Answerable'] });
  assert.equal(node.frontmatter.scope, 'cockpit', 'a deregistered scope must not restamp from a cached alias map');
  assert.deepEqual(audit.rescoped || [], []);

  await setScopes(['cockpit', 'answerable', 'lsu-review']);
});

// ---------------------------------------------------------------- 10. updates never re-scope
// stageUpdate never wrote `scope` and must not start: retroactively re-scoping a stored node would
// silently re-route projections already on disk.
test('stageUpdate never rewrites the scope of an existing node', async () => {
  await setAliases({ ...SEED, cockpit: ['Cockpit'] });
  const { applyConsolidation } = await import('../reconcile.mjs');
  const existing = { ...makeNode({ id: 'upd-scope', type: 'identity', scope: 'answerable', centrality: 0.5, cluster: 'doctrine' }) };
  existing.prose = existing.body;
  const pool = [existing], audit = freshAudit();
  await applyConsolidation([{ action: 'update', id: existing.id, backing: [0], centrality: 0.55, cluster: 'doctrine' }],
    [proposal({ title: 'Cockpit acceptance', products: ['Cockpit'] })], [existing], 'answerable', pool, new Set([existing.id]), audit);
  assert.equal(existing.frontmatter.scope, 'answerable');
  assert.deepEqual(audit.rescoped || [], []);
  assert.deepEqual(audit.rescopeHeld || [], []);
});

// ---------------------------------------------------------------- 11. a dry run writes nothing
// The escalation file is a real write reached from stageNew, and consolidation runs BEFORE main()'s
// dry-run return: a preview must still record the hold in the audit, but never touch the inbox.
test('a held rescope during a dry run escalates in the audit but writes no file', async () => {
  await setAliases(SEED);
  const before = await pendingFiles();
  const { node, audit } = await mint({ title: 'A dry preview across ventures', products: ['Answerable', 'LSU Review'] }, 'cockpit', true);
  assert.equal(node.frontmatter.scope, 'cockpit');
  assert.equal(audit.rescopeHeld.length, 1, 'the preview must still report the hold');
  assert.deepEqual(audit.rescopeHeld[0].candidates.sort(), ['answerable', 'lsu-review']);
  assert.deepEqual(await pendingFiles(), before, '--dry-run must not write into pending-review');
});

// ---------------------------------------------------------------- 12. combining marks are not boundaries
// A boundary class that excludes only letters, numbers, underscore and hyphen treats a combining mark
// as a boundary, so an alias matches inside decomposed text and a unique strong hit restamps wrongly.
test('a combining mark continues the word: the alias never fires', async () => {
  await setAliases(SEED);
  const decomposed = await mint({ title: 'Answerable\u0301 is a different word', products: [] });
  assert.equal(decomposed.node.frontmatter.scope, 'cockpit');
  assert.deepEqual(decomposed.audit.rescoped || [], []);
});

// ---------------------------------------------------------------- 13. join controls are not boundaries
test('a zero-width joiner continues the word: the alias never fires', async () => {
  await setAliases(SEED);
  const joined = await mint({ title: 'foo\u200dAnswerable', products: [] });
  assert.equal(joined.node.frontmatter.scope, 'cockpit');
  assert.deepEqual(joined.audit.rescoped || [], []);
});

// ---------------------------------------------------------------- 14. the alias cache is content-keyed
// Two rewrites inside one filesystem timestamp tick share an mtime, so an mtime-keyed cache would serve
// the first parse for the rest of the process. The cache identity has to include the file's content.
test('rewriting the alias file under the same mtime is still seen', async () => {
  const { scopeAliases } = await import('../paths.mjs');
  await setAliases(SEED);
  // the loader's 4-character floor drops 'SGE', so the warm value is the FILTERED seed list.
  assert.deepEqual(scopeAliases().answerable, ['Answerable', 'Search Growth Engine'], 'warm the cache on the seed map');

  const { atimeMs, mtimeMs } = statSync(ALIAS_FILE);
  await writeFile(ALIAS_FILE, JSON.stringify({ ...SEED, answerable: ['Answerable', 'Second Growth Lane'] }), 'utf8');
  utimesSync(ALIAS_FILE, atimeMs / 1000, mtimeMs / 1000);   // same mtime, different content

  assert.deepEqual(scopeAliases().answerable, ['Answerable', 'Second Growth Lane'],
    'a same-mtime rewrite must not keep serving the previous parse');
});

// ---------------------------------------------------------------- 15. the registry cache is content-keyed too
// Test 9 deregisters through setScopes(), which ADVANCES the mtime, so it never exercises the stale path.
// A deregistration that lands inside one filesystem timestamp tick leaves scopes.json's mtime unchanged, and an
// mtime-keyed registry would serve the stale list to scopeAliases(), whose registry key would then also look
// unchanged. The alias survives, the mint restamps into a scope no longer registered, and projection drops the
// node's route: silently invisible. The registry's cache identity has to include the file's content.
test('deregistering under the same mtime still drops the scope and its aliases', async () => {
  const { registeredScopes } = await import('../paths.mjs');
  await setAliases(SEED);
  await setScopes(['cockpit', 'answerable', 'lsu-review']);
  // warm both caches while `answerable` is still registered (this mint restamps).
  const warm = await mint({ title: 'Answerable is the growth lane', products: ['Answerable'] });
  assert.equal(warm.node.frontmatter.scope, 'answerable');

  // deregister it, then put the ORIGINAL timestamps back: the rewrite is invisible to an mtime-keyed cache.
  const { atimeMs, mtimeMs } = statSync(SCOPES_FILE);
  await writeFile(SCOPES_FILE, JSON.stringify(['cockpit', 'lsu-review']), 'utf8');
  utimesSync(SCOPES_FILE, atimeMs / 1000, mtimeMs / 1000);   // same mtime, different content

  assert.deepEqual(registeredScopes(), ['cockpit', 'lsu-review'], 'a same-mtime rewrite must not keep serving the previous list');
  const { node, audit } = await mint({ title: 'Answerable is the growth lane', products: ['Answerable'] });
  assert.equal(node.frontmatter.scope, 'cockpit', 'a scope deregistered under the same mtime must not restamp');
  assert.deepEqual(audit.rescoped || [], []);

  await setScopes(['cockpit', 'answerable', 'lsu-review']);
});
