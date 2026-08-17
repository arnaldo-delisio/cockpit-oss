#!/usr/bin/env node
// truth-eval.mjs — batch-size eval harness for the truth pass's batched judge (MEM-37 tuning tool).
//
// Standalone CLI, read-only against the graph: it NEVER writes frontmatter or any node file; it only
// reports. It exercises the SAME batched judge path as truth-pass.mjs (batchTruthPrompt +
// verdictMechanicallyConfirmed) against the live ledger, over a labeled fixtures set, at each
// requested batch size, so BATCH_SIZE / COCKPIT_TRUTH_BATCH can be tuned on evidence.
//
// Usage:
//   node truth-eval.mjs --batch 8,25,50,100 [--fixtures <path>] [--adapter claude|hermes]
//
// Fixtures: JSON array of { id, label: "wrong" | "clean" | "out-of-contract" } (default:
// ./truth-eval-fixtures.json). "out-of-contract" fixtures are wrong per a prior scan but carry no
// contradicting ledger text — judge-uncatchable by design; skipped from caught/missed scoring and
// reported on their own line. Per batch size it reports:
//   caught          wrong nodes with a mechanically-confirmed conflict verdict
//   missed          wrong nodes not confirmed (no verdict, no conflict, or mechanical reject)
//   falsePositives  clean nodes flagged AND mechanically confirmed
//   outOfContract   out-of-contract nodes (excluded from the scores above; flagged ones noted)
//   parseFailures   judge calls whose response was not a JSON array
//   calls           judge calls used

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPool } from './nodes.mjs';
import {
  extractClaims, runT1, loadLedger, relevantExcerpt,
  batchTruthPrompt, verdictMechanicallyConfirmed,
} from './truth-pass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_EXCERPT_CHARS = 14_000;   // mirror truth-pass.mjs
const JUDGE_TIMEOUT_MS = 120_000;

// Scope-keyed ledger cache, extracted so it has a seam the untrusted-key regression can drive for
// real. `??=` is a READ-MODIFY-WRITE, so on a plain `{}` the read returns a truthy inherited value
// for EVERY Object.prototype name (`__proto__`, `toString`, ...), the load is skipped, and that
// value is fed onward as ledgerText. `it.scope` comes from node frontmatter, i.e. untrusted.
export async function loadLedgersForItems(items, load = loadLedger) {
  const ledgers = Object.create(null);
  for (const it of items) ledgers[it.scope] ??= await load(it.scope);
  return ledgers;
}

async function main() {
  // --- args ---
  const argv = process.argv.slice(2);
  let batchArg = null, fixturesPath = resolve(HERE, 'truth-eval-fixtures.json'), verbose = false, samples = 1, adapter = 'claude';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--batch') batchArg = argv[++i];
    else if (argv[i] === '--fixtures') fixturesPath = resolve(argv[++i]);
    else if (argv[i] === '--verbose') verbose = true;
    else if (argv[i] === '--samples') samples = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--adapter') adapter = argv[++i];
  }
  if (!batchArg) { console.error('usage: node truth-eval.mjs --batch 8,25,50,100 [--fixtures <path>] [--adapter claude|hermes]'); process.exit(2); }
  if (adapter !== 'claude' && adapter !== 'hermes') { console.error(`truth-eval: unknown adapter "${adapter}" (claude|hermes)`); process.exit(2); }
  // both families stay testable: sweeper = hermes (gpt-5.5), confirmer = claude (shipping split, 2026-07-21).
  const { judge } = await import(adapter === 'hermes' ? './judge-hermes.mjs' : './judge-claude.mjs');
  const batchSizes = batchArg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (!batchSizes.length) { console.error('truth-eval: no valid batch sizes in --batch'); process.exit(2); }

  // --- fixtures + node resolution (read-only) ---
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  const pool = await loadPool();
  const byId = new Map(pool.map((n) => [n.id, n]));
  const items = [];
  for (const f of fixtures) {
    const node = byId.get(f.id);
    if (!node) { console.error(`truth-eval: fixture [[${f.id}]] not found in the graph; skipping.`); continue; }
    if (f.label !== 'wrong' && f.label !== 'clean' && f.label !== 'out-of-contract') { console.error(`truth-eval: fixture [[${f.id}]] has invalid label "${f.label}"; skipping.`); continue; }
    items.push({ id: f.id, label: f.label, node, scope: node.frontmatter.scope });
  }
  if (!items.length) { console.error('truth-eval: no resolvable fixtures.'); process.exit(1); }

  // T1 once per node (deterministic, identical across batch sizes).
  for (const it of items) it.t1 = await runT1(extractClaims(it.node.prose));
  const ledgers = await loadLedgersForItems(items);

  // --- eval loop ---
  console.log(`truth-eval: ${items.length} fixture node(s) (${items.filter((i) => i.label === 'wrong').length} wrong, ${items.filter((i) => i.label === 'clean').length} clean, ${items.filter((i) => i.label === 'out-of-contract').length} out-of-contract) · batch sizes ${batchSizes.join(', ')} · adapter ${adapter}`);
  for (const size of batchSizes) {
    const r = { caught: [], missed: [], falsePositives: [], outOfContract: [], parseFailures: 0, calls: 0 };
    const byScope = new Map();
    for (const it of items) { if (!byScope.has(it.scope)) byScope.set(it.scope, []); byScope.get(it.scope).push(it); }
    for (const [scope, scopeItems] of byScope) {
      const ledgerText = ledgers[scope];
      if (!ledgerText) { console.error(`truth-eval: no ledger for scope "${scope}"; its ${scopeItems.length} fixture(s) count as missed/clean-pass.`); for (const it of scopeItems) if (it.label === 'wrong') r.missed.push(it.id); continue; }
      // entry-grouped batching: cluster nodes by their top-overlap ledger entry so batch-mates share
      // the ledger context that matters and the shared excerpt stays precise (eval finding 2026-07-21:
      // arbitrary-composition batches diluted the excerpt and dropped subtle supersession-note cases).
      // NOTE: shipping config is batch 1 (single-node calls, eval-locked 2026-07-21); at batch 1 this
      // grouping is a no-op, kept only so larger batch sizes stay measurable.
      const withKey = scopeItems.map((it) => {
        const { excerpt: own } = relevantExcerpt(it.node.prose, ledgerText, 4_000);
        const key = own ? own.slice(0, own.indexOf('\n')) : '(none)';
        return { it, key };
      });
      withKey.sort((a, b) => a.key.localeCompare(b.key));
      const ordered = withKey.map((x) => x.it);
      for (let i = 0; i < ordered.length; i += size) {
        const batch = ordered.slice(i, i + size);
        const combined = batch.map((it) => it.node.prose).join('\n');
        const { excerpt } = relevantExcerpt(combined, ledgerText, LEDGER_EXCERPT_CHARS);
        // union of confirmed conflicts across samples: a conflict found in ANY sample counts
        // (counteracts stochastic misses; false positives stay fenced by the mechanical legs).
        const vById = new Map();
        for (let s = 0; s < samples; s++) {
          r.calls++;
          let verdicts;
          try { verdicts = await judge(batchTruthPrompt(scope, batch, excerpt), { tier: 'hard', json: true, timeoutMs: JUDGE_TIMEOUT_MS }); }
          catch (e) { console.error(`truth-eval: judge call failed (${e.message}); sample skipped.`); r.parseFailures++; verdicts = []; }
          if (!Array.isArray(verdicts)) { r.parseFailures++; verdicts = []; }
          for (const v of verdicts) {
            const id = v && String(v.id);
            if (!id) continue;
            if (!vById.has(id) || (v.conflict && !vById.get(id).conflict)) vById.set(id, v);
          }
        }
        for (const it of batch) {
          const v = vById.get(it.id);   // ids not in the batch are ignored by construction of this lookup
          const confirmed = v ? verdictMechanicallyConfirmed(v, ledgerText) : false;
          if (verbose && it.label === 'wrong' && !confirmed) {
            const why = !v ? 'no-verdict-for-id' : !v.conflict ? 'judge-said-no-conflict'
              : `mechanical-reject (entry=${v.entry_id ?? '?'} quote=${JSON.stringify(String(v.quote ?? '').slice(0, 90))})`;
            console.log(`  [miss] ${it.id}: ${why}`);
          }
          if (it.label === 'wrong') (confirmed ? r.caught : r.missed).push(it.id);
          else if (it.label === 'out-of-contract') r.outOfContract.push(confirmed ? `${it.id} (flagged!)` : it.id);
          else if (confirmed) r.falsePositives.push(it.id);
        }
      }
    }
    console.log(`\nbatch=${size}: caught ${r.caught.length}, missed ${r.missed.length}, falsePositives ${r.falsePositives.length}, parseFailures ${r.parseFailures}, calls ${r.calls}`);
    if (r.caught.length) console.log(`  caught: ${r.caught.join(', ')}`);
    if (r.missed.length) console.log(`  missed: ${r.missed.join(', ')}`);
    if (r.falsePositives.length) console.log(`  falsePositives: ${r.falsePositives.join(', ')}`);
    if (r.outOfContract.length) console.log(`  outOfContract (not scored): ${r.outOfContract.join(', ')}`);
  }
}

// Run ONLY when invoked directly — importing this module must never run the eval (house pattern,
// as in projection.mjs / relevance.mjs / reconcile.mjs).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
