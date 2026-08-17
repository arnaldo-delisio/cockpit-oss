// pool-invariants.test.mjs — MEM-38 invariant matrix (build step 1).
//
// The invariant: the graph is ONE flat pool; behavioral vs library is DERIVED from `type`
// (nodes.mjs poolOf), never stored. Three walls hold it up and each has a test here:
//   1. poolOf itself, fail-closed to library (unknown/missing type never always-loads).
//   2. the READ wall — a library node can never reach projection (the mandated test), driven
//      through the real project() and the real isAlwaysLoadEligible.
//   3. the WRITE walls — the source→library clamp at mint, and the stageUpdate centrality guard.
//      Both are keyed on ORIGIN, not type, so they are separate rules from poolOf (a distiller
//      emitting `type: identity` for source material would be classified behavioral by poolOf).
//
// Everything runs against the temp pool minted by setup.mjs. No LLM call: the projection test
// pre-seeds `graduated`, so gateCandidates is empty and judge() is never reached. The embedding
// backstop IS still reached (projection.mjs:501 — a builder route's coverage always contains the
// real shells/CLAUDE.md, which no fixture can empty), so no-network comes from the setup.mjs
// offline guard, which makes embed() reject instantly; suppression is fail-open, so the demotion
// and durable assertions below are unaffected. Proven by the offline-guard test in harness.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { engine, makeNode, writePool, TEST_MEMORY_ROOT } from './fixtures.mjs';

const { poolOf } = engine;

// ---------------------------------------------------------------- 1. the derivation itself
test('poolOf derives the pool from type and fails closed to library', () => {
  const p = (fm) => poolOf({ frontmatter: fm });
  assert.equal(p({ type: 'identity' }), 'behavioral');
  assert.equal(p({ type: 'feedback' }), 'behavioral');
  assert.equal(p({ type: 'knowledge' }), 'library');
  // fail-closed: anything the engine does not recognise stays out of the always-load layer.
  assert.equal(p({ type: 'chronicle' }), 'library');   // unknown
  assert.equal(p({}), 'library');                      // missing
  assert.equal(p({ type: null }), 'library');
  assert.equal(p({ type: 'IDENTITY' }), 'library');    // case-exact, no coercion
  assert.equal(poolOf(undefined), 'library');          // no node at all
  assert.equal(poolOf({}), 'library');                 // no frontmatter
});

test('a clamped/library node round-trips through the real pool as library', async () => {
  await writePool([
    { id: 'inv-lib', type: 'knowledge', centrality: 0.95 },
    { id: 'inv-beh', type: 'identity', centrality: 0.95 },
    { id: 'inv-unknown', type: 'chronicle', centrality: 0.95 },
  ]);
  const pool = await engine.loadPool();
  const by = new Map(pool.map((n) => [n.id, n]));
  assert.equal(poolOf(by.get('inv-lib')), 'library');
  assert.equal(poolOf(by.get('inv-beh')), 'behavioral');
  assert.equal(poolOf(by.get('inv-unknown')), 'library');
});

// ---------------------------------------------------------------- 2. the read wall
test('isAlwaysLoadEligible admits only behavioral nodes at/above the floor', async () => {
  const { isAlwaysLoadEligible } = await import('../reconcile.mjs');
  assert.equal(isAlwaysLoadEligible(makeNode({ id: 'a', type: 'identity', centrality: 0.7 })), true);
  assert.equal(isAlwaysLoadEligible(makeNode({ id: 'b', type: 'identity', centrality: 0.3 })), false);
  assert.equal(isAlwaysLoadEligible(makeNode({ id: 'c', type: 'identity', centrality: 0.3 }), 0.7), true);
  // a library node is never eligible, however central — the MEM-38 wall, not a centrality question.
  assert.equal(isAlwaysLoadEligible(makeNode({ id: 'd', type: 'knowledge', centrality: 1 })), false);
  assert.equal(isAlwaysLoadEligible(makeNode({ id: 'e', type: 'chronicle', centrality: 1 })), false);
});

// The mandated test: a library node can never reach projection. Driven through the real project()
// — a library node cannot become a candidate, so a durable rule sourced from one is DEMOTED out of
// the always-load fence on the next run, while its behavioral twin survives.
test('project(): a library node never reaches the always-load fence; a behavioral one does', async () => {
  const scope = 'testscope';
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify([scope]), 'utf8');
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope), { recursive: true });   // route target's dir must exist (insideRoot realpaths it)
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  await writeFile(resolve(TEST_MEMORY_ROOT, '.reconciler', 'projection-state.json'), JSON.stringify({
    [scope]: {
      streaks: { 'proj-lib': 3, 'proj-beh': 3 },
      graduated: {
        'proj-lib': { rule: 'library rule that must not always-load', source: 'proj-lib' },
        'proj-beh': { rule: 'behavioral rule that may always-load', source: 'proj-beh' },
      },
      emerging: [], gateSig: '',
    },
  }), 'utf8');

  const pool = [
    makeNode({ id: 'proj-lib', type: 'knowledge', claim: 'fact', citation: 'x.md', scope, centrality: 0.95 }),
    makeNode({ id: 'proj-beh', type: 'identity', claim: 'principle', scope, centrality: 0.95 }),
  ].map((n) => ({ ...n, prose: n.body }));

  const { project } = await import('../projection.mjs');
  const audit = await project(pool, { dryRun: true });   // dry-run: no writes, no drift insights
  const route = audit.find((a) => a.key === scope);
  assert.ok(route, 'the route should be considered (it has projection state)');
  assert.deepEqual(route.demoted, ['proj-lib']);
  assert.deepEqual(route.durable.map((r) => r.source), ['proj-beh']);
  assert.equal(route.gated, false, 'no LLM gate call: every candidate is already graduated');
  // structural proof the run stayed offline: the embedding backstop is entered but its embed()
  // rejects under the setup.mjs guard, so it can never have suppressed anything (fail-open).
  // NOT coverage of the suppression backstop: this asserts the guard held, nothing more. The
  // backstop itself is untested and stays that way until it gets an injectable embedder
  // (Codex round 3, 2026-07-25 — recorded as a known gap, not silently accepted).
  assert.deepEqual(route.suppressed, []);
});

// ---------------------------------------------------------------- 3. the write walls
// Driven through the REAL write path (applyConsolidation → stageNew/stageUpdate), not the private
// clamp helpers: a test that re-calls the clamp would still pass if the `sourceBacked` plumbing
// (reconcile.mjs:566) were removed, which is exactly the regression these walls exist to catch.
//
// No LLM call is reachable from these fixtures: stageNew is synchronous and judge-free, and the
// stageUpdate path only adjudicates when instabilityReasons() is non-empty (reconcile.mjs:518) —
// the centrality moves below stay inside GUARD_CENTRALITY_DELTA (0.25) and keep the cluster fixed,
// so guardDecision short-circuits to 'apply' before ever reaching adjudicate().

// minimal consolidation fixtures: a distill proposal + the work-unit it came from (`_wu`), which is
// the only place ORIGIN lives (reconcile.mjs:427/437/572). idx is 0-BASED, exactly as the distill loop
// mints it (`idx: proposals.length`, reconcile.mjs:963) — index 0 is the ordinary first candidate and
// must resolve like any other (Codex review 2026-07-25).
const wu = (isSource, brain = 'claude') => ({ isSource, anchor: isSource ? 'sources/paper.md' : 'sessions/2026-07-25', brain, turnIndex: { 1: { text: 'a turn of conversation', via: 'claude:typed' } } });
const proposal = ({ isSource, type = 'identity', centrality = 0.9, idx = 0, brain, title = 'Proposed Rule' }) => ({
  idx, title, type, prose: 'Proposed prose.', cluster: 'doctrine',
  centrality, tags: [], entities: {}, source_turns: ['#1'], _wu: wu(isSource, brain),
});
const freshAudit = () => ({ added: [], modified: [], superseded: [], held: [], autoApplied: [], unmentioned: [], reflectSkipped: [], clamped: [] });

test('mint (real path): a source-derived proposal lands library; a conversation one keeps its type', async () => {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const mint = async (isSource) => {
    const pool = [], audit = freshAudit();
    const props = [proposal({ isSource })];   // idx 0 — the first candidate, the common case
    await applyConsolidation([{ action: 'new', backing: [0], centrality: 0.9, cluster: 'doctrine' }],
      props, [], 'cockpit', pool, new Set(), audit);
    assert.equal(pool.length, 1, 'the mint should have reached the pool');
    return { node: pool[0], audit };
  };

  const src = await mint(true);
  assert.equal(src.node.frontmatter.type, 'knowledge');   // proposed identity, clamped
  assert.equal(poolOf(src.node), 'library');
  assert.deepEqual(src.audit.clamped.map((c) => [c.kind, c.id, c.from, c.to]), [['type', src.node.id, 'identity', 'knowledge']]);

  const conv = await mint(false);
  assert.equal(conv.node.frontmatter.type, 'identity');   // same proposal, conversation origin — survives
  assert.equal(poolOf(conv.node), 'behavioral');
  assert.deepEqual(conv.audit.clamped, []);
});

// Regression (Codex review 2026-07-25): backing index 0 used to be dropped by arr()'s Boolean filter,
// which emptied the backing of the first candidate — so the clamp never fired AND citation/claim/audience
// derivation (reconcile.mjs:425/437) silently fell back to null/inference/builder. Both legs asserted here.
test('mint (real path): backing index 0 resolves — clamp, citation, claim and audience all derive from it', async () => {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const mintWith = async (props, backing) => {
    const pool = [], audit = freshAudit();
    await applyConsolidation([{ action: 'new', backing, centrality: 0.9, cluster: 'doctrine' }],
      props, [], 'cockpit', pool, new Set(), audit);
    assert.equal(pool.length, 1, 'index 0 must resolve to a backing candidate (empty backing skips the mint)');
    return { fm: pool[0].frontmatter, audit };
  };

  // sole backing = index 0, a Hermes-brain source work-unit: every derivation below reads that one proposal.
  const only = await mintWith([proposal({ isSource: true, brain: 'hermes' })], [0]);
  assert.equal(only.fm.type, 'knowledge');                      // the clamp fired
  assert.equal(poolOf({ frontmatter: only.fm }), 'library');
  assert.equal(only.fm.citation, 'src:sources/paper.md');       // deriveCitation saw the backing
  assert.equal(only.fm.claim, 'reported');                      // …and not the empty-backing 'inference'
  assert.equal(only.fm.audience, 'operator');                   // …and not the empty-backing 'builder' default
  assert.deepEqual(only.audit.clamped.map((c) => [c.kind, c.from, c.to]), [['type', 'identity', 'knowledge']]);

  // mixed [0, 1]: index 0 is the source one. Dropping it would leave a pure-conversation backing that
  // mints behavioral — so this discriminates the fix from the bug even with a second index present.
  const mixed = await mintWith(
    [proposal({ isSource: true, idx: 0 }), proposal({ isSource: false, idx: 1, title: 'Second Rule' })], [0, 1]);
  assert.equal(mixed.fm.type, 'knowledge');
  assert.deepEqual(mixed.audit.clamped.map((c) => [c.kind, c.from, c.to]), [['type', 'identity', 'knowledge']]);
});

test('update (real path): source backing cannot push a behavioral node across the always-load floor', async () => {
  const { applyConsolidation } = await import('../reconcile.mjs');
  // 0.50 → 0.70 crosses ALWAYS_LOAD_FLOOR (0.60) but stays inside GUARD_CENTRALITY_DELTA, so no adjudication.
  const raise = async (isSource) => {
    const existing = { ...makeNode({ id: 'upd-beh', type: 'identity', centrality: 0.50, cluster: 'doctrine' }) };
    existing.prose = existing.body;
    const pool = [existing], audit = freshAudit();
    await applyConsolidation([{ action: 'update', id: existing.id, backing: [0], centrality: 0.70, cluster: 'doctrine' }],
      [proposal({ isSource })], [existing], 'cockpit', pool, new Set([existing.id]), audit);
    return { existing, audit };
  };

  const src = await raise(true);
  assert.equal(src.existing.frontmatter.centrality, 0.50, 'source backing may not cross the floor');
  assert.deepEqual(src.audit.clamped.map((c) => [c.kind, c.id, c.from, c.to]), [['centrality', 'upd-beh', 0.70, 0.50]]);

  const conv = await raise(false);
  assert.equal(conv.existing.frontmatter.centrality, 0.70, 'conversation backing may raise it');
  assert.deepEqual(conv.audit.clamped, []);
  assert.deepEqual(conv.audit.held, [], 'no escalation — and therefore no adjudicator call');
});
