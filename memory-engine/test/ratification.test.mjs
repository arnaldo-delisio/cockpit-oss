// ratification.test.mjs, MEM-38 step 5: the ratification lifecycle (ratify.mjs write path plus
// the projection.mjs ratified lane, two-lane demotion, suppression backstop, negotiable cap,
// proposed-rule cards, atomic state save, hostile keys).
//
// AUTHORED AS THE INDEPENDENT TEST PASS: the implementation came from a different pass; every
// test here was verified to FAIL against a deliberately broken copy of the production behavior it
// targets and to pass against the shipped code (discrimination results in the pass report, not in
// this file).
//
// OFFLINE POSTURE, per site:
//   • judge()/composeFields(): every non-dry-run project() drive goes through test/step5-driver.mjs,
//     a child process launched with PATH=/usr/bin:/bin (no `claude` binary) and HOME inside the
//     temp root, so judge's spawn fails FAST with ENOENT. composeFields treats that as {} by
//     contract (fail-soft mint); the LLM gate treats it as a route error and skips the route,
//     which the affected scenarios either avoid (empty gateCandidates) or sidestep by seeding the
//     PERSISTED gateSig with the same value project() computes (replicated in gateSigFor below),
//     which takes the judge-free reuse path.
//   • embed(): the setup preload makes it reject (fail-open, suppression skipped), which is what
//     the in-process scenarios rely on. The suppression-backstop scenarios NEED working cosines,
//     so they run the driver with a loader hook (step5-embed-register.mjs) that swaps embed() for
//     a deterministic one-hot version: identical texts cos 1.0, different texts cos 0.0. The
//     setup guard itself is untouched.
//   • In-process drives are dry-run only: dryRun skips every judge()-reaching mint/drift path.
//
// gateSigFor is a REPLICA of projection.mjs's gateSig computation (candidates x contentHash x
// centrality, sha8 of the assembled skeleton, the sticky emerging set). It is a deliberate
// coupling: if the production formula changes, the two reuse-path scenarios (streak cap door,
// proposed-rule cards) fail loudly with a route error instead of silently testing nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_MEMORY_ROOT, writePool, makeNode } from './fixtures.mjs';
import { loadPool, parseNode, NODES_DIR, writeNode } from '../nodes.mjs';
import { contentHash } from '../retrieval.mjs';
import { project, coverageText, printProjection } from '../projection.mjs';
import { ratifyNode, RATIFY_VIAS } from '../ratify.mjs';
import { REPO_ROOT } from '../paths.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const STATE_FILE = resolve(TEST_MEMORY_ROOT, '.reconciler', 'projection-state.json');
const INSIGHTS_DIR = resolve(TEST_MEMORY_ROOT, 'insights');
const GLOBAL_SKELETON = resolve(REPO_ROOT, 'shells', 'CLAUDE.md');
const DRIVER_HOME = resolve(TEST_MEMORY_ROOT, 'driver-home');

const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const today = () => new Date().toISOString().slice(0, 10);
const RAT = { at: '2026-07-25T00:00:00.000Z', via: 'in-session', turn: 'sess-1:4' };

async function setScopes(scopes) {
  await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes.json'), JSON.stringify(scopes), 'utf8');
  // the scope workspace dir must exist: on an isolated root the MEM-32 containment check
  // realpaths the target's parent and fail-closes (drops the route) when it is missing.
  for (const s of scopes) await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', s), { recursive: true });
}
async function writeState(state) {
  await mkdir(resolve(TEST_MEMORY_ROOT, '.reconciler'), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
const readState = async () => JSON.parse(await readFile(STATE_FILE, 'utf8'));
const gradEntry = (id, rule, prose) => ({ rule, source: id, sourceHash: contentHash(prose) });

async function insightFiles(prefix) {
  const files = await readdir(INSIGHTS_DIR).catch(() => []);
  return files.filter((f) => f.startsWith(prefix)).sort();
}

// replica of projection.mjs's gate signature for a data-scope builder route with the global shell
// as the only ancestor (see file header for why this coupling is deliberate).
async function gateSigFor(scope, { gateCandidates = [], graduatedRules = [], emerging = [] } = {}) {
  const FENCE_RE = /[ \t]*<!-- managed:reconciler:begin\b[^>]*-->[\s\S]*?<!-- managed:reconciler:end -->\n?/;
  const file = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');
  const shell = await readFile(GLOBAL_SKELETON, 'utf8').catch(() => '');
  const ancestor = await coverageText(shell, GLOBAL_SKELETON);
  const existing = await readFile(file, 'utf8').catch(() => '');
  const ownSkeleton = await coverageText(existing.replace(FENCE_RE, '').trim(), file);
  const durableText = graduatedRules.map((r) => `- ${r.rule}`).join('\n');
  const skeleton = [...(ancestor.trim() ? [ancestor] : []), ownSkeleton, durableText]
    .filter(Boolean).join('\n\n');
  return sha8(JSON.stringify([
    gateCandidates.map((n) => [n.id, contentHash(n.prose ?? n.body), n.frontmatter.centrality]),
    sha8(skeleton),
    emerging.map((r) => [r.rule, r.source]),
  ]));
}

// non-dry-run drives go through the child driver (see file header). `mock` adds the one-hot embed
// loader. Serial by construction: awaited one at a time, never fanned out.
async function runDriver({ dryRun = false, mock = false } = {}) {
  await mkdir(DRIVER_HOME, { recursive: true });
  const args = [];
  if (mock) args.push('--import', resolve(ENGINE_DIR, 'test', 'step5-embed-register.mjs'));
  args.push(resolve(ENGINE_DIR, 'test', 'step5-driver.mjs'), JSON.stringify({ dryRun }));
  const { stdout, stderr } = await execFileP(process.execPath, args, {
    cwd: ENGINE_DIR,
    env: { COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT, HOME: DRIVER_HOME, PATH: '/usr/bin:/bin' },
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('___AUDIT___'));
  assert.ok(line, `driver printed no audit; stdout: ${stdout}\nstderr: ${stderr}`);
  return { ...JSON.parse(line.slice('___AUDIT___'.length)), stderr };
}

const routeOf = (audit, key) => audit.find((a) => a.key === key);

// ================================================================ 1. ratifyNode (ratify.mjs)

test('ratifyNode writes the ratified block and stamps updated', async () => {
  await writePool([makeNode({ id: 'rat-basic', type: 'identity', scope: 'cockpit', centrality: 0.4 })]);
  const { node, changed } = await ratifyNode('rat-basic', { via: 'dashboard', turn: 'sess-9:2' });
  assert.equal(changed, true);
  const round = parseNode(await readFile(resolve(NODES_DIR, 'rat-basic.md'), 'utf8'), 'rat-basic').frontmatter;
  assert.equal(round.ratified.via, 'dashboard');
  assert.equal(round.ratified.turn, 'sess-9:2');
  assert.ok(round.ratified.at, 'the ratification timestamp must be recorded');
  assert.equal(round.updated, round.ratified.at, 'updated must move with the ratification');
  assert.ok(!hasOwn(round.ratified, 'overrode'), 'no override trail when claim was not reported');
  assert.equal(node.frontmatter.ratified.via, 'dashboard');
});

test('ratifyNode is idempotent: the second call writes nothing and keeps the first stamp', async () => {
  await writePool([makeNode({ id: 'rat-idem', type: 'identity', scope: 'cockpit' })]);
  await ratifyNode('rat-idem', { via: 'in-session', turn: 'a:1' });
  const before = await readFile(resolve(NODES_DIR, 'rat-idem.md'), 'utf8');
  const second = await ratifyNode('rat-idem', { via: 'dashboard', turn: 'b:2' });
  assert.equal(second.changed, false);
  const after = await readFile(resolve(NODES_DIR, 'rat-idem.md'), 'utf8');
  assert.equal(after, before, 'the file must be byte-identical after the second call');
  assert.equal(second.node.frontmatter.ratified.via, 'in-session', 'the FIRST human yes stands');
});

test('ratifyNode refuses a superseded node', async () => {
  await writePool([makeNode({ id: 'rat-corpse', type: 'identity', scope: 'cockpit', superseded: true })]);
  await assert.rejects(() => ratifyNode('rat-corpse', { via: 'in-session', turn: 'a:1' }), /superseded/);
  const round = parseNode(await readFile(resolve(NODES_DIR, 'rat-corpse.md'), 'utf8'), 'rat-corpse').frontmatter;
  assert.ok(!hasOwn(round, 'ratified'), 'the refusal must leave the node unwritten');
});

test('ratifyNode rejects bad ids, bad --via and bad --turn before touching anything', async () => {
  // ids: the id doubles as a filename, so path escapes and off-slug names are rejected up front.
  for (const id of ['../evil', 'Upper', '', 'a b', '__proto__', 42, null, 'a/b']) {
    await assert.rejects(() => ratifyNode(id, { via: 'in-session', turn: 'a:1' }), /invalid node id/,
      `id ${JSON.stringify(id)} must be rejected`);
  }
  await assert.rejects(() => ratifyNode('no-such-node-xyz', { via: 'in-session', turn: 'a:1' }), /node not found/);
  await writePool([makeNode({ id: 'rat-args', type: 'identity', scope: 'cockpit' })]);
  const before = await readFile(resolve(NODES_DIR, 'rat-args.md'), 'utf8');
  for (const via of [undefined, 'email', 'IN-SESSION', 'toString']) {
    await assert.rejects(() => ratifyNode('rat-args', { via, turn: 'a:1' }), /--via must be one of/);
  }
  assert.deepEqual(RATIFY_VIAS, ['in-session', 'dashboard']);
  for (const turn of [undefined, 'noseparator', 7]) {
    await assert.rejects(() => ratifyNode('rat-args', { via: 'dashboard', turn }), /--turn must be/);
  }
  assert.equal(await readFile(resolve(NODES_DIR, 'rat-args.md'), 'utf8'), before,
    'every rejection must leave the node file untouched');
});

test('ratifyNode on claim:reported MOVES the citation into ratified.overrode and deletes frontmatter.citation', async () => {
  await writePool([makeNode({
    id: 'rat-reported', type: 'identity', scope: 'cockpit', claim: 'reported',
    citation: 'src: sessions/2026-07-20#12',
  })]);
  await ratifyNode('rat-reported', { via: 'dashboard', turn: 'sess-2:9' });
  const round = parseNode(await readFile(resolve(NODES_DIR, 'rat-reported.md'), 'utf8'), 'rat-reported').frontmatter;
  assert.equal(round.claim, 'fact', 'the human yes overrides the reported tier');
  assert.deepEqual(round.ratified.overrode, { claim: 'reported', citation: 'src: sessions/2026-07-20#12' },
    'provenance is superseded with a trail, never erased');
  // own-property absence, not a falsy read-back: the citation must be GONE from the frontmatter.
  assert.ok(!hasOwn(round, 'citation'), 'frontmatter.citation must be deleted, not merely emptied');
  // the reconcile reclassifier (claim fact + src: citation -> reported) must no longer match this
  // node, or the nightly would silently undo the override. The condition is replicated verbatim
  // from reconcile.mjs and its continued presence there is asserted below (wall coupling).
  const reclassifierMatches = !round.superseded && round.claim === 'fact'
    && String(round.citation || '').startsWith('src:');
  assert.equal(reclassifierMatches, false, 'the reclassifier condition must not match a ratified override');
  const reconcileSrc = await readFile(resolve(ENGINE_DIR, 'reconcile.mjs'), 'utf8');
  assert.match(reconcileSrc,
    /claim === 'fact' && String\(n\.frontmatter\.citation \|\| ''\)\.startsWith\('src:'\)/,
    'the reclassifier this test replicates still exists in reconcile.mjs; if it moved, re-point this test');
});

test('ratifyNode on claim:reported without a citation records the override with no citation key', async () => {
  await writePool([makeNode({ id: 'rat-rep-nocite', type: 'identity', scope: 'cockpit', claim: 'reported' })]);
  await ratifyNode('rat-rep-nocite', { via: 'in-session', turn: 's:1' });
  const round = parseNode(await readFile(resolve(NODES_DIR, 'rat-rep-nocite.md'), 'utf8'), 'rat-rep-nocite').frontmatter;
  assert.equal(round.claim, 'fact');
  assert.deepEqual(round.ratified.overrode, { claim: 'reported' });
  assert.ok(!hasOwn(round.ratified.overrode, 'citation'));
});

// ================================================================ 2. projection: ratified injection

test('project(): a ratified node below the floor or claim:reported lands durable, no streak, ratified-first fence', async () => {
  const scope = 's5a';
  await setScopes([scope]);
  await writePool([
    makeNode({ id: 's5a-rat-low', title: 'Low centrality but human ratified rule here', type: 'identity', scope, centrality: 0.2, ratified: RAT }),
    // the pre-override edge: ratified crafted directly with claim untouched. MEM-37 filters it out
    // of candidates, so only the ratified lane can carry it in.
    makeNode({ id: 's5a-rat-rep', title: 'Reported claim yet ratified by a human', type: 'identity', scope, centrality: 0.9, claim: 'reported', citation: 'src: x#1', ratified: RAT }),
    makeNode({ id: 's5a-grad', type: 'identity', scope, centrality: 0.95 }),
  ]);
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: { 's5a-grad': gradEntry('s5a-grad', 'previously graduated unratified rule text', 'Fixture prose for s5a-grad.') },
  } });
  const audit = await project(await loadPool(), { dryRun: true });
  const r = routeOf(audit, scope);
  assert.ok(r, 'the route must be considered');
  assert.ok(!r.error, `route errored: ${r.error}`);
  assert.deepEqual([...r.ratified].sort(), ['s5a-rat-low', 's5a-rat-rep'],
    'BOTH ratified nodes graduate this very run, no streak accumulation');
  // ratified-first ordering, centrality within the lane, unratified last despite top centrality.
  assert.deepEqual(r.durable.map((d) => d.source), ['s5a-rat-rep', 's5a-rat-low', 's5a-grad']);
  assert.deepEqual(r.durable.map((d) => !!d.ratified), [true, true, false]);
  // the fence must mark the lane split and stop claiming every rule survived 3 reconciles.
  assert.match(r.preview, /### Durable \(held until superseded; "\(ratified\)" = human-ratified/,
    'with a ratified member the header must state the two lanes');
  assert.doesNotMatch(r.preview, /### Durable \(auto-graduated: survived/);
  const lines = r.preview.split('\n');
  const at = (id) => lines.findIndex((l) => l.includes(`[[${id}]]`));
  assert.ok(at('s5a-rat-rep') < at('s5a-rat-low') && at('s5a-rat-low') < at('s5a-grad'),
    'ratified rules must render before unratified in the fence');
  assert.match(lines[at('s5a-rat-low')], / \(ratified\)$/);
  assert.doesNotMatch(lines[at('s5a-grad')], /\(ratified\)/);
});

test('project(): the CAP slice is ratified-first and dropped identifies rules, not a count', async () => {
  const scope = 's5b';
  await setScopes([scope]);
  await writePool([
    makeNode({ id: 's5b-u1', type: 'identity', scope, centrality: 0.9 }),
    makeNode({ id: 's5b-u2', type: 'identity', scope, centrality: 0.8 }),
    makeNode({ id: 's5b-rat', type: 'identity', scope, centrality: 0.1, ratified: RAT }),
  ]);
  // a legacy over-cap durable set (3 rules, cap 2): only the render slice can resolve it, and the
  // ratified rule, lowest centrality of the three, must never be the one sliced.
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '', cap: 2,
    graduated: {
      's5b-u1': gradEntry('s5b-u1', 'unratified rule one with the top centrality', 'Fixture prose for s5b-u1.'),
      's5b-u2': gradEntry('s5b-u2', 'unratified rule two with lower centrality', 'Fixture prose for s5b-u2.'),
      's5b-rat': gradEntry('s5b-rat', 'ratified rule with the lowest centrality', 'Fixture prose for s5b-rat.'),
    },
  } });
  const audit = await project(await loadPool(), { dryRun: true });
  const r = routeOf(audit, scope);
  assert.ok(r && !r.error, `route missing or errored: ${r && r.error}`);
  assert.deepEqual(r.durable.map((d) => d.source), ['s5b-rat', 's5b-u1'],
    'the slice keeps the ratified rule and the strongest unratified one');
  assert.equal(r.durable[0].ratified, true);
  // dropped: named rules ({rule, source}), never a bare number.
  assert.ok(Array.isArray(r.dropped), 'dropped must be an array of rules, not a count');
  assert.deepEqual(r.dropped, [{ rule: 'unratified rule two with lower centrality', source: 's5b-u2' }]);
});

// ================================================================ 3. two-lane demotion

test('project(): unratified demotes on candidate loss; ratified survives the floor and demotes only when superseded', async () => {
  const scope = 's5c';
  await setScopes([scope]);
  await writePool([
    makeNode({ id: 's5c-u', type: 'identity', scope, centrality: 0.3 }),   // dropped below the floor
    makeNode({ id: 's5c-r', type: 'identity', scope, centrality: 0.2, ratified: RAT }),
  ]);
  const seed = () => writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: {
      's5c-u': gradEntry('s5c-u', 'unratified rule whose node sank below the floor', 'Fixture prose for s5c-u.'),
      's5c-r': gradEntry('s5c-r', 'ratified rule whose node sits below the floor', 'Fixture prose for s5c-r.'),
    },
  } });
  await seed();
  let audit = await project(await loadPool(), { dryRun: true });
  let r = routeOf(audit, scope);
  assert.deepEqual(r.demoted, ['s5c-u'], 'the unratified rule demotes exactly as before');
  assert.deepEqual(r.durable.map((d) => d.source), ['s5c-r'], 'the ratified rule survives the floor');
  // now supersede the ratified source: that, and only that, is the ratified lane demotion gate.
  const rNode = parseNode(await readFile(resolve(NODES_DIR, 's5c-r.md'), 'utf8'), 's5c-r');
  rNode.frontmatter.superseded = true;
  await writeNode(rNode);
  await seed();
  audit = await project(await loadPool(), { dryRun: true });
  r = routeOf(audit, scope);
  assert.ok(r.demoted.includes('s5c-r'), 'a superseded ratified source demotes its rule');
});

// ================================================================ 4. suppression backstop
// Runs through the driver with the one-hot embed mock (identical text cos 1.0, else 0.0); the
// covering line lives in the route's own hand skeleton. The route's LLM gate errors offline
// (spawn ENOENT) AFTER the suppression block, so cards and state still land and persist.

test('project(): over-threshold coverage deletes an unratified durable rule but only cards a ratified one, deduped, cleared and re-minted', async () => {
  const scope = 's5j';
  const COVER = 'always restate the covered doctrine sentence exactly here';
  const skelFile = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');
  await setScopes([scope]);
  await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope), { recursive: true });
  await writeFile(skelFile, `# ${scope} skeleton\n\n${COVER}\n`, 'utf8');
  await writePool([
    makeNode({ id: 's5j-u', type: 'identity', scope, centrality: 0.9 }),
    makeNode({ id: 's5j-r', type: 'identity', scope, centrality: 0.2, ratified: RAT }),
  ]);
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: {
      's5j-u': gradEntry('s5j-u', COVER, 'Fixture prose for s5j-u.'),
      's5j-r': gradEntry('s5j-r', COVER, 'Fixture prose for s5j-r.'),
    },
  } });

  // run 1: the unratified rule is auto-deleted with a suppressed_by trail; the ratified rule stays
  // durable and mints exactly one retirement card.
  await runDriver({ mock: true });
  let st = await readState();
  assert.deepEqual(Object.keys(st[scope].graduated), ['s5j-r'],
    'the unratified durable rule is auto-deleted; the ratified one is never');
  const uNode = parseNode(await readFile(resolve(NODES_DIR, 's5j-u.md'), 'utf8'), 's5j-u').frontmatter;
  assert.ok(Array.isArray(uNode.suppressed_by) && uNode.suppressed_by.length === 1,
    'the suppressed unratified rule records its trail on the source node');
  let cards = await insightFiles(`${today()}-ratified-rule-retirement-s5j-r`);
  assert.equal(cards.length, 1, 'exactly one ratified-rule-retirement card');
  const card = parseNode(await readFile(resolve(INSIGHTS_DIR, cards[0]), 'utf8')).frontmatter;
  assert.equal(card.detector, 'ratified-rule-retirement');
  assert.match(card.claim, /\[\[s5j-r\]\]/);
  assert.match(card.suggested_fix, /never remove a ratified rule on its own/);
  assert.ok(hasOwn(st[scope].retireProposed, 's5j-r'), 'the dedupe record is persisted');

  // run 2: still over the threshold, record present: no re-mint.
  await runDriver({ mock: true });
  assert.equal((await insightFiles(`${today()}-ratified-rule-retirement-s5j-r`)).length, 1,
    'the card must not re-mint while the record stands');

  // run 3: coverage removed: the rule falls under the threshold and the record clears.
  await writeFile(skelFile, `# ${scope} skeleton\n\nnothing covering anything at all anymore\n`, 'utf8');
  await runDriver({ mock: true });
  st = await readState();
  assert.ok(!hasOwn(st[scope].retireProposed, 's5j-r'), 'falling under the threshold clears the record');
  assert.deepEqual(Object.keys(st[scope].graduated), ['s5j-r'], 'the ratified rule is still durable');

  // run 4: coverage returns: a fresh card mints.
  await writeFile(skelFile, `# ${scope} skeleton\n\n${COVER}\n`, 'utf8');
  await runDriver({ mock: true });
  assert.equal((await insightFiles(`${today()}-ratified-rule-retirement-s5j-r`)).length, 2,
    'a re-cover after a clear re-mints the card');
});

// ================================================================ 5. the cap

test('project(): the cap reads persisted sc.cap and blocks a ratification at a full block instead of slicing', async () => {
  const scope = 's5e';
  await setScopes([scope]);
  await writePool([
    makeNode({ id: 's5e-g1', type: 'identity', scope, centrality: 0.9 }),
    makeNode({ id: 's5e-g2', type: 'identity', scope, centrality: 0.8 }),
    makeNode({ id: 's5e-rz', type: 'identity', scope, centrality: 0.3, ratified: RAT }),
  ]);
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '', cap: 2,
    graduated: {
      's5e-g1': gradEntry('s5e-g1', 'first unratified durable rule text here', 'Fixture prose for s5e-g1.'),
      's5e-g2': gradEntry('s5e-g2', 'second unratified durable rule text here', 'Fixture prose for s5e-g2.'),
    },
  } });
  const audit = await project(await loadPool(), { dryRun: true });
  const r = routeOf(audit, scope);
  assert.deepEqual(r.ratified, [], 'nothing graduates through a full block');
  assert.equal(r.capBlocked.length, 1);
  assert.equal(r.capBlocked[0].source, 's5e-rz');
  assert.equal(r.capBlocked[0].door, 'ratified');
  assert.deepEqual(r.durable.map((d) => d.source).sort(), ['s5e-g1', 's5e-g2'],
    'the existing durable set is untouched: blocked, never sliced');
  assert.deepEqual(r.dropped, [], 'nothing is silently dropped');
});

test('project(): malformed sc.cap values fall back to the default of 12, never to unlimited', async () => {
  // two scopes so every durable candidate is pre-graduated and the LLM gate never has candidates
  // (a non-empty gate would spawn the real judge in-process): a SMALL one (3 durable rules) where
  // a malformed cap must NOT block (proof it is not honored, e.g. '7' or 0), and a FULL one (12
  // durable rules) where the same malformed cap must still block (proof the fallback is 12, not
  // unlimited).
  const graduatedOf = (ids) => Object.fromEntries(ids.map((id) =>
    [id, gradEntry(id, `durable rule for ${id} with enough words`, `Fixture prose for ${id}.`)]));
  // 8 durable rules in the small scope, deliberately MORE than every malformed value below ('7',
  // 2.5, [4]...): a regression that honors a malformed cap (e.g. `sc.cap || DEFAULT_CAP`) would
  // block here, so "not blocked" discriminates fallback from accidental honoring.
  const small = Array.from({ length: 8 }, (_, i) => `s5fs-g${i}`);
  const twelve = Array.from({ length: 12 }, (_, i) => `s5fb-g${String(i).padStart(2, '0')}`);
  await setScopes(['s5fs', 's5fb']);
  await writePool([
    ...small.map((id) => makeNode({ id, type: 'identity', scope: 's5fs', centrality: 0.9 })),
    makeNode({ id: 's5fs-rz', type: 'identity', scope: 's5fs', centrality: 0.3, ratified: RAT }),
    ...twelve.map((id) => makeNode({ id, type: 'identity', scope: 's5fb', centrality: 0.9 })),
    makeNode({ id: 's5fb-rz', type: 'identity', scope: 's5fb', centrality: 0.3, ratified: RAT }),
  ]);
  for (const cap of ['7', 0, -1, 2.5, true, [4], 'nonsense', undefined]) {
    const capField = cap === undefined ? {} : { cap };
    await writeState({
      s5fs: { streaks: {}, emerging: [], gateSig: '', ...capField, graduated: graduatedOf(small) },
      s5fb: { streaks: {}, emerging: [], gateSig: '', ...capField, graduated: graduatedOf(twelve) },
    });
    const audit = await project(await loadPool(), { dryRun: true });
    const rs = routeOf(audit, 's5fs');
    assert.deepEqual(rs.ratified, ['s5fs-rz'], `cap=${JSON.stringify(cap)} must fall back to the default, not be honored`);
    assert.deepEqual(rs.capBlocked, []);
    const rb = routeOf(audit, 's5fb');
    assert.deepEqual(rb.ratified, [], `cap=${JSON.stringify(cap)} must enforce the default of 12, never unlimited`);
    assert.equal(rb.capBlocked.length, 1);
    assert.equal(rb.capBlocked[0].source, 's5fb-rz');
  }
});

test('project(): a blocked ratification mints ONE cap card with three doors and the roster; unblocking clears the record', async () => {
  const scope = 's5g';
  await setScopes([scope]);
  await writePool([
    makeNode({ id: 's5g-g1', type: 'identity', scope, centrality: 0.9 }),
    makeNode({ id: 's5g-g2', type: 'identity', scope, centrality: 0.8 }),
    makeNode({ id: 's5g-rz', type: 'identity', scope, centrality: 0.3, ratified: RAT }),
  ]);
  const graduated = {
    's5g-g1': gradEntry('s5g-g1', 'roster rule one that always loads here', 'Fixture prose for s5g-g1.'),
    's5g-g2': gradEntry('s5g-g2', 'roster rule two that always loads here', 'Fixture prose for s5g-g2.'),
  };
  await writeState({ [scope]: { streaks: {}, emerging: [], gateSig: '', cap: 2, graduated } });

  // run 1: blocked, carded.
  let { audit } = await runDriver();
  let r = routeOf(audit, scope);
  assert.equal(r.capBlocked.length, 1);
  let cards = await insightFiles(`${today()}-cap-blocked-s5g-rz`);
  assert.equal(cards.length, 1, 'exactly one cap card for the blocked rule');
  const card = parseNode(await readFile(resolve(INSIGHTS_DIR, cards[0]), 'utf8')).frontmatter;
  assert.equal(card.detector, 'cap-blocked-graduation');
  assert.match(card.claim, /full \(2\/2\)/);
  assert.match(card.claim, /human-ratified/);
  assert.match(card.claim, /BLOCKED/);
  assert.match(card.suggested_fix, /Three doors:/);
  assert.match(card.suggested_fix, /retire a named rule/);
  assert.match(card.suggested_fix, /raise the cap/);
  assert.match(card.suggested_fix, /leave the rule emerging/);
  assert.match(card.suggested_fix, /never raised automatically/);
  const roster = card.evidence.filter((e) => /^- .*\[\[s5g-g[12]\]\]$/.test(e));
  assert.equal(roster.length, 2, 'the card carries the full current roster in evidence');
  let st = await readState();
  assert.ok(hasOwn(st[scope].capBlocked, 's5g-rz'), 'the block record persists');
  assert.deepEqual(Object.keys(st[scope].graduated).sort(), ['s5g-g1', 's5g-g2'], 'nothing was sliced in');

  // run 2: still blocked, no re-mint.
  await runDriver();
  assert.equal((await insightFiles(`${today()}-cap-blocked-s5g-rz`)).length, 1, 'card dedupe while blocked');

  // run 3: the human raises the cap (the one legal way): the rule ratifies in, the record clears.
  st = await readState();
  st[scope].cap = 3;
  await writeState(st);
  ({ audit } = await runDriver());
  r = routeOf(audit, scope);
  assert.deepEqual(r.ratified, ['s5g-rz']);
  st = await readState();
  assert.ok(hasOwn(st[scope].graduated, 's5g-rz'));
  assert.ok(!hasOwn(st[scope].capBlocked, 's5g-rz'), 'the record clears when the block resolves');
  assert.equal((await insightFiles(`${today()}-cap-blocked-s5g-rz`)).length, 1, 'no extra card on the unblock run');
});

test('project(): a streak graduation at a full block is blocked, the rule stays emerging with its streak intact', async () => {
  const scope = 's5h';
  await setScopes([scope]);
  const RULE = 'when testing streaks always retry the blocked door';
  await writePool([
    makeNode({ id: 's5h-g1', type: 'identity', scope, centrality: 0.9 }),
    makeNode({ id: 's5h-s', type: 'identity', scope, centrality: 0.7 }),
  ]);
  const graduated = { 's5h-g1': gradEntry('s5h-g1', 'the one durable rule filling the block', 'Fixture prose for s5h-g1.') };
  const emerging = [{ rule: RULE, source: 's5h-s' }];
  const pool = await loadPool();
  const sNode = pool.find((n) => n.id === 's5h-s');
  // seed the PERSISTED gateSig with the value project() will compute, so the judge-free reuse path
  // runs (see file header). streak 2 + this run's survival = 3 = GRADUATE_AFTER.
  const sig = await gateSigFor(scope, { gateCandidates: [sNode], graduatedRules: Object.values(graduated), emerging });
  await writeState({ [scope]: { streaks: { 's5h-s': 2 }, emerging, gateSig: sig, cap: 1, graduated } });

  let { audit } = await runDriver();
  let r = routeOf(audit, scope);
  assert.ok(r && !r.error, `the reuse path must run judge-free; got: ${r && r.error} (a gateSig drift here means the replica in gateSigFor no longer matches production)`);
  assert.deepEqual(r.graduated, [], 'no graduation through a full block');
  assert.equal(r.capBlocked.length, 1);
  assert.equal(r.capBlocked[0].door, 'streak');
  assert.equal(r.capBlocked[0].source, 's5h-s');
  let st = await readState();
  assert.deepEqual(Object.keys(st[scope].graduated), ['s5h-g1']);
  assert.deepEqual(st[scope].emerging, emerging, 'the rule stays emerging');
  assert.equal(st[scope].streaks['s5h-s'], 3, 'the streak holds (it retries every run)');
  assert.equal((await insightFiles(`${today()}-cap-blocked-s5h-s`)).length, 1, 'the streak door gets the same card');

  // run 2: still blocked, streak keeps advancing, card deduped.
  ({ audit } = await runDriver());
  r = routeOf(audit, scope);
  assert.equal(r.capBlocked.length, 1);
  st = await readState();
  assert.equal(st[scope].streaks['s5h-s'], 4);
  assert.equal((await insightFiles(`${today()}-cap-blocked-s5h-s`)).length, 1, 'card dedupe across runs while blocked');
});

// ================================================================ 7. proposed-rule cards

test('project(): a gate-passed-over candidate mints a proposed-rule card, deduped by persisted record, re-minted on content change, composed fail-soft', async () => {
  const scope = 's5i';
  await setScopes([scope]);
  await writePool([makeNode({ id: 's5i-p', title: 'A rule shaped candidate the gate ignores', type: 'identity', scope, centrality: 0.8 })]);
  let pool = await loadPool();
  let pNode = pool.find((n) => n.id === 's5i-p');
  const seed = async () => writeState({ [scope]: {
    streaks: {}, emerging: [], graduated: {},
    gateSig: await gateSigFor(scope, { gateCandidates: [pNode] }),
  } });
  await seed();

  // run 1: reuse path (empty emerging), the candidate is passed over, one card mints. judge is
  // unreachable offline (spawn ENOENT), so composeFields must fail soft into a PLAIN mint.
  const { stderr } = await runDriver();
  assert.match(stderr, /compose-insights: composition failed/,
    'the compose call must have been attempted and failed fast, not skipped silently');
  let cards = await insightFiles(`${today()}-proposed-rule-s5i-p`);
  assert.equal(cards.length, 1, 'exactly one proposed-rule card');
  const card = parseNode(await readFile(resolve(INSIGHTS_DIR, cards[0]), 'utf8')).frontmatter;
  assert.equal(card.detector, 'proposed-rule');
  assert.match(card.claim, /\[\[s5i-p\]\]/);
  assert.match(card.claim, /ratification would graduate it immediately/);
  assert.match(card.suggested_fix, /ratify\.mjs s5i-p --via/);
  assert.ok(!hasOwn(card, 'composed_headline'),
    'compose failure yields a plain mint: no composed fields, no throw');
  let st = await readState();
  assert.ok(hasOwn(st[scope], 'proposed') && hasOwn(st[scope].proposed, 's5i-p'),
    'the per-candidate record persists (and the vestigial-state cleanup must not drop it)');
  assert.equal(st[scope].proposed['s5i-p'].hash, contentHash(pNode.prose));

  // run 2: unchanged content, record present: no re-mint.
  await runDriver();
  assert.equal((await insightFiles(`${today()}-proposed-rule-s5i-p`)).length, 1, 'no re-mint while the hash stands');

  // run 3: the node's content moves: the card re-mints against the new hash.
  pNode.body = 'Changed fixture prose for s5i-p, enough words to matter.';
  await writeNode(pNode);
  pool = await loadPool();
  pNode = pool.find((n) => n.id === 's5i-p');
  const st2 = await readState();
  st2[scope].gateSig = await gateSigFor(scope, { gateCandidates: [pNode] });
  await writeState(st2);
  await runDriver();
  assert.equal((await insightFiles(`${today()}-proposed-rule-s5i-p`)).length, 2, 'a content change re-mints');
  st = await readState();
  assert.equal(st[scope].proposed['s5i-p'].hash, contentHash(pNode.prose), 'the record advances to the new hash');
});

// ================================================================ 8. saveProjState atomicity
// WALL ASSERTION, labelled as such: saveProjState is module-private and a true same-process write
// race is not drivable deterministically from outside. What is asserted is the entropy MECHANISM
// the fix consists of: a per-call unique tmp name (randomUUID, not the shared pid) plus
// write-then-rename onto the target, so two concurrent same-process saves can never interleave
// bytes in one tmp file or leave a torn target.

test('wall: saveProjState writes tmp-with-per-call-UUID then renames onto the state file', async () => {
  const src = await readFile(resolve(ENGINE_DIR, 'projection.mjs'), 'utf8');
  assert.match(src, /const tmp = `\$\{PROJ_STATE_FILE\}\.tmp-\$\{randomUUID\(\)\}`;/,
    'tmp-name entropy must be per-call (randomUUID); pid alone is shared by same-process callers');
  assert.match(src, /await writeFile\(tmp, JSON\.stringify\(state, null, 2\), 'utf8'\);\n\s*await rename\(tmp, PROJ_STATE_FILE\);/,
    'the write must land in the tmp file and reach the target only via rename');
  assert.match(src, /import \{ createHash, randomUUID \} from 'node:crypto';/,
    'randomUUID must be the real node:crypto import, not a local stub');
});

// ================================================================ 9. hostile keys

test('project(): node ids named __proto__ and toString flow through graduation and persistence as OWN keys', async () => {
  const scope = 's5k';
  await setScopes([scope]);
  await writePool([
    makeNode({ id: '__proto__', title: 'hostile proto node rule text here', type: 'identity', scope, centrality: 0.2, ratified: RAT }),
    makeNode({ id: 'toString', title: 'hostile tostring node rule text here', type: 'identity', scope, centrality: 0.3, ratified: RAT }),
  ]);
  await writeState({ [scope]: { streaks: {}, emerging: [], gateSig: '', graduated: {} } });

  // in-process dry-run first: the ratById -> sc.graduated injection runs in THIS process, so guard
  // the shared prototype with a baseline-aware finally (assertion failures must not cascade).
  const WATCH = ['rule', 'source', 'sourceHash'];
  const baseline = WATCH.map((k) => Object.getOwnPropertyDescriptor(Object.prototype, k));
  const polluted = [];
  try {
    const audit = await project(await loadPool(), { dryRun: true });
    const r = routeOf(audit, scope);
    assert.ok(r && !r.error, `route missing or errored: ${r && r.error}`);
    assert.deepEqual([...r.ratified].sort(), ['__proto__', 'toString']);
    // durable derives from Object.values(sc.graduated): both hostile ids must be OWN entries of
    // that map for this to hold (a plain {} would reparent on __proto__ and lose the entry).
    assert.deepEqual(r.durable.map((d) => d.source).sort(), ['__proto__', 'toString']);
  } finally {
    WATCH.forEach((k, i) => {
      const now = Object.getOwnPropertyDescriptor(Object.prototype, k);
      const base = baseline[i];
      const same = (!now && !base) || (now && base && now.value === base.value && now.writable === base.writable
        && now.enumerable === base.enumerable && now.configurable === base.configurable);
      if (same) return;
      polluted.push(k);
      if (now && now.configurable) { delete Object.prototype[k]; if (base) Object.defineProperty(Object.prototype, k, base); }
    });
  }
  assert.deepEqual(polluted, [], 'nothing may be written onto Object.prototype');

  // non-dry through the driver: persistence, rehydration and the fence. OWN-key assertions on the
  // JSON.parse'd state file, never a read-back through a live object's prototype chain.
  let { polluted: childPolluted } = await runDriver();
  assert.deepEqual(childPolluted, [], 'the child run must not pollute its shared prototypes');
  let st = await readState();
  assert.ok(hasOwn(st[scope].graduated, '__proto__'), '__proto__ must be an OWN key of the persisted graduated map');
  assert.ok(hasOwn(st[scope].graduated, 'toString'), 'toString must be an OWN key of the persisted graduated map');
  const fence = await readFile(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md'), 'utf8');
  assert.match(fence, /\[\[__proto__\]\] \(ratified\)/);
  assert.match(fence, /\[\[toString\]\] \(ratified\)/);

  // rehydration (loadProjState's nullMap on reload): a second run must see both as already
  // graduated (no re-ratify) and keep them durable.
  const run2 = await runDriver();
  const r2 = routeOf(run2.audit, scope);
  assert.deepEqual(r2.ratified, [], 'already graduated after reload: the ratified door does not re-fire');
  assert.deepEqual(r2.durable.map((d) => d.source).sort(), ['__proto__', 'toString']);

  // capBlocked keyed by a hostile id: shrink the block so toString is BLOCKED. The dedupe guard is
  // `sc.capBlocked[b.source] !== undefined`, an inherited READ on a plain {}: for toString it
  // would find Object.prototype.toString (truthy, defined) and silently skip the mint, so the card
  // existing at all is the discriminating observation.
  st = await readState();
  st[scope].cap = 1;
  delete st[scope].graduated.toString;
  await writeState(st);
  const run3 = await runDriver();
  const r3 = routeOf(run3.audit, scope);
  assert.equal(r3.capBlocked.length, 1);
  assert.equal(r3.capBlocked[0].source, 'toString');
  assert.equal((await insightFiles(`${today()}-cap-blocked-toString`)).length, 1,
    'the cap card must mint for a rule whose source id shadows an Object.prototype member');
  st = await readState();
  assert.ok(hasOwn(st[scope].capBlocked, 'toString'), 'the block record is an OWN key');
  assert.ok(hasOwn(st[scope].graduated, '__proto__'), 'the surviving hostile entry is still an OWN key');
});

// ================================================================ 9. reviewer-round fixes

test('ratifyNode refuses a non-behavioral node and leaves the file byte-identical', async () => {
  // poolOf fails closed: knowledge AND unknown types are library, and a ratified: block on a
  // library node would persist but never graduate (projection filters on isBehavioral).
  await writePool([
    makeNode({ id: 'rat-lib', type: 'knowledge', scope: 'cockpit' }),
    makeNode({ id: 'rat-alien', type: 'no-such-type', scope: 'cockpit' }),
  ]);
  for (const id of ['rat-lib', 'rat-alien']) {
    const before = await readFile(resolve(NODES_DIR, `${id}.md`), 'utf8');
    await assert.rejects(() => ratifyNode(id, { via: 'in-session', turn: 'a:1' }), /not behavioral/,
      `${id} must be refused`);
    assert.equal(await readFile(resolve(NODES_DIR, `${id}.md`), 'utf8'), before,
      `the refusal must leave ${id}.md byte-identical`);
  }
});

test('project(): a measured-nothing-over run clears a stale retireProposed record, and a later over-threshold run re-mints', async () => {
  const scope = 's5m';
  const COVER = 'restate this exact covered doctrine sentence for the s5m scenario';
  const skelFile = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');
  await setScopes([scope]);
  await writeFile(skelFile, `# ${scope} skeleton\n\n${COVER}\n`, 'utf8');
  await writePool([makeNode({ id: 's5m-r', type: 'identity', scope, centrality: 0.2, ratified: RAT })]);
  // a stale record with NO durable rule behind it: the suppression branch cannot run (no
  // durables), which is exactly the measured-nothing-over case the cleanup must still cover.
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '', graduated: {},
    retireProposed: { 's5m-r': { insight: 'stale-card', at: today() } },
  } });
  await runDriver({ mock: true });
  let st = await readState();
  assert.ok(!hasOwn(st[scope].retireProposed, 's5m-r'),
    'a run that measured nothing over the threshold must clear the stale record');
  // coverage returns over the threshold: the cleared record must not suppress the re-mint.
  st[scope].graduated = { 's5m-r': gradEntry('s5m-r', COVER, 'Fixture prose for s5m-r.') };
  await writeState(st);
  await runDriver({ mock: true });
  st = await readState();
  assert.ok(hasOwn(st[scope].retireProposed, 's5m-r'), 'the over-threshold run re-records the proposal');
  assert.equal((await insightFiles(`${today()}-ratified-rule-retirement-s5m-r`)).length, 1,
    'the retirement card re-mints after the clear');
});

test('printProjection: the cap-blocked label is truthful under dryRun', () => {
  const audit = [{ scope: 's5p', key: 's5p', file: 'x', durable: [], emerging: [],
    graduated: [], ratified: [], capBlocked: [{ door: 'streak', rule: 'r', source: 's5p-x' }],
    demoted: [], drifted: [], suppressed: [], retireProposals: [], dropped: [], gated: false,
    wrote: false, commit: null }];
  const capture = (dryRun) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { printProjection(audit, dryRun); } finally { console.log = orig; }
    return lines.join('\n');
  };
  assert.match(capture(true), /cap-blocked \(card would be minted\)/, 'dryRun mints nothing');
  assert.doesNotMatch(capture(true), /cap-blocked \(card minted\)/);
  assert.match(capture(false), /cap-blocked \(card minted\)/, 'a live run does mint');
});

// ================================================================ 10. second reviewer round

test('project(): a retirement-card write failure fails the route loudly, never as an embed skip', async () => {
  const scope = 's5n';
  const COVER = 'the s5n covered doctrine sentence that the ratified rule restates';
  const skelFile = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');
  await setScopes([scope]);
  await writeFile(skelFile, `# ${scope} skeleton\n\n${COVER}\n`, 'utf8');
  await writePool([makeNode({ id: 's5n-r', type: 'identity', scope, centrality: 0.2, ratified: RAT })]);
  // a stale record for a DIFFERENT id: after the failed run it must not have been silently kept by
  // a measured=false path that then saved state as if the run were healthy.
  const seedState = { [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: { 's5n-r': gradEntry('s5n-r', COVER, 'Fixture prose for s5n-r.') },
    retireProposed: { 's5n-stale': { insight: 'stale-card', at: today() } },
  } };
  await writeState(seedState);
  // make the card write fail: the insights store is a FILE, so writeInsightFile's mkdir throws
  // (permission bits are useless under unshare -rn, where the test user maps to root).
  await rm(INSIGHTS_DIR, { recursive: true, force: true });
  await writeFile(INSIGHTS_DIR, 'not a directory', 'utf8');
  try {
    let failure;
    try { await runDriver({ mock: true }); } catch (e) { failure = e; }
    assert.ok(failure, 'the card-write failure must fail the run, not be swallowed');
    const out = `${failure.stdout || ''}${failure.stderr || ''}`;
    assert.doesNotMatch(out, /embedding suppression skipped/,
      'a write failure must never masquerade as an embed failure');
    assert.match(out, /ENOTDIR|EEXIST/, 'the real filesystem error surfaces');
    const st = await readState();
    assert.deepEqual(st, seedState, 'the aborted run persists nothing');
  } finally {
    await rm(INSIGHTS_DIR, { force: true });
    await mkdir(INSIGHTS_DIR, { recursive: true });
  }
  // store restored: the same measured run clears the stale record and mints the real card.
  await runDriver({ mock: true });
  const st = await readState();
  assert.ok(!hasOwn(st[scope].retireProposed, 's5n-stale'), 'the measured run clears the stale record');
  assert.ok(hasOwn(st[scope].retireProposed, 's5n-r'), 'the over-threshold rule is recorded');
  assert.equal((await insightFiles(`${today()}-ratified-rule-retirement-s5n-r`)).length, 1);
});

test('project(): a suppression-trail write failure fails the route loudly BEFORE the durable rule leaves state', async () => {
  const scope = 's5q';
  const COVER = 'the s5q covered doctrine sentence that the unratified rule restates';
  const skelFile = resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md');
  await setScopes([scope]);
  await writeFile(skelFile, `# ${scope} skeleton\n\n${COVER}\n`, 'utf8');
  await writePool([makeNode({ id: 's5q-u', type: 'identity', scope, centrality: 0.9 })]);
  const seedState = { [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: { 's5q-u': gradEntry('s5q-u', COVER, 'Fixture prose for s5q-u.') },
  } };
  await writeState(seedState);
  // make recordSuppression fail: turn the temp memory root into a git repo (commitFile then owns
  // it, IS_ISOLATED_ROOT) and replace .git/index with a DIRECTORY, so the repo stays detectable
  // (rev-parse needs objects/ and refs/, not the index) but `git add` on the trail-bearing node
  // throws (permission bits are useless under unshare -rn, where the test user maps to root).
  const gitDir = resolve(TEST_MEMORY_ROOT, '.git');
  await execFileP('git', ['init', '--quiet', TEST_MEMORY_ROOT]);
  await rm(resolve(gitDir, 'index'), { force: true });
  await mkdir(resolve(gitDir, 'index'), { recursive: true });
  try {
    let failure;
    try { await runDriver({ mock: true }); } catch (e) { failure = e; }
    assert.ok(failure, 'the trail-write failure must fail the run, not be swallowed');
    const out = `${failure.stdout || ''}${failure.stderr || ''}`;
    assert.doesNotMatch(out, /embedding suppression skipped/,
      'a write failure must never masquerade as an embed failure');
    assert.match(out, /Command failed.*git|fatal/s, 'the real git failure surfaces');
    const st = await readState();
    assert.ok(hasOwn(st[scope].graduated, 's5q-u'),
      'the durable rule is still in persisted state: nothing lost without its trail recorded');
    assert.deepEqual(st, seedState, 'the aborted run persists nothing');
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
  // repo gone: the same measured run now suppresses cleanly, trail before deletion.
  await runDriver({ mock: true });
  const st = await readState();
  assert.ok(!hasOwn(st[scope].graduated, 's5q-u'), 'the healthy run auto-deletes the covered rule');
  const uNode = parseNode(await readFile(resolve(NODES_DIR, 's5q-u.md'), 'utf8'), 's5q-u').frontmatter;
  assert.ok(Array.isArray(uNode.suppressed_by) && uNode.suppressed_by.length === 1,
    'exactly one suppressed_by trail (the failed run wrote it; the retry deduped)');
});

test('project(): the cap-blocked audit status says what happened to the card, and printProjection follows it', async () => {
  const scope = 's5o';
  await setScopes([scope]);
  await writePool([
    makeNode({ id: 's5o-g1', type: 'identity', scope, centrality: 0.9 }),
    makeNode({ id: 's5o-g2', type: 'identity', scope, centrality: 0.8 }),
    makeNode({ id: 's5o-rz', type: 'identity', scope, centrality: 0.3, ratified: RAT }),
  ]);
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '', cap: 2,
    graduated: {
      's5o-g1': gradEntry('s5o-g1', 'first unratified durable rule for s5o here', 'Fixture prose for s5o-g1.'),
      's5o-g2': gradEntry('s5o-g2', 'second unratified durable rule for s5o here', 'Fixture prose for s5o-g2.'),
    },
  } });
  const capture = (audit, dryRun) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { printProjection(audit, dryRun); } finally { console.log = orig; }
    return lines.join('\n');
  };

  // run 1, live: blocked and freshly carded.
  let { audit } = await runDriver();
  let r = routeOf(audit, scope);
  assert.equal(r.capBlocked[0].status, 'minted');
  assert.match(capture(audit, false), /cap-blocked \(card minted\)/);
  assert.equal((await insightFiles(`${today()}-cap-blocked-s5o-rz`)).length, 1);

  // run 2, live: still blocked, the persisted record skips the mint and the label says so.
  ({ audit } = await runDriver());
  r = routeOf(audit, scope);
  assert.equal(r.capBlocked[0].status, 'already-carded');
  assert.match(capture(audit, false), /cap-blocked \(already carded\)/);
  assert.doesNotMatch(capture(audit, false), /\(card minted\)/,
    'a repeat block must not claim a mint the dedupe skipped');
  assert.equal((await insightFiles(`${today()}-cap-blocked-s5o-rz`)).length, 1, 'no re-mint');

  // run 3, dry against the existing record: a live run would skip too, and the label says that.
  const dryAudit = await project(await loadPool(), { dryRun: true });
  r = routeOf(dryAudit, scope);
  assert.equal(r.capBlocked[0].status, 'would-skip');
  assert.match(capture(dryAudit, true), /cap-blocked \(already carded, would skip\)/);
  assert.doesNotMatch(capture(dryAudit, true), /\(card would be minted\)/);

  // dry with NO record: the would-mint variant.
  const st = await readState();
  delete st[scope].capBlocked['s5o-rz'];
  await writeState(st);
  const dryAudit2 = await project(await loadPool(), { dryRun: true });
  r = routeOf(dryAudit2, scope);
  assert.equal(r.capBlocked[0].status, 'would-mint');
  assert.match(capture(dryAudit2, true), /cap-blocked \(card would be minted\)/);
});

// ================================================================ 10. OPEN-18 drift, ratified lane

test('project(): the drift check reaches a RATIFIED source below the centrality floor (outside candById)', async () => {
  const scope = 's5p';
  await setScopes([scope]);
  // below the floor: only the ratified lane (ratById) carries this node, so a drift loop that
  // resolves sources via candById alone never sees it.
  await writePool([
    makeNode({ id: 's5p-r', type: 'identity', scope, centrality: 0.2, ratified: RAT,
      body: 'Current prose for s5p-r, edited since graduation.' }),
  ]);
  await writeState({ [scope]: {
    streaks: {}, emerging: [], gateSig: '',
    graduated: { 's5p-r': gradEntry('s5p-r', 'ratified rule cached before its source moved', 'Old prose for s5p-r at graduation time.') },
  } });
  // non-dry run, offline: judge() fails (spawn ENOENT), the catch mints the flag insight with the
  // fallback summary, so the drift path leaves two observable footprints if and only if it
  // resolved the node.
  const { audit } = await runDriver();
  const r = routeOf(audit, scope);
  assert.ok(r && !r.error, `route missing or errored: ${r && r.error}`);
  assert.equal(r.drifted.length, 1, 'the drift check must reach the ratified below-floor source');
  assert.equal((await insightFiles(`${today()}-durable-rule-drift-s5p-r`)).length, 1,
    'the durable-rule-drift insight must exist');
  const st = await readState();
  assert.equal(st[scope].graduated['s5p-r'].sourceHash,
    contentHash('Current prose for s5p-r, edited since graduation.'),
    'sourceHash must advance to the current prose so the same diff never re-fires');
});
