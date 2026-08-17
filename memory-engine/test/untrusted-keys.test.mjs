// untrusted-keys.test.mjs — the untrusted-object-key sweep, WAVE 2.
//
// Wave 1 (retrieval/nodes/dossiers/projection) is covered in recall-scoring.test.mjs §6k, which
// also states the class. Repeated here only because it governs every probe below:
//
//   The class is ASYMMETRIC, but the split is NOT "`__proto__` versus the other names" (round 5
//   corrected this: the old wording here was false as a general rule). The real split is DIRECT
//   SIMPLE ASSIGNMENT versus INHERITED READ.
//     • DIRECT SIMPLE ASSIGNMENT, `o[k] = v` with no prior read: only `__proto__` misbehaves,
//       because it is the one inherited SETTER. Assigning `toString` merely creates an own
//       shadowing property that reads back fine.
//     • INHERITED READ, `k in o` / `o[k]` truthiness / `if (!o[k])` guards: `toString`, `valueOf`,
//       `constructor`, `hasOwnProperty` and friends misbehave, because the chain hands back a
//       truthy function. `'__proto__' in o` is ALSO true on a plain object, so `in` sites are not
//       exclusive to the non-`__proto__` names either; they are merely undramatic for `__proto__`.
//     • READ-MODIFY-WRITE, `(m[k] ||= []).push(x)` / `m[k] ??= v` / `m[k] = (m[k] || 0) + 1` /
//       `let d = m[k]; if (!d) d = m[k] = {}`: this is an inherited READ first, so it fails for
//       EVERY inherited prototype name, `__proto__` included. `(m.toString ||= []).push(x)` throws
//       exactly like the `__proto__` case, because the inherited function is truthy so the array is
//       never minted. A read-modify-write site is therefore probeable with either name.
//   So the probe follows the SITE SHAPE, not a name table: direct assignment → `__proto__`, pure
//   presence/lookup → the inherited function names, read-modify-write → either (each site below
//   states which it uses and why it is sufficient there).
//
// Wave 2 splits into two consequence classes, and the CRASH ones come first:
//   • `(map[k] ||= []).push(x)` on a plain `{}` — for k === '__proto__' the read returns a truthy
//     Object.prototype, so no array is created and `.push` is undefined. A TypeError, mid-write.
//   • `k in out` accumulators in four serializers — silent field loss from a persisted artifact.
//
// STRENGTH OF EVIDENCE, per test, because the aggregate claim this header used to make ("every test
// drives the real function") was false and the caveats further down did not repair it. Three tiers.
//
// WHAT THIS FILE CONTAINS, counted honestly (round 4: the previous breakdown mixed whole test
// declarations with assertions embedded inside other tests, and with a production site that is not
// a test at all). 18 `test(...)` declarations, and nothing else is a test:
//   • 9 REAL DRIVE tests: §3a, §3b, §4, §5, §6, §7 judge-claude, §7 judge-hermes, §8a, §8b.
//   • 3 SOURCE LIFT tests: §1, §3c, §3d.
//   • 5 standalone WALL tests: §2, §2b, §2c, §8c, §8d.
//   • 1 probe sanity test (the last one), which tests the fixtures, not the engine.
// Counted separately, because they are NOT test declarations:
//   • 2 embedded WALL ASSERTIONS: the ACCEPT side of each judge adapter, asserted on module source
//     INSIDE the two §7 real-drive tests (whose driven half is the REJECT side only).
//
//   REAL DRIVE — the production entry point actually runs, and where the site persists anything the
//   assertion is made after a real serialization round trip (a file write + read, or
//   JSON.stringify/parse). Nothing is replicated locally. These are: §3a serializeProject (closure.mjs
//   CLI), §3b mechanical serializeInsight (mechanical-insights.mjs CLI), §5
//   truthPass t.delta/ledgers/deltaMeta/report.lane, §6 truth-eval loadLedgersForItems, §7 both
//   judge adapters' REJECT side, §8a closure.mjs TRANSITIONS (CLI).
//
//   SOURCE LIFT — the function is module-private behind an LLM or embedding call, so its REAL SOURCE
//   TEXT is extracted from the module and evaluated (see `lift`). It runs the module's real bytes, so
//   reverting the fix inside that function fails the test. It says NOTHING about whether production
//   still calls the function; `lift`'s `caller` pattern is a lexical coupling only (see its comment).
//   These are: §1 renderIndex, §3c semantic serializeInsight, §3d serializeStalenessInsight.
//
//   WALL ASSERTION — nothing is reachable offline at all, so the test asserts the shape of the fix in
//   the module source, plus (where it can) the reachability premise that makes the fix necessary. A
//   wall cannot tell a working map from a broken one. These are: §2 workByScope, §2b state.reflect,
//   §2c audit.scopes, §7's ACCEPT side, §8c hermes-capture SESSION_VIA, §8d dossiers argv flags.
//

// One more rule the whole file obeys, learned the expensive way (round 3): a hostile-key assertion
// must check OWN-property-ness with Object.prototype.hasOwnProperty.call, never a plain read-back.
// The inherited `__proto__` setter is VALUE-TYPED, and both of its outcomes defeat a read-back:
//   • an OBJECT (or null) value REPARENTS the receiver, so reading `o['__proto__']` back returns the
//     very object just installed as the prototype, and the test passes while the data is corrupt;
//   • a STRING (or any other primitive) value is IGNORED outright, the write is simply lost, and the
//     read-back returns Object.prototype, which is truthy and often survives a loose assertion.
// Which outcome applies is stated per site below, because they fail differently downstream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dump as yamlDump } from 'js-yaml';

import { TEST_MEMORY_ROOT } from './fixtures.mjs';
import { parseNode } from '../nodes.mjs';
import { truncate } from '../read-pass.mjs';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(import.meta.dirname, '..');
const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const ownKeys = (o) => Object.getOwnPropertyNames(o);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- the source-lift harness
// Some of the fixed functions are module-private AND their only caller sits behind an LLM call or an
// embedding call, both of which the offline test process cannot make. Rather than assert on a regex
// (which cannot tell a working accumulator from a broken one) or build a `{}` replica (which tests
// nothing), the function's REAL source text is extracted and evaluated with its free identifiers
// injected. What runs is the bytes in the module, so reverting the fix in the module fails the test.
const _src = new Map();
async function moduleSrc(file) {
  if (!_src.has(file)) _src.set(file, await readFile(resolve(ENGINE_DIR, file), 'utf8'));
  return _src.get(file);
}
// `caller` is MANDATORY, and what it buys is narrower than it looks. It NARROWS the harness's hole,
// it does not close it: the pattern only proves the call text still occurs SOMEWHERE in the module
// source, so it would equally match a commented-out call, an unreachable branch, or a dead caller
// left behind after production was rewired. It catches the cheap regressions (a rename, an outright
// removal, a rewrite of the call) and nothing more. Reachability of the lifted function is NOT
// asserted anywhere in this file.
async function lift(file, { consts = [], fn, caller, inject = {} }) {
  const src = await moduleSrc(file);
  assert.ok(caller instanceof RegExp, `lift: ${fn} must declare its production caller pattern`);
  assert.match(src, caller, `lift: ${fn}'s call text no longer appears in ${file}, so this lifted test `
    + 'has lost even its lexical coupling to production; re-point it at the new call site');
  const parts = [];
  for (const c of consts) {
    const m = src.match(new RegExp(`^const ${c} = \\[[\\s\\S]*?\\n\\];`, 'm'));
    assert.ok(m, `lift: const ${c} not found in ${file}`);
    parts.push(m[0]);
  }
  // top-level function declaration: the terminator is the first `}` in column 0 (every nested brace
  // in this codebase is indented), so the non-greedy match stops exactly at the end of the function.
  const m = src.match(new RegExp(`^(?:async )?function ${fn}\\([\\s\\S]*?\\n\\}`, 'm'));
  assert.ok(m, `lift: function ${fn} not found in ${file}`);
  parts.push(m[0]);
  const names = Object.keys(inject);
  return new Function(...names, `${parts.join('\n')}\nreturn ${fn};`)(...names.map((n) => inject[n]));
}

// ================================================================ 1. reconcile.mjs renderIndex
// THE CRASH. `cluster` is model-derived frontmatter (the distiller names it), so it is an untrusted
// key. WAS: `const byCluster = {}` and `(byCluster[cluster] ||= []).push(n)`. For a cluster named
// `__proto__` the read returns Object.prototype — truthy — so `||=` never assigns, and
// `Object.prototype.push` is undefined: TypeError. READ-MODIFY-WRITE, so per the corrected taxonomy
// above the same crash fires for a cluster named `toString` (the inherited function is truthy too),
// and this test probes BOTH names for that reason. That throw happens inside PHASE 1 of the nightly
// run, one line after the touched node files were written and BEFORE the knowledge/ commit, so a
// single hostile cluster name aborted INDEX regeneration and left the tree half-written for the next
// run's dirty-tree guard to refuse. NOW: Object.create(null), so `||=` sees undefined and mints an
// array.
//
// REACHABILITY, stated: renderIndex is not exported and its ONE caller (reconcile.mjs:1354) is
// gated on `touched.length`, i.e. on a completed distill pass — an LLM call — and is immediately
// followed by syncCache(), an embedding call. Neither is available offline, and there is no second
// INDEX.md writer in the engine (grep: nodes.mjs defines INDEX_FILE, reconcile.mjs is the only
// writer). So the function's real source is lifted and driven directly; see the harness above.
test('regression: renderIndex renders clusters named __proto__ and toString instead of throwing', async () => {
  const renderIndex = await lift('reconcile.mjs', {
    fn: 'renderIndex', caller: /await writeFile\(INDEX_FILE, renderIndex\(pool\), 'utf8'\);/,
    inject: { nowISO: () => '2026-07-25T00:00:00.000Z', truncate },
  });
  const n = (id, cluster, centrality) => ({ id, prose: `prose for ${id}`, frontmatter: { id, cluster, centrality } });
  const out = renderIndex([
    n('hostile-a', '__proto__', 0.9),
    n('hostile-b', '__proto__', 0.4),
    n('hostile-c', 'toString', 0.7),
    n('ordinary', 'memory', 0.5),
    n('bare', undefined, 0.5),
    { id: 'dead', prose: 'gone', frontmatter: { id: 'dead', cluster: '__proto__', superseded: true } },
  ]);
  // the whole INDEX renders — the pre-fix code never got here at all
  assert.match(out, /^## __proto__$/m, 'the __proto__ cluster must get its own INDEX section');
  assert.match(out, /## __proto__\n- \[\[hostile-a\]\][\s\S]*?\n- \[\[hostile-b\]\]/,
    'both members must be grouped under it, centrality-ordered');
  assert.match(out, /^## toString$/m,
    'a `toString` cluster must render too: the `||=` is a read-modify-write, so it crashed on every '
    + 'inherited name, not only on __proto__');
  assert.match(out, /## toString\n- \[\[hostile-c\]\]/, 'and carry its member');
  assert.match(out, /^## memory$/m, 'the ordinary cluster is unaffected');
  assert.match(out, /^## unclustered$/m, 'the missing-cluster default is unaffected');
  assert.match(out, /_5 node\(s\), regenerated /, 'the superseded node is excluded from the live count');
  assert.doesNotMatch(out, /\[\[dead\]\]/);
  // and nothing leaked onto the shared prototype on the way through
  assert.equal(Object.prototype.push, undefined);
});

// ================================================================ 2. reconcile.mjs workByScope
// WALL ASSERTION, not a discriminating regression test — stated plainly rather than left to look
// like coverage. Same `(map[k] ||= []).push(x)` crash shape at reconcile.mjs:960, keyed by SCOPE.
//
// Which half is tested: unlike projection.mjs (recall-scoring §6k test 5), reconcile's scope list is
// NOT slug-gated. `main()` takes it from `--scope` or read-pass.mjs's loadScopes(), which returns
// memory/scopes.json verbatim (read-pass.mjs:200-207 — no isScopeSlug filter, and paths.mjs:32's
// /^[a-z0-9][a-z0-9-]*$/ is never consulted on this path). stagingFiles() then just resolves
// scopes/<scope>/staging and returns [] if absent. So a scope literally named `__proto__` in
// scopes.json DOES reach the `||=`, and the null-prototype map is the ONLY wall there is.
// It is nonetheless not drivable: reaching that line means running reconcile.mjs main(), which
// acquires the reconciler lock and then runs the whole distill/project/truth nightly, all of which
// need an LLM and an embedding model. So this test asserts (a) that the reachability claim above is
// true — the gate genuinely does not exist — and (b) the shape of the wall at the site.
test('wall: reconcile takes its scope list unfiltered, so workByScope must be null-prototype', async () => {
  const { loadScopes } = await import('../read-pass.mjs');
  const scopesFile = resolve(TEST_MEMORY_ROOT, 'scopes.json');
  const before = await readFile(scopesFile, 'utf8').catch(() => null);
  // JSON.parse rather than a literal: the value is an array of strings here, but the same discipline
  // as §6k — the on-disk shape is what the engine reads.
  await writeFile(scopesFile, JSON.stringify(['cockpit', '__proto__', 'constructor']), 'utf8');
  try {
    const scopes = await loadScopes();
    assert.deepEqual(scopes, ['cockpit', '__proto__', 'constructor'],
      'loadScopes applies NO slug gate — if it ever grows one, this test should be replaced by a real drive');
  } finally {
    if (before === null) await rm(scopesFile, { force: true });
    else await writeFile(scopesFile, before, 'utf8');
  }
  // (b) the wall itself, at the site. A shape assertion is all that is available without an LLM.
  const src = await moduleSrc('reconcile.mjs');
  assert.match(src, /const workByScope = Object\.create\(null\);/,
    'workByScope must be null-prototype: a plain {} makes a `__proto__` scope crash the ||=');
  assert.match(src, /\(workByScope\[scope\] \|\|= \[\]\)\.push\(/,
    'the crash shape this guards is still present — if it changes, revisit the wall');
});

// ================================================================ 2b. reconcile.mjs state.reflect
// WALL ASSERTION for the same reason as §2 (the site sits in main(), behind the lock and the LLM
// nightly), and reachable for the same reason: reconcile's scope list is unfiltered, proved above.
// `state.reflect` is scope -> fingerprint for the reflect cost-guard (compared at reconcile.mjs:1156,
// written at :1173). PRESENCE-and-ASSIGNMENT both: for a scope named `__proto__` on a plain object the
// compare reads Object.prototype and the string write hits the inherited setter and is dropped, so the
// scope never persists a fingerprint and pays its consolidate judge() call every reflect run forever.
// Both paths must be covered, the fresh one AND the rehydration, and ONE unconditional statement
// covers both: `Object.assign(Object.create(null), state.reflect)` treats an absent value as no
// source and always yields a fresh null-prototype map. An earlier cut of this fix also carried a
// `state.reflect ||= Object.create(null)` mint in front of it; that mint was discarded on every path
// (Codex r3), and this test used to demand BOTH lines, which is what kept the dead one alive. So the
// requirement here is the unconditional normalize and nothing else. A construct-only fix would be the
// real failure mode: `||=` never fires on the truthy plain object JSON.parse returns, the trap that
// already bit t.delta once.
test('wall: reconcile normalizes state.reflect unconditionally, covering fresh and rehydrated alike', async () => {
  const src = await moduleSrc('reconcile.mjs');
  assert.match(src, /^ *state\.reflect = Object\.assign\(Object\.create\(null\), state\.reflect\);$/m,
    'one unconditional normalize must cover both paths: a construct-only fix is DEAD here, `||=` '
    + 'never fires on the plain object loadState returns from JSON.parse');
  assert.doesNotMatch(src, /state\.reflect \|\|= /,
    'a conditional mint in front of the unconditional normalize is dead code by construction');
  assert.match(src, /state\.reflect\[scope\] = scopeFingerprint\(/,
    'the scope-keyed assignment this guards is still present — if it changes, revisit the wall');
});

// ================================================================ 2c. reconcile.mjs audit.scopes
// WALL ASSERTION, same reachability story as §2 and §2b: the site is inside main(), behind the
// reconciler lock and the LLM nightly. `audit.scopes` is minted at reconcile.mjs:1077 and assigned at
// :1149 as `audit.scopes[scope] = {...}`, with `scope` taken from the SAME unfiltered scope list §2
// proves has no slug gate. The value is an OBJECT, so on a plain `{}` the write goes through the
// inherited setter and REPARENTS audit.scopes to that record (Object.prototype is not touched);
// either way a scope named `__proto__` gets no own entry at all, so it
// is silently absent from every own-key enumeration and from the JSON serialization of the run audit:
// the scope's distill/existing/sources counts vanish from the record of the night.
test('wall: reconcile mints audit.scopes null-prototype, so a hostile scope gets an OWN entry', async () => {
  const src = await moduleSrc('reconcile.mjs');
  assert.match(src, /scopes: Object\.create\(null\),/,
    'audit.scopes must be null-prototype: on a plain {} a `__proto__` scope never becomes an own entry');
  assert.match(src, /audit\.scopes\[scope\] = \{ distilled:/,
    'the scope-keyed assignment this guards is still present — if it changes, revisit the wall');
});

// ================================================================ 3. the four `k in out` serializers
// PRESENCE-SITE bug, identical line in all four:
//     for (const k of Object.keys(fm)) if (!(k in out) && fm[k] != null) out[k] = fm[k];
// `in` walks the prototype chain, so on a plain `{}` accumulator `toString`, `valueOf` and
// `constructor` all read as already-present and were skipped. That second loop exists precisely to
// preserve fields the ordered field list does not know about, and every one of these frontmatters is
// written from model output, so an unknown field with one of those names was silently dropped from
// the persisted artifact. Probes are the inherited FUNCTION names. Not because `'__proto__' in out`
// is false (it is true too, on a plain object), but because the values here are strings, so the
// `out['__proto__'] = fm[k]` that a fixed accumulator would perform is a silent no-op on a plain
// `{}` either way: only the function names make the loss observable.

// ---- 3a. closure.mjs serializeProject — driven through the real CLI, real write, real read-back.
test('regression: serializeProject preserves frontmatter keys named after Object.prototype members', async () => {
  const id = 'proto-fields-project';
  const dir = resolve(TEST_MEMORY_ROOT, 'scopes', 'cockpit', 'projects');
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${id}.md`);
  // `graduated` so the `archive` transition applies — the one verb that needs no LLM, no extra
  // files and no flags, and still runs the full read -> mutate -> serializeProject -> write path.
  await writeFile(path, [
    '---', `id: ${id}`, 'scope: cockpit', 'state: graduated', 'kind: finite', 'schema_version: 1',
    'toString: custom-a', 'valueOf: custom-b', 'constructor: custom-c', 'normalField: kept',
    '---', '', 'Project body.', '',
  ].join('\n'), 'utf8');

  await execFileP('node', [resolve(ENGINE_DIR, 'closure.mjs'), 'archive', 'cockpit', id],
    { cwd: ENGINE_DIR, env: { ...process.env, COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT } });

  const round = parseNode(await readFile(path, 'utf8'), id).frontmatter;
  assert.equal(round.state, 'archived', 'the verb actually ran and rewrote the object');
  assert.equal(round.normalField, 'kept', 'an ordinary unknown field IS preserved — the point of that loop');
  for (const k of ['toString', 'valueOf', 'constructor']) {
    assert.ok(hasOwn(round, k), `the ${k} field must survive serializeProject`);
  }
  assert.equal(round.toString, 'custom-a');
  assert.equal(round.valueOf, 'custom-b');
  assert.equal(round.constructor, 'custom-c');
});

// ---- 3b. mechanical-insights.mjs serializeInsight — driven through the real CLI `dismiss` verb,
// the one status transition that mints nothing and calls no judge.
test('regression: mechanical serializeInsight preserves frontmatter keys named after Object.prototype members', async () => {
  const id = '2026-07-25-proto-mechanical-probe';
  const dir = resolve(TEST_MEMORY_ROOT, 'insights');
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${id}.md`);
  await writeFile(path, [
    '---', `id: ${id}`, 'claim: a probe finding', 'evidence: none', 'suggested_fix: none',
    'source: test', 'pattern: proto-probe', 'scope: cockpit', 'status: new', 'detected: 2026-07-25',
    'toString: custom-a', 'valueOf: custom-b', 'constructor: custom-c', 'normalField: kept',
    '---', '', 'Body.', '',
  ].join('\n'), 'utf8');

  await execFileP('node', [resolve(ENGINE_DIR, 'mechanical-insights.mjs'), 'dismiss', id],
    { cwd: ENGINE_DIR, env: { ...process.env, COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT } });

  const round = parseNode(await readFile(path, 'utf8'), id).frontmatter;
  assert.equal(round.status, 'dismissed', 'the verb actually ran and rewrote the card');
  assert.equal(round.normalField, 'kept');
  for (const k of ['toString', 'valueOf', 'constructor']) {
    assert.ok(hasOwn(round, k), `the ${k} field must survive the mechanical serializeInsight`);
  }
  assert.equal(round.toString, 'custom-a');
  assert.equal(round.valueOf, 'custom-b');
  assert.equal(round.constructor, 'custom-c');
});

// ---- 3c/3d. semantic-insights.mjs serializeInsight and truth-pass.mjs serializeStalenessInsight.
// COVERAGE LIMIT: both are module-private and EVERY caller is behind a judge() call —
// semantic-insights only writes from mintWithProposal/mintFindingOnly/reconcilePendingProposals,
// all inside scan()/rotate(); truth-pass only writes from runStalenessMinting, one line after a
// bulk-tier judge verdict. Neither module exposes a parse counterpart either (both read back through
// nodes.mjs parseNode). So the real source is lifted and round-tripped through parseNode, and the
// rendered YAML is asserted directly as well.
test('regression: semantic serializeInsight preserves frontmatter keys named after Object.prototype members', async () => {
  const serializeInsight = await lift('semantic-insights.mjs', {
    consts: ['INSIGHT_FIELDS'], fn: 'serializeInsight',
    caller: /const serialized = serializeInsight\(fm, body\);/, inject: { yamlDump },
  });
  const fm = {
    id: 'i1', claim: 'a claim', scope: 'cockpit', status: 'new', detector: 'd',
    toString: 'custom-a', valueOf: 'custom-b', constructor: 'custom-c', normalField: 'kept',
  };
  const text = serializeInsight(fm, 'body');
  for (const k of ['toString', 'valueOf', 'constructor', 'normalField']) {
    assert.match(text, new RegExp(`^${k}: custom-|^normalField: kept$`, 'm'), `${k} must reach the YAML`);
  }
  const round = parseNode(text, 'i1').frontmatter;
  assert.equal(round.normalField, 'kept');
  for (const k of ['toString', 'valueOf', 'constructor']) assert.ok(hasOwn(round, k), `${k} must survive`);
  assert.equal(round.toString, 'custom-a');
  assert.equal(round.valueOf, 'custom-b');
  assert.equal(round.constructor, 'custom-c');
  assert.match(text, /^---\nid: i1\nclaim: a claim\n/, 'the canonical field order still holds');
});

test('regression: serializeStalenessInsight preserves frontmatter keys named after Object.prototype members', async () => {
  const serializeStalenessInsight = await lift('truth-pass.mjs', {
    consts: ['STALENESS_INSIGHT_FIELDS'], fn: 'serializeStalenessInsight',
    caller: /const serialized = serializeStalenessInsight\(fm, body\);/, inject: { yamlDump },
  });
  const fm = {
    id: 's1', claim: 'a stale claim', scope: 'cockpit', status: 'new', detected: '2026-07-25',
    toString: 'custom-a', valueOf: 'custom-b', constructor: 'custom-c', normalField: 'kept',
  };
  const round = parseNode(serializeStalenessInsight(fm, ''), 's1').frontmatter;
  assert.equal(round.normalField, 'kept');
  for (const k of ['toString', 'valueOf', 'constructor']) assert.ok(hasOwn(round, k), `${k} must survive`);
  assert.equal(round.toString, 'custom-a');
  assert.equal(round.valueOf, 'custom-b');
  assert.equal(round.constructor, 'custom-c');
});

// ================================================================ 5. truth-pass.mjs t.delta
// BOTH PATHS, and that is the whole point of this test. `t.delta` is scope-keyed reconciler state
// that is minted on a fresh run and REHYDRATED from .reconciler/state.json on every run after that.
// A construct-only fix is DEAD: the mint site can be null-prototype while JSON.parse hands back a
// plain object on reload, and a construct-only test passes against exactly that broken version.
// (That defect was live in the first cut of this fix and was sent back; hence the reload half.)
//
// This one test also covers the three sibling scope-keyed maps in the same function: `ledgers`
// (truth-pass.mjs:573), `deltaMeta` (:591) and `report.lane` (minted at :564, assigned at :585/:621/
// :838, and asserted OWN below). `ledgers` and `deltaMeta` are DIRECT ASSIGNMENT sites, so
// `__proto__` is the only name that misbehaves there; `t.delta` is READ-MODIFY-WRITE (`let d =
// t.delta[s]` then `if (!d) d = t.delta[s] = {...}`, case B below), so per the corrected taxonomy at
// the top of this file it fails for EVERY inherited name, `__proto__` included.
// NO DOMINANCE (round 6 correction: this comment used to claim `__proto__` was the strictly stronger
// probe and made `toString` redundant, which is false). A PARTIAL repair could hand back an
// otherwise plain object that carries an OWN `__proto__` data property, and that object passes a
// `__proto__`-only case B while still resolving `toString` to the inherited function and losing the
// mint. The two names probe different halves of the same site, the inherited SETTER and the
// inherited FUNCTION READ, and neither implies the other, so case B is driven with BOTH.
// The delta bookkeeping asserted below is derived from `ledgers[s]` (its sha)
// and stored via `deltaMeta[s].d`, so all three are exercised by the same drive. Reachability is
// real, not hypothetical: truthPass takes `scopes` as a parameter and reconcile passes loadScopes()
// straight through (see the wall test above — no slug gate anywhere on that path).
const truthDeps = { guardDecision: async () => 'applied', isAlwaysLoadEligible: () => false };
const HOSTILE_SCOPE = '__proto__';
const LEDGER = '# DECISIONS\n\n### MEM-99 — a decision entry\n\nA locked decision about the probe node.\n';

async function runTruth(state, roots, scope = HOSTILE_SCOPE) {
  const pool = [{
    id: 'proto-scope-node',
    frontmatter: { id: 'proto-scope-node', title: 'T', type: 'knowledge', scope, centrality: 0.5 },
    body: 'A locked decision about the probe node.',
    prose: 'A locked decision about the probe node.',
  }];
  const audit = { added: [], modified: [], superseded: [], held: [] };
  const { truthPass } = await import('../truth-pass.mjs');
  const report = await truthPass({
    pool, scopes: [scope], state, audit, dryRun: false,
    // deps.judge overrides BOTH judge lanes (the module's documented test hook): no subprocess.
    // A clean (non-conflicting) verdict, so the node counts as judged and the sweep can COMPLETE —
    // completion is what writes doneSha/entryShas, i.e. the state the reload half then has to read.
    deps: { ...truthDeps, judge: async () => [{ id: 'proto-scope-node', conflict: false }] },
    roots, budgets: { judge: 1, delta: 1, rotation: 1, deltaNodes: 5 },
  });
  return report;
}

test('regression: a __proto__-named scope keeps its truth-pass delta state across CONSTRUCT and RELOAD', async () => {
  const roots = { cockpitRoot: resolve(TEST_MEMORY_ROOT, 'no-cockpit-here'), memoryRoot: TEST_MEMORY_ROOT };
  // both case-B probe names get a real ledger on disk: the delta lane only claims a scope that has one.
  for (const scope of [HOSTILE_SCOPE, 'toString']) {
    await mkdir(resolve(TEST_MEMORY_ROOT, 'scopes', scope), { recursive: true });
    await writeFile(resolve(TEST_MEMORY_ROOT, 'scopes', scope, 'DECISIONS.md'), LEDGER, 'utf8');
  }
  // Suppress the coldest-node staleness minter's judge call: it uses judge.mjs directly, NOT
  // deps.judge, so without this it would try to spawn a real CLI. An already-open card for this
  // node's pattern key makes runStalenessMinting `continue` before any call. (Noted as a seam: that
  // minter is the one path inside truthPass that the documented deps.judge hook does not cover.)
  await mkdir(resolve(TEST_MEMORY_ROOT, 'insights'), { recursive: true });
  await writeFile(resolve(TEST_MEMORY_ROOT, 'insights', 'open-staleness-card.md'),
    '---\nid: open-staleness-card\npattern: memory-staleness::proto-scope-node\nstatus: new\nscope: cockpit\n---\n\nx\n', 'utf8');

  // ---- CONSTRUCT: a fresh state object, exactly as a first-ever run has it.
  const fresh = { consumed: {} };
  const r1 = await runTruth(fresh, roots);
  assert.equal(r1.checked, 1, 'the hostile-scope node was actually processed');
  // OWN-property, not a read-back. `report.lane` is minted fresh each run and assigned with the same
  // unfiltered scope; the value is an OBJECT, so on a plain `{}` the write goes through the inherited
  // setter and installs that record AS report.lane's prototype, and `r1.lane['__proto__']` then reads
  // the very same record straight back, so a read-back assertion passes on the broken code
  // (Codex r3). The report is also the thing that gets enumerated and serialized, so own-ness IS the
  // property under test. Assert it on every read of `.lane` below.
  assert.ok(hasOwn(r1.lane, HOSTILE_SCOPE),
    'the hostile scope must be an OWN key of report.lane, not a write through the prototype');
  assert.equal(r1.lane[HOSTILE_SCOPE].lane, 'rotation+delta',
    'the delta lane must claim it on the first run — that is what writes t.delta[scope]. The label '
    + 'alone does not discriminate: on a plain `{}` the rotation loop has already reparented '
    + 'report.lane to its own record, so `report.lane[s] ? ...` reads that record back, truthy, and '
    + 'says "rotation+delta" too, so the hasOwn above is what discriminates.');

  // through a REAL serialization: state.json is written with JSON.stringify and read with JSON.parse.
  const persisted = JSON.stringify(fresh, null, 2);
  const saved = JSON.parse(persisted);
  assert.ok(hasOwn(saved.truth.delta, HOSTILE_SCOPE),
    'the hostile scope must be an OWN key of the persisted delta state, not a prototype write');
  assert.equal(saved.truth.delta[HOSTILE_SCOPE].doneSha, sha8(LEDGER),
    'the completed sweep must be recorded against the REAL ledger sha, which proves `ledgers` too: '
    + 'that map holds the ledger STRING, so on a plain `{}` the write is IGNORED by the inherited '
    + 'setter and the later read returns Object.prototype, which reaches sha8 and throws a TypeError '
    + 'rather than being hashed');
  assert.ok(saved.truth.delta[HOSTILE_SCOPE].entryShas,
    'deltaMeta[scope].d is what carries entryShas back here');

  // ---- RELOAD, case A: the hostile scope is ALREADY an own key of the rehydrated map, so its
  // stored sweep must be read back and the delta lane must skip the scope entirely.
  const reloaded = JSON.parse(persisted);
  const r2 = await runTruth(reloaded, roots);
  assert.ok(hasOwn(r2.lane, HOSTILE_SCOPE), 'an OWN key of report.lane on the reload run too');
  assert.equal(r2.lane[HOSTILE_SCOPE].lane, 'rotation',
    'the stored doneSha must be READ BACK on the reload path: the ledger is unchanged, so the delta '
    + 'lane must skip this scope entirely. This validates READ-BACK ONLY and passes with or without '
    + 'the fix (see case B below for why); case B is the discriminating half.');
  assert.ok(hasOwn(reloaded.truth.delta, HOSTILE_SCOPE), 'still an own key after the reload run');
  assert.equal(reloaded.truth.delta[HOSTILE_SCOPE].doneSha, sha8(LEDGER));

  // ---- RELOAD, case B: THE case a construct-only fix leaves broken, and the one a construct-only
  // test cannot see. Case A above passes even on a plain-object `t.delta`, because JSON.parse
  // creates `__proto__` as an OWN DATA PROPERTY that shadows the inherited accessor — so a map that
  // already carries the key reads back fine either way. The live defect is the FIRST WRITE of a
  // hostile scope into a REHYDRATED map: any real state.json predates that scope, `t.delta` is the
  // plain object JSON.parse returned, and the mint is guarded by a READ, `let d = t.delta[s]` then
  // `if (!d) d = t.delta[s] = {...}`. That read returns a truthy Object.prototype, so the mint never
  // fires at all: the code adopts Object.prototype AS the scope's delta record and writes `judged`,
  // `doneSha`, `sweepSha` and `entryShas` onto the shared prototype, while the scope still has no own
  // entry and vanishes from state.json, silently, every night, forever. Only normalizing t.delta ON
  // LOAD closes it, which is why the prototype-hygiene check at the end of this test is load-bearing.
  //
  // Case B is driven TWICE, once per probe name, for the reason stated in this section's header:
  // neither name dominates the other at a read-modify-write site. `__proto__` exercises the inherited
  // SETTER (broken code resolves `d` to Object.prototype itself and writes the four bookkeeping keys
  // onto the SHARED PROTOTYPE); `toString` exercises the inherited FUNCTION READ (broken code
  // resolves `d` to `Object.prototype.toString` and writes the same four keys onto that function
  // object). Both end with the scope having no own entry in the persisted map, which is what the
  // assertions catch, and both leave junk on a shared object, which is what the cleanup catches.
  //
  // The whole case-B drive sits in try/finally, and the CLEANUP is the reason (round 5, corrected in
  // round 6). If the regression ever returns, the shared objects really do acquire those four
  // properties, and the assertions below would then throw on the first one and leave them dirty for
  // every test that runs after this one in the same process, a real regression turning into a cascade
  // of unrelated, confusing failures elsewhere.
  //
  // What the cleanup GUARANTEES, stated to match what the code does (the round 5 version overstated
  // it twice): it is BASELINE-AWARE, so a watched key that already existed before this test ran is
  // not miscounted as pollution and is not disturbed; and it restores every key this drive changed
  // WHEREVER RESTORATION IS LEGALLY POSSIBLE. Configurable properties are restored by delete plus
  // defineProperty. A NON-CONFIGURABLE but WRITABLE data property is still restorable, so its
  // baseline VALUE is put back by assignment when the baseline was itself a writable data property
  // of the same enumerability. Only the cases JavaScript genuinely cannot undo are left exactly as
  // found rather than making the cleanup itself throw in this module's strict mode: non-configurable
  // non-writable data properties, non-configurable accessors, and non-configurable properties that
  // did not exist at baseline (they cannot be deleted). Every changed key is REPORTED as pollution
  // either way, restored or not. Nothing is ever deleted before its configurability is checked. A
  // returning regression therefore still FAILS the assertion after the finally rather than being
  // silently laundered.
  const PROTO_KEYS = ['judged', 'doneSha', 'sweepSha', 'entryShas'];
  const targets = [
    ['Object.prototype', Object.prototype],
    ['Object.prototype.toString', Object.prototype.toString],
  ];
  const sameDesc = (a, b) => (!a || !b
    ? a === b
    : a.value === b.value && a.get === b.get && a.set === b.set
      && a.writable === b.writable && a.enumerable === b.enumerable && a.configurable === b.configurable);
  const baseline = targets.map(([label, target]) => ({
    label, target, descs: PROTO_KEYS.map((k) => Object.getOwnPropertyDescriptor(target, k)),
  }));
  const polluted = [];
  try {
    for (const scope of [HOSTILE_SCOPE, 'toString']) {
      const legacy = JSON.parse('{"consumed":{},"truth":{"delta":{"some-other-scope":{"doneSha":null,"sweepSha":null,"judged":[]}}}}');
      assert.ok(!hasOwn(legacy.truth.delta, scope), `the fixture must NOT pre-seed the hostile key "${scope}"`);
      const r3 = await runTruth(legacy, roots, scope);
      assert.ok(hasOwn(r3.lane, scope), `an OWN key of report.lane on the legacy-state run too ("${scope}")`);
      assert.equal(r3.lane[scope].lane, 'rotation+delta', 'no stored sweep, so the delta lane claims it');
      const savedLegacy = JSON.parse(JSON.stringify(legacy));
      assert.ok(hasOwn(savedLegacy.truth.delta, scope),
        `the hostile scope "${scope}" must become an OWN key of a REHYDRATED delta map: this is the `
        + 'assignment a construct-only fix drops on the floor, and it fails for the inherited SETTER '
        + 'name and the inherited FUNCTION name alike');
      assert.equal(savedLegacy.truth.delta[scope].doneSha, sha8(LEDGER));
      assert.ok(hasOwn(savedLegacy.truth.delta, 'some-other-scope'), 'the pre-existing entry survives the normalize');
    }
  } finally {
    // unconditional: runs on the success path AND on any assertion failure above.
    for (const { label, target, descs } of baseline) {
      PROTO_KEYS.forEach((k, i) => {
        const base = descs[i];
        const now = Object.getOwnPropertyDescriptor(target, k);
        if (sameDesc(base, now)) return;                 // unchanged since the baseline: not pollution
        polluted.push(`${label}.${k}`);
        if (now && !now.configurable) {
          // Non-configurable: the property cannot be deleted or fully redefined. One sub-case is
          // still legally restorable, a WRITABLE data property whose baseline was also a writable
          // data property with the same enumerability: plain assignment puts the baseline value
          // back. Everything else (non-writable data, accessor, or a baseline shape that no longer
          // matches, including a property that did not exist at baseline and so cannot be removed)
          // is genuinely unrestorable and is left exactly as found rather than throwing in this
          // module's strict mode.
          const restorable = now.writable === true && base && 'value' in base
            && base.writable === true && base.enumerable === now.enumerable;
          if (restorable) target[k] = base.value;
          return;
        }
        if (now) delete target[k];
        if (base) Object.defineProperty(target, k, base);
      });
    }
  }
  // nothing was written onto a shared object at any point: the pre-fix reload path resolved `d` to
  // Object.prototype (for `__proto__`) or to Object.prototype.toString (for `toString`) and assigned
  // `d.judged = []` straight onto it.
  assert.deepEqual(polluted, [],
    `no shared object may be written: ${polluted.join(', ')} appeared as new or changed own properties`);
});

// ================================================================ 6. truth-eval.mjs ledgers
// REAL DRIVE, as of 2026-07-25. It used to be the one fixed site with no coverage: the module was a
// bare top-level CLI script, so importing it EXECUTED the whole eval (argv validation, process.exit,
// a dynamically imported judge adapter, batched LLM calls against the live graph). The seam is now
// the house `invokedDirectly` guard its siblings already use (projection.mjs, relevance.mjs,
// reconcile.mjs), with the CLI body in main() and the scope-keyed ledger cache exported as
// loadLedgersForItems. Importing the module now runs nothing.
//
// The site is `ledgers[it.scope] ??= await load(it.scope)`, with `it.scope` taken from node
// frontmatter. READ-MODIFY-WRITE, so per the corrected taxonomy at the top of this file it fails for
// EVERY inherited name, and both probe names fail the SAME way: the `??=` READ comes first and finds
// a non-nullish inherited value, so the operator SHORT-CIRCUITS and its right-hand side is never
// evaluated. For `__proto__`, `ledgers['__proto__']` reads Object.prototype, so `load` is never
// called, no assignment ever happens (the inherited setter is never exercised either), and
// Object.prototype itself is what flows onward AS ledgerText into
// relevantExcerpt/batchTruthPrompt. For `toString`, the read yields the inherited FUNCTION
// Object.prototype.toString, equally non-nullish, so again `load` is never called and that function
// object is handed onward as ledgerText. Both names are therefore driven.
//
// OWN-property assertions only, never a read-back: for the `__proto__` probe a read-back of a string
// value returns Object.prototype (truthy) and would pass on the broken code. `load` is stubbed, so
// the real graph is never touched and nothing here needs a network.
test('regression: truth-eval loads a ledger for scopes named __proto__ and toString', async () => {
  const { loadLedgersForItems } = await import('../truth-eval.mjs');
  for (const scope of ['__proto__', 'toString']) {
    const calls = [];
    const load = async (s) => { calls.push(s); return `# DECISIONS for ${s}\n`; };
    const items = [{ id: 'a', scope }, { id: 'b', scope }, { id: 'c', scope: 'cockpit' }];
    const ledgers = await loadLedgersForItems(items, load);

    assert.ok(hasOwn(ledgers, scope),
      `the "${scope}" scope must be an OWN key of the ledger map, not a write through the prototype`);
    assert.equal(Object.getOwnPropertyDescriptor(ledgers, scope).value, `# DECISIONS for ${scope}\n`,
      'and it must hold the REAL ledger text, which is what is fed onward as ledgerText');
    assert.ok(hasOwn(ledgers, 'cockpit'), 'an ordinary scope is unaffected');
    assert.deepEqual(calls, [scope, 'cockpit'],
      `loadLedger must actually be CALLED for "${scope}" and exactly once (the ??= is a cache): on a `
      + 'plain {} the truthy inherited value suppresses the call entirely');
  }
});

// ================================================================ 7. judge adapters MODEL_BY_TIER
// `if (!(tier in MODEL_BY_TIER)) throw` is an `in` PRESENCE test on a caller-supplied key. On the
// plain object it was, `tier: 'toString'` PASSED the guard, and `MODEL_BY_TIER['toString']` then
// yielded Object.prototype.toString — a function object — which was handed to execFile as the
// `--model` / `-m` argument value. So the guard whose entire job is to reject unknown tiers was
// bypassed by four specific strings.
//
// Offline by construction: the guard throws BEFORE ensureReconcilerHome() and before any spawn, so
// nothing is provisioned and no subprocess starts. The setup.mjs embedding guard is untouched.
//
// COVERAGE LIMIT: only the REJECT side is driven. Proving the ACCEPT side through judge() means
// passing the guard, which immediately provisions the adapter's reconciler home (the Claude adapter's
// per-uid dir under the system temp root; the Hermes adapter's ~/.cache/cockpit-reconciler, whose
// config it rewrites and whose auth.json symlink it re-points at the real one) and spawns a CLI —
// a real side effect on the developer's machine, not something a unit test may do. The accept side is therefore
// asserted on the module source, and labelled as the shape assertion it is.
const PROTO_TIERS = ['toString', 'valueOf', 'constructor', 'hasOwnProperty', 'isPrototypeOf', '__proto__'];

test('regression: judge-claude rejects a prototype-named tier and still knows its three real tiers', async () => {
  const { judge } = await import('../judge-claude.mjs');
  for (const tier of PROTO_TIERS) {
    await assert.rejects(
      // timeoutMs is deliberately tiny: if the guard ever regresses and lets the call through, this
      // fails fast on a different error instead of hanging on a real CLI spawn.
      () => judge('a prompt', { tier, json: false, timeoutMs: 1 }),
      new RegExp(`judge: unknown tier "${tier === '__proto__' ? '__proto__' : tier}"`),
      `tier "${tier}" must be rejected — it is not a real tier`,
    );
  }
  // accept side (source shape, see the limit above)
  const src = await moduleSrc('judge-claude.mjs');
  assert.match(src, /MODEL_BY_TIER = Object\.assign\(Object\.create\(null\), \{ hard: '[^']+', bulk: '[^']+', mechanical: '[^']+' \}\)/,
    'the three real tiers must still be keys of the null-prototype map');
  assert.match(src, /if \(!\(tier in MODEL_BY_TIER\)\) throw/, 'the presence-test guard is still the shape being defended');
});

test('regression: judge-hermes rejects a prototype-named tier and still knows its two real tiers', async () => {
  const { judge } = await import('../judge-hermes.mjs');
  for (const tier of PROTO_TIERS) {
    await assert.rejects(
      () => judge('a prompt', { tier, json: false, timeoutMs: 1 }),
      new RegExp(`judge: unknown tier "${tier}"`),
      `tier "${tier}" must be rejected — it is not a real tier`,
    );
  }
  const src = await moduleSrc('judge-hermes.mjs');
  assert.match(src, /MODEL_BY_TIER = Object\.assign\(Object\.create\(null\), \{ hard: '[^']+', bulk: '[^']+' \}\)/,
    'the two real tiers must still be keys of the null-prototype map');
  assert.match(src, /if \(!\(tier in MODEL_BY_TIER\)\) throw/);
});

// ================================================================ 8. the constant-lookup-table class
// Found by MECHANICAL enumeration rather than by pattern-grep (round 4): every computed member access
// (`receiver[expr]`), every `in` operator and every `for...in` head in memory-engine/ was enumerated
// with a lexer and each receiver classified, instead of searching for shapes already known to be
// broken. What that establishes is exactly that and no more: within those THREE SYNTAX CHANNELS,
// nothing was skipped. It is NOT a proof that no harmful keying site remains, because JavaScript can
// consume an untrusted key or a hostile source object with no source-level `receiver[key]` anywhere.
// Stated as the AUDIT BOUNDARY: the API mutation channels are outside what the enumeration can
// see. Those are `Reflect.set/get/defineProperty`, `Object.assign(target, hostileSource)` (which
// invokes the inherited `__proto__` setter on the target), `Object.defineProperties`,
// `Object.fromEntries`, `structuredClone` and friends. They were checked INDEPENDENTLY, by hand, and found clean
// (no unsafe production use); that is an observation about today's code, not an impossibility proof,
// so a new call to any of them with an untrusted key or a foreign source object needs the same
// scrutiny. Within the three enumerated channels, this section is the class that surfaced last,
// because these maps are not accumulators and never looked like "untrusted maps":
// they are CONSTANT lookup tables, written once as literals, and the untrusted value is the KEY used
// to read them. Same failure as judge's MODEL_BY_TIER (§7): on a plain object the four inherited
// function names read back TRUTHY, so the `if (!table[k])` guard whose whole job is to reject unknown
// keys is bypassed, and what comes back is an Object.prototype method instead of a real entry.

// ---- 8a. closure.mjs TRANSITIONS — REAL DRIVE through the CLI, keyed by argv.
test('regression: closure rejects a prototype-named verb instead of crashing on the destructure', async () => {
  for (const verb of ['toString', 'valueOf', 'constructor']) {
    // scope/id are deliberately VALID slugs, so the only thing that can stop the run is the verb
    // guard at closure.mjs:201. Pre-fix the guard passed (TRANSITIONS['toString'] is a truthy
    // inherited function) and the run died at `const [from, to] = TRANSITIONS[verb]` with a
    // not-iterable TypeError, i.e. a crash where a usage message was the contract.
    const r = await execFileP('node', [resolve(ENGINE_DIR, 'closure.mjs'), verb, 'cockpit', 'some-project'],
      { cwd: ENGINE_DIR, env: { ...process.env, COCKPIT_MEMORY_ROOT: TEST_MEMORY_ROOT } })
      .then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: e.stderr || '' }));
    assert.equal(r.code, 1, `verb "${verb}" must exit 1 through usage(), not crash`);
    assert.match(r.stderr, new RegExp(`unknown verb "${verb}"`),
      `verb "${verb}" must be named as an unknown verb`);
    assert.doesNotMatch(r.stderr, /is not iterable|TypeError/,
      'the destructure crash is exactly what the null-prototype table prevents');
  }
});

// ---- 8c. hermes-capture.mjs SESSION_VIA — WALL ASSERTION. The read sits in sessionVia(), whose only
// caller needs an open better-sqlite3 handle on a real Hermes state.db plus a matching sessions row;
// there is no seam to inject a db, and the module is a stdin-driven hook script. The consequence it
// guards: `(row && SESSION_VIA[row.source]) || null` returns a truthy inherited FUNCTION for a source
// named `toString`/`valueOf`/`constructor`, so the lookup incorrectly RESOLVES an unknown source
// instead of degrading to null like every other unknown source.
// Scoped honestly (round 5): the downstream consequence stops there. Every entry's via goes through
// capture-core.mjs `viaToken()` (capture-core.mjs:85), a strings-only whitelist
// (`typeof via === 'string' && /^[A-Za-z0-9:_-]+$/`), so an inherited function is turned into null
// before anything is staged. Nothing function-shaped ever reaches the staging header or YAML. The
// null-prototype table is still required by the sweep rule (the lookup itself is wrong, and the
// string validator is a separate defence that could be moved or narrowed), but the persisted-forgery
// consequence is NOT exercised today. MEM-38 step 2's whole point is that a via is inherited
// structurally or not at all, which is why an accidental resolve matters even when it is dropped later.
test('wall: hermes-capture SESSION_VIA is null-prototype, so an unknown source cannot inherit a via', async () => {
  const src = await moduleSrc('hermes-capture.mjs');
  assert.match(src, /const SESSION_VIA = Object\.assign\(Object\.create\(null\), \{ cli: 'hermes:cli', subagent: 'subagent' \}\);/,
    'the two real sources must still be keys of a null-prototype table');
  assert.match(src, /\(row && SESSION_VIA\[row\.source\]\) \|\| null/,
    'the truthiness read this guards is still the shape being defended');
});

// ---- 8d. dossiers.mjs argv flags — WALL ASSERTION. The site is inside the module's
// `invokedDirectly` CLI block, so it cannot be reached by importing the module, and the value a
// `--__proto__ v` flag would drop is not observable in any output the CLI prints. ASSIGNMENT site
// keyed by raw argv, so the rule applies regardless: mint it null-prototype.
test('wall: the dossiers CLI accumulates argv flags into a null-prototype map', async () => {
  const src = await moduleSrc('dossiers.mjs');
  assert.match(src, /const flags = Object\.create\(null\); const pos = \[\];/,
    'argv-keyed flag accumulator must be null-prototype');
  assert.match(src, /flags\[rest\[i\]\.slice\(2\)\] = rest\[i \+ 1\]/,
    'the argv-keyed assignment this guards is still present — if it changes, revisit the wall');
});

// keep `ownKeys` referenced for the one place it reads better than getOwnPropertyNames inline
test('sanity: the probes themselves carry the hostile names as own keys', () => {
  const built = JSON.parse('{"__proto__":1,"toString":2}');
  assert.deepEqual(ownKeys(built).sort(), ['__proto__', 'toString']);
});
