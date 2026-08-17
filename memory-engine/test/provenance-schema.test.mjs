// provenance-schema.test.mjs — MEM-38 step 3: the node schema (provenance / provenance_via /
// volatility / ratified) and the tier derivation behind it.
//
// Everything is asserted through the REAL write path (applyConsolidation → stageNew/stageUpdate),
// because deriveProvenance/deriveVolatility are internal to reconcile.mjs and because the thing that
// matters is what lands in frontmatter, not what a helper returns.
//
// Two properties here are silent failures if broken, so they get their own assertions:
//   1. `ratified` is NEVER written by mint or update — its PRESENCE is the graduation gate (step 5),
//      so a stray write would graduate a rule nobody ratified;
//   2. an unrecognised channel token fails CLOSED to "no channel" rather than mapping to a tier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, makeProposal, engine } from './fixtures.mjs';

const newAudit = () => ({ added: [], modified: [], superseded: [], held: [], autoApplied: [], unmentioned: [], reflectSkipped: [], clamped: [] });

// mint one node from one proposal and hand back its frontmatter.
async function mint(proposal, { centrality = 0.5 } = {}) {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const pool = [];
  await applyConsolidation([{ action: 'new', backing: [proposal.idx ?? 0], centrality, cluster: proposal.cluster }],
    [proposal], [], 'cockpit', pool, new Set(), newAudit());
  assert.equal(pool.length, 1, 'the mint should have reached the pool');
  return pool[0].frontmatter;
}

// run an update against an already-existing node and hand back its (mutated) frontmatter.
async function update(existing, proposal) {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const pool = [existing];
  await applyConsolidation([{ action: 'update', id: existing.id, backing: [proposal.idx ?? 0], centrality: existing.frontmatter.centrality, cluster: 'unclustered' }],
    [proposal], [existing], 'cockpit', pool, new Set(), newAudit());
  return existing.frontmatter;
}

test('authored: a typed human turn (either brain) mints provenance authored with its exact channel', async () => {
  const claude = await mint(makeProposal({ turns: [{ text: 'Decided: ship it.', via: 'claude:typed' }] }));
  assert.equal(claude.provenance, 'authored');
  assert.equal(claude.provenance_via, 'claude:typed');

  const hermes = await mint(makeProposal({ brain: 'hermes', turns: [{ text: 'Operator said so.', via: 'hermes:cli' }] }));
  assert.equal(hermes.provenance, 'authored');
  assert.equal(hermes.provenance_via, 'hermes:cli');
});

test('relayed: a subagent turn is a machine prompt carrying human intent, channel-unverified', async () => {
  const fm = await mint(makeProposal({ turns: [{ text: 'A sidechain prompt.', via: 'subagent' }] }));
  assert.equal(fm.provenance, 'relayed');
  assert.equal(fm.provenance_via, 'subagent');
});

test('relayed: a source-backed mint is somebody words, curated not spoken — via distill', async () => {
  const fm = await mint(makeProposal({ isSource: true, turns: [{ text: 'Document body.', via: null }] }));
  assert.equal(fm.provenance, 'relayed');
  assert.equal(fm.provenance_via, 'distill');
  assert.equal(fm.claim, 'reported');                     // MEM-37 leg 3, unchanged by step 3
});

test('inferred: claim inference beats any channel — a derived claim is nobody words', async () => {
  // no source_turns → no resolvable citation → claim inference, even though the turn IS stamped.
  const fm = await mint(makeProposal({ source_turns: [], turns: [{ text: 'Typed but unreferenced.', via: 'claude:typed' }] }));
  assert.equal(fm.claim, 'inference');
  assert.equal(fm.provenance, 'inferred');
  assert.ok(!('provenance_via' in fm), 'an inferred node carries no channel');

  // and the interaction the rung actually defends. SYNTHETIC BY CONSTRUCTION (Codex round 2): today's
  // buildDigest filters empty-text turns out of turnIndex, so this input cannot arrive through the
  // real reconciler path. It pins the invariant, not the plumbing: parseStaging does produce
  // text '' with a live `via` for a header with an empty body, and only that one filter in another
  // module keeps it out, so the rung is what holds if the filter ever moves. The channel loop would find
  // `claude:typed` here — the claim rung has to win over it, or the node would mint `authored`
  // while carrying no citation at all.
  const stamped = await mint(makeProposal({ turns: [{ text: '', via: 'claude:typed' }, { text: '', via: 'subagent' }] }));
  assert.ok(!('citation' in stamped), 'no citable text → no citation');
  assert.equal(stamped.claim, 'inference');
  assert.equal(stamped.provenance, 'inferred');
  assert.ok(!('provenance_via' in stamped));
});

test('inferred: no channel on any backing turn and not source-backed — absence is meaningful, not an error', async () => {
  const fm = await mint(makeProposal({ turns: [{ text: 'An assistant turn.', via: null }, { text: 'A hook injection.', via: undefined }] }));
  assert.equal(fm.claim, 'fact');                          // it IS cited; only the channel is missing
  assert.equal(fm.provenance, 'inferred');
  assert.ok(!('provenance_via' in fm));
});

test('strongest wins across mixed channels on the backing turns', async () => {
  const fm = await mint(makeProposal({ turns: [
    { text: 'A sidechain prompt.', via: 'subagent' },
    { text: 'Then Arnaldo typed.', via: 'claude:typed' },
    { text: 'An assistant reply.', via: null },
  ] }));
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'claude:typed');

  // the TIER is order-independent: the weaker channel first or last must not change it. (Only a
  // same-tier tie is order-sensitive, and then just in which sibling `provenance_via` is recorded.)
  const reversed = await mint(makeProposal({ turns: [
    { text: 'Arnaldo typed first.', via: 'claude:typed' },
    { text: 'Then a sidechain prompt.', via: 'subagent' },
  ] }));
  assert.equal(reversed.provenance_via, 'claude:typed');
});

test('an unrecognised channel token falls closed to no channel and never throws', async () => {
  const fm = await mint(makeProposal({ turns: [{ text: 'A turn from a future channel.', via: 'slack:dm' }] }));
  assert.equal(fm.provenance, 'inferred');
  assert.ok(!('provenance_via' in fm));

  // and it does not shadow a real channel on a sibling turn.
  const mixed = await mint(makeProposal({ turns: [
    { text: 'A turn from a future channel.', via: 'slack:dm' },
    { text: 'A real typed turn.', via: 'claude:typed' },
  ] }));
  assert.equal(mixed.provenance, 'authored');
});

test('stageUpdate folds provenance stronger-wins: authored survives a relayed update, via intact', async () => {
  const existing = makeNode({ id: 'authored-rule', citation: 'stg:sessions/old:deadbeef', provenance: 'authored', provenance_via: 'claude:typed', volatility: 'operational' });
  const fm = await update(existing, makeProposal({ turns: [{ text: 'A later sidechain touch.', via: 'subagent' }] }));
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'claude:typed');
});

test('stageUpdate: a node with no provenance yet simply takes the derived one', async () => {
  const existing = makeNode({ id: 'legacy-node', citation: 'stg:sessions/old:deadbeef' });
  assert.ok(!('provenance' in existing.frontmatter));
  const fm = await update(existing, makeProposal({ turns: [{ text: 'Arnaldo typed this.', via: 'claude:typed' }] }));
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'claude:typed');
});

// same as update(), but the surviving node also absorbs `dups` — the absorbed nodes' own provenance
// is part of the fold, so a dup's stronger tier is not lost with the dup (MEM-38 step 3).
async function updateAbsorbing(existing, dups, proposal) {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const pool = [existing, ...dups];
  await applyConsolidation([{ action: 'update', id: existing.id, backing: [proposal.idx ?? 0], centrality: existing.frontmatter.centrality, cluster: 'unclustered', supersedes: dups.map((d) => d.id) }],
    [proposal], [existing, ...dups], 'cockpit', pool, new Set(), newAudit());
  return existing.frontmatter;
}

test('stageUpdate: an absorbed dup carries its stronger tier into the survivor, via and all', async () => {
  const existing = makeNode({ id: 'weak-survivor', citation: 'stg:sessions/old:deadbeef', provenance: 'inferred' });
  const dup = makeNode({ id: 'authored-dup', citation: 'stg:sessions/dup:cafebabe', provenance: 'authored', provenance_via: 'hermes:telegram' });
  const fm = await updateAbsorbing(existing, [dup], makeProposal({ source_turns: [], turns: [{ text: 'Unreferenced.', via: 'claude:typed' }] }));
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'hermes:telegram');
});

test('stageUpdate: absorbing a weaker dup leaves the survivor untouched, its own via intact', async () => {
  const existing = makeNode({ id: 'authored-survivor', citation: 'stg:sessions/old:deadbeef', provenance: 'authored', provenance_via: 'claude:typed' });
  const dup = makeNode({ id: 'relayed-dup', citation: 'stg:sessions/dup:cafebabe', provenance: 'relayed', provenance_via: 'subagent' });
  const fm = await updateAbsorbing(existing, [dup], makeProposal({ turns: [{ text: 'A sidechain touch.', via: 'subagent' }] }));
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'claude:typed');
});

test('stageUpdate: an off-ladder provenance on an absorbed dup never wins and never throws', async () => {
  const existing = makeNode({ id: 'relayed-survivor', citation: 'stg:sessions/old:deadbeef', provenance: 'relayed', provenance_via: 'distill' });
  const dup = makeNode({ id: 'bogus-dup', citation: 'stg:sessions/dup:cafebabe', provenance: 'bogus', provenance_via: 'slack:dm' });
  const fm = await updateAbsorbing(existing, [dup], makeProposal({ source_turns: [], turns: [{ text: 'Unreferenced.', via: 'claude:typed' }] }));
  assert.equal(fm.provenance, 'relayed');
  assert.equal(fm.provenance_via, 'distill');
});

test('stageUpdate: the surviving via always belongs to the winning tier, never a losing candidate', async () => {
  // the survivor holds the only via, but an absorbed dup carries a STRONGER via-less tier: the tier
  // must move up and the stale via must go, not survive attached to a tier it never described.
  const existing = makeNode({ id: 'via-only-survivor', citation: 'stg:sessions/old:deadbeef', provenance: 'relayed', provenance_via: 'subagent' });
  const dup = makeNode({ id: 'authored-no-via-dup', citation: 'stg:sessions/dup:cafebabe', provenance: 'authored' });
  const fm = await updateAbsorbing(existing, [dup], makeProposal({ source_turns: [], turns: [{ text: 'Unreferenced.', via: 'claude:typed' }] }));
  assert.equal(fm.provenance, 'authored');
  assert.ok(!('provenance_via' in fm), 'a losing candidate must not leave its via behind');
});

test('neither mint nor update ever writes `ratified` — its presence is the graduation gate', async () => {
  const minted = await mint(makeProposal({ turns: [{ text: 'Ratify nothing.', via: 'claude:typed' }] }));
  assert.ok(!('ratified' in minted));

  const existing = makeNode({ id: 'untouched-ratified', citation: 'stg:sessions/old:deadbeef' });
  const fm = await update(existing, makeProposal({ turns: [{ text: 'A metadata update.', via: 'claude:typed' }] }));
  assert.ok(!('ratified' in fm));
});

test('volatility: behavioral → reference, src: citation → reference, ordinary stg: knowledge → operational', async () => {
  const doctrine = await mint(makeProposal({ type: 'identity', turns: [{ text: 'A rule Arnaldo typed.', via: 'claude:typed' }] }));
  assert.equal(doctrine.volatility, 'reference');

  const document = await mint(makeProposal({ isSource: true, turns: [{ text: 'Document body.', via: null }] }));
  assert.equal(document.volatility, 'reference');
  assert.ok(String(document.citation).startsWith('src:'));

  const ordinary = await mint(makeProposal({ turns: [{ text: 'Conversation-derived knowledge.', via: 'claude:typed' }] }));
  assert.equal(ordinary.volatility, 'operational');

  // update does not churn an existing value, and fills in an absent one.
  const kept = makeNode({ id: 'has-volatility', citation: 'stg:sessions/old:deadbeef', volatility: 'reference' });
  assert.equal((await update(kept, makeProposal({ turns: [{ text: 'touch', via: 'claude:typed' }] }))).volatility, 'reference');
  const filled = makeNode({ id: 'no-volatility', citation: 'stg:sessions/old:deadbeef' });
  assert.equal((await update(filled, makeProposal({ turns: [{ text: 'touch', via: 'claude:typed' }] }))).volatility, 'operational');
});

test('round trip: the four fields sit in canonical FIELD_ORDER position, undefined ones drop, schema_version is 2', async () => {
  const fm = await mint(makeProposal({ turns: [{ text: 'Round-trip me.', via: 'claude:typed' }] }));
  assert.equal(fm.schema_version, 2);
  assert.equal(engine.SCHEMA_VERSION, 2);

  const text = engine.serializeNode({ id: fm.id, frontmatter: fm, body: 'Prose.' });
  const keys = engine.parseNode(text, fm.id).frontmatter;
  const order = Object.keys(keys);
  assert.deepEqual(order.slice(order.indexOf('source'), order.indexOf('centrality')),
    ['source', 'provenance', 'provenance_via', 'volatility']);
  assert.equal(keys.provenance, 'authored');
  assert.equal(keys.provenance_via, 'claude:typed');
  assert.equal(keys.volatility, 'operational');
  assert.ok(!('ratified' in keys));

  // an inferred node drops provenance_via entirely rather than serializing an empty key.
  const inferred = await mint(makeProposal({ source_turns: [], turns: [{ text: 'Unreferenced.', via: 'claude:typed' }] }));
  const rt = engine.parseNode(engine.serializeNode({ id: inferred.id, frontmatter: inferred, body: 'Prose.' }), inferred.id).frontmatter;
  assert.equal(rt.provenance, 'inferred');
  assert.ok(!('provenance_via' in rt));
});

// ---- untrusted keys (Codex review 2026-07-25) ----
// `via` reaches CHANNEL_TIER straight off a staging header (capture-core's RE_VIA whitelist admits
// every one of these), and `provenance` reaches TIER_RANK straight off a node on disk. On plain
// object literals they resolved truthy through Object.prototype: the mint wrote a FUNCTION into
// frontmatter (serializeNode then threw mid-write, aborting the nightly) and the fold could never
// displace it, because TIER_RANK[<function>] > 3 is false. Both maps are null-prototype now.
const PROTO_KEYS = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

test('a prototype-named channel token is unrecognised like any other, and never lands in frontmatter', async () => {
  for (const via of PROTO_KEYS) {
    const fm = await mint(makeProposal({ turns: [{ text: 'A poisoned stamp.', via }] }));
    assert.equal(fm.claim, 'fact', `${via}: the turn is still citable`);
    assert.equal(fm.provenance, 'inferred', `${via} must not resolve to a tier`);
    assert.ok(!('provenance_via' in fm), `${via} must not be recorded as a channel`);
    // and it must not shadow a real channel on a sibling turn (the sticky half of the bug).
    const mixed = await mint(makeProposal({ turns: [{ text: 'Poisoned.', via }, { text: 'Really typed.', via: 'claude:typed' }] }));
    assert.equal(mixed.provenance, 'authored', `${via} must not block a real channel`);
    assert.equal(mixed.provenance_via, 'claude:typed');
  }
});

test('a prototype-named provenance on disk is off-ladder: it is skipped, and the derived tier wins', async () => {
  for (const bogus of PROTO_KEYS) {
    const existing = makeNode({ id: `poisoned-${bogus.replace(/\W/g, '')}`, citation: 'stg:sessions/old:deadbeef', provenance: bogus });
    const fm = await update(existing, makeProposal({ turns: [{ text: 'Arnaldo typed this.', via: 'claude:typed' }] }));
    assert.equal(fm.provenance, 'authored', `${bogus} must not survive the fold`);
    assert.equal(fm.provenance_via, 'claude:typed');
  }
  // same through the absorb leg: a poisoned dup must not win, and must not block a real dup either.
  const existing = makeNode({ id: 'poisoned-absorb-survivor', citation: 'stg:sessions/old:deadbeef', provenance: 'relayed', provenance_via: 'subagent' });
  const dup = makeNode({ id: 'poisoned-dup', citation: 'stg:sessions/dup:cafebabe', provenance: 'constructor', provenance_via: 'claude:typed' });
  const fm = await updateAbsorbing(existing, [dup], makeProposal({ source_turns: [], turns: [{ text: 'Unreferenced.', via: 'claude:typed' }] }));
  assert.equal(fm.provenance, 'relayed');
  assert.equal(fm.provenance_via, 'subagent');
});

test('every derived node survives the real serialization write path, poisoned inputs included', async () => {
  // the write loop serializes what staging produced; a non-string provenance throws inside yamlDump
  // and takes the whole nightly with it, which is exactly why the bug above was invisible to tests
  // that only ever serialized a hand-built clean node.
  for (const via of [...PROTO_KEYS, 'claude:typed', 'subagent', 'slack:dm', null]) {
    const fm = await mint(makeProposal({ turns: [{ text: 'Write me to disk.', via }] }));
    assert.equal(typeof fm.provenance, 'string', `${via}: provenance must be a string`);
    const text = engine.serializeNode({ id: fm.id, frontmatter: fm, body: 'Prose.' });
    const rt = engine.parseNode(text, fm.id).frontmatter;
    assert.equal(rt.provenance, fm.provenance, `${via}: provenance must round-trip`);
    assert.equal(rt.provenance_via ?? null, fm.provenance_via ?? null, `${via}: via must round-trip`);
    assert.equal(rt.schema_version, 2);
  }
});

// ---- multi-proposal backing ----
// every test above mints from exactly ONE proposal, so deriveProvenance's OUTER loop and the
// `backing.some(isSource)` rung never see a mixed set (Codex review 2026-07-25).
async function mintFrom(proposals) {
  const { applyConsolidation } = await import('../reconcile.mjs');
  const pool = [];
  await applyConsolidation([{ action: 'new', backing: proposals.map((p) => p.idx), centrality: 0.5, cluster: 'unclustered' }],
    proposals, [], 'cockpit', pool, new Set(), newAudit());
  assert.equal(pool.length, 1, 'the mint should have reached the pool');
  return pool[0].frontmatter;
}

test('mixed backing: the strongest channel across DIFFERENT proposals wins, not just within one', async () => {
  const fm = await mintFrom([
    makeProposal({ idx: 0, turns: [{ text: 'An assistant reply.', via: null }] }),
    makeProposal({ idx: 1, anchor: 'sessions/2026-07-24', turns: [{ text: 'Arnaldo typed this.', via: 'claude:typed' }] }),
  ]);
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'claude:typed');

  // and weaker-then-stronger across proposals in the other order.
  const reversed = await mintFrom([
    makeProposal({ idx: 0, turns: [{ text: 'A sidechain prompt.', via: 'subagent' }] }),
    makeProposal({ idx: 1, anchor: 'sessions/2026-07-24', turns: [{ text: 'Arnaldo typed this.', via: 'claude:typed' }] }),
  ]);
  assert.equal(reversed.provenance, 'authored');
  assert.equal(reversed.provenance_via, 'claude:typed');
});

test('mixed backing: an unstamped conversation plus a source falls through to the distill rung', async () => {
  const fm = await mintFrom([
    makeProposal({ idx: 0, turns: [{ text: 'An assistant reply.', via: null }] }),
    makeProposal({ idx: 1, isSource: true, anchor: 'sources/a-book', turns: [{ text: 'Document body.', via: null }] }),
  ]);
  assert.equal(fm.provenance, 'relayed');
  assert.equal(fm.provenance_via, 'distill');
  assert.equal(fm.type, 'knowledge', 'source backing clamps the mint to the library pool');
});

test('mixed backing: a stamped conversation turn outranks the source distill rung', async () => {
  const fm = await mintFrom([
    makeProposal({ idx: 0, turns: [{ text: 'Arnaldo typed this.', via: 'claude:typed' }] }),
    makeProposal({ idx: 1, isSource: true, anchor: 'sources/a-book', turns: [{ text: 'Document body.', via: null }] }),
  ]);
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'claude:typed');
});

// ---- the fold rising ----
test('stageUpdate: a relayed node RISES to authored when the update is backed by a typed turn', async () => {
  const existing = makeNode({ id: 'rising-node', citation: 'stg:sessions/old:deadbeef', provenance: 'relayed', provenance_via: 'subagent', volatility: 'operational' });
  const fm = await update(existing, makeProposal({ turns: [{ text: 'Arnaldo typed this.', via: 'claude:typed' }] }));
  assert.equal(fm.provenance, 'authored');
  assert.equal(fm.provenance_via, 'claude:typed');
});

test('stageUpdate stamps the CURRENT schema_version — it writes the whole v2 field set', async () => {
  const existing = makeNode({ id: 'v1-node', citation: 'stg:sessions/old:deadbeef', schema_version: 1 });
  const fm = await update(existing, makeProposal({ turns: [{ text: 'A metadata update.', via: 'claude:typed' }] }));
  assert.equal(fm.schema_version, engine.SCHEMA_VERSION);

  // including the absorb leg, and a node that carried no stamp at all.
  const survivor = makeNode({ id: 'unstamped-survivor', citation: 'stg:sessions/old:deadbeef' });
  assert.ok(!('schema_version' in survivor.frontmatter));
  const dup = makeNode({ id: 'unstamped-dup', citation: 'stg:sessions/dup:cafebabe' });
  const folded = await updateAbsorbing(survivor, [dup], makeProposal({ turns: [{ text: 'Touch.', via: 'claude:typed' }] }));
  assert.equal(folded.schema_version, engine.SCHEMA_VERSION);
});

test('the absorb path never writes `ratified` either — not on the survivor, not on the dup', async () => {
  const existing = makeNode({ id: 'absorb-survivor-ratified', citation: 'stg:sessions/old:deadbeef', provenance: 'relayed', provenance_via: 'subagent' });
  const dup = makeNode({ id: 'absorb-dup-ratified', citation: 'stg:sessions/dup:cafebabe', provenance: 'authored', provenance_via: 'claude:typed' });
  const fm = await updateAbsorbing(existing, [dup], makeProposal({ turns: [{ text: 'Arnaldo typed this.', via: 'claude:typed' }] }));
  assert.ok(!('ratified' in fm), 'the survivor must not be graduated by an absorb');
  assert.ok(!('ratified' in dup.frontmatter), 'the absorbed dup must not be graduated on its way out');
  assert.ok(dup.frontmatter.superseded, 'the dup should have been marked not-current');
});
