// judge-routing.test.mjs — the per-tier routing rule in judge.mjs (2026-08-15).
//
// The rule under test: with no JUDGE_ADAPTER set, the 'hard' tier goes to judge-hermes.mjs and the
// 'bulk'/'mechanical' tiers stay on judge-claude.mjs; JUDGE_ADAPTER forces one adapter for every
// tier; and a hard-tier call with Hermes unreachable FAILS with a message naming what is missing
// rather than falling back to the adapter that returns an empty result.
//
// Every probe runs in a child node process, because the router reads JUDGE_ADAPTER at import time
// and the failure probe needs a PATH with no CLI on it. No model call is ever made: the routing is
// read off MODEL_BY_TIER (which follows the same dispatch rule) and off the preflight rejection.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ENGINE_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

// Runs `script` in a child node process with `env` merged over the current one, returns stdout.
async function inChild(script, env = {}) {
  const { stdout } = await execFileP(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ENGINE_DIR,
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return stdout.trim();
}

test('routing: with no JUDGE_ADAPTER, hard runs on the Hermes adapter and bulk/mechanical on the Claude adapter', async () => {
  const out = await inChild(`
    const { MODEL_BY_TIER } = await import('./judge.mjs');
    const hermes = (await import('./judge-hermes.mjs')).MODEL_BY_TIER;
    const claude = (await import('./judge-claude.mjs')).MODEL_BY_TIER;
    process.stdout.write(JSON.stringify({
      routed: { ...MODEL_BY_TIER },
      hardIsHermes: MODEL_BY_TIER.hard === hermes.hard,
      hardIsClaude: MODEL_BY_TIER.hard === claude.hard,
      bulkIsClaude: MODEL_BY_TIER.bulk === claude.bulk,
      mechanicalIsClaude: MODEL_BY_TIER.mechanical === claude.mechanical,
    }));
  `, { JUDGE_ADAPTER: '' });
  const got = JSON.parse(out);
  assert.equal(got.hardIsHermes, true, 'the hard tier must route to the Hermes adapter');
  assert.equal(got.hardIsClaude, false, 'the hard tier must NOT route to the Claude adapter');
  assert.equal(got.bulkIsClaude, true, 'the bulk tier must stay on the Claude adapter');
  assert.equal(got.mechanicalIsClaude, true, 'the mechanical tier must stay on the Claude adapter');
});

test('routing: JUDGE_ADAPTER=hermes still forces one adapter for every tier (dream.sh contract)', async () => {
  const out = await inChild(`
    const { MODEL_BY_TIER } = await import('./judge.mjs');
    const hermes = (await import('./judge-hermes.mjs')).MODEL_BY_TIER;
    process.stdout.write(JSON.stringify({
      routed: { ...MODEL_BY_TIER },
      hermes: { ...hermes },
    }));
  `, { JUDGE_ADAPTER: 'hermes' });
  const got = JSON.parse(out);
  assert.deepEqual(got.routed, got.hermes);
  assert.equal('mechanical' in got.routed, false, 'the Hermes adapter wires no mechanical tier');
});

test('routing: JUDGE_ADAPTER=claude forces the Claude adapter for the hard tier too', async () => {
  const out = await inChild(`
    const { MODEL_BY_TIER } = await import('./judge.mjs');
    const claude = (await import('./judge-claude.mjs')).MODEL_BY_TIER;
    process.stdout.write(JSON.stringify({ routed: { ...MODEL_BY_TIER }, claude: { ...claude } }));
  `, { JUDGE_ADAPTER: 'claude' });
  const got = JSON.parse(out);
  assert.deepEqual(got.routed, got.claude);
});

test('routing: a hard-tier call with Hermes unreachable fails loudly instead of returning an empty result', async () => {
  const out = await inChild(`
    const { judge } = await import('./judge.mjs');
    let outcome;
    try {
      const r = await judge('distill this', { tier: 'hard', json: true, timeoutMs: 1000 });
      outcome = { threw: false, value: r };
    } catch (e) { outcome = { threw: true, message: e.message }; }
    process.stdout.write(JSON.stringify(outcome));
  `, { JUDGE_ADAPTER: '', PATH: '/nonexistent-for-this-test', HOME: '/nonexistent-for-this-test' });
  const got = JSON.parse(out);
  assert.equal(got.threw, true, 'an unreachable Hermes must throw, never return a value');
  assert.match(got.message, /routes through the Hermes adapter/);
  assert.match(got.message, /hermes` binary is not on PATH/);
  assert.match(got.message, /Codex login store/);
  assert.match(got.message, /JUDGE_ADAPTER=claude/);
  // The point of the rule: no silent zero, and no quiet swap to the adapter that produces one.
  assert.doesNotMatch(got.message, /spawn claude/);
});

test('routing: an unknown tier is still rejected', async () => {
  const out = await inChild(`
    const { judge } = await import('./judge.mjs');
    try { await judge('p', { tier: 'toString', json: false }); process.stdout.write('no-throw'); }
    catch (e) { process.stdout.write(e.message); }
  `, { JUDGE_ADAPTER: '' });
  assert.match(out, /judge: unknown tier "toString"/);
});
