#!/usr/bin/env node
// board.mjs — the read-time, ephemeral attention view (WORK-1/ATT-1, Lane B brick #3).
//
//   node board.mjs [--scope <scope>]
//
// Reads Project objects + the decision-log; NEVER writes either (ATT-1's hard wall: Board -> Projects
// is a forbidden flow, and Board -> Memory likewise). Regenerated on demand — nothing here is
// committed, cached, or persisted. Scope filter is optional; omitted, it reads the whole memory root
// (already wall-isolated per MEM-32 — a confidential root's board can only ever see its own root).
//
// Lenses (ATT-1's exact content scope): active · waiting · blocked · newly-surfaced · deferral-expired.
// Fully suppressed (printed nowhere): the latest decision-log entry for a project is an unexpired
// `defer` or a `dismiss` — UNLESS the project's `last_understanding_change` is newer than the entry's
// timestamp, in which case the entry is stale (it was a decision about a state that no longer
// exists) and is ignored entirely, reclassifying the project fresh. This is the anti-nag mechanism;
// it is read-only logic, computed here every run, never written back anywhere.
//
// The 5-lens computation itself lives in lenses.mjs (extracted for ATT-2's dashboard, so CLI and
// dashboard render ONE computation) — this file is now only the CLI rendering of it.

import { computeBoard, LENS_ORDER, today } from './lenses.mjs';
import { countOpenInsights } from './mechanical-insights.mjs';

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null; };
  const scopeFilter = flag('scope');

  const groups = await computeBoard({ scopeFilter });

  console.log(`=== BOARD${scopeFilter ? ` (scope: ${scopeFilter})` : ''} — ${today()} ===`);
  for (const lens of LENS_ORDER) {
    const items = groups[lens];
    console.log(`\n${lens} (${items.length})`);
    for (const { p, detail } of items) {
      const luc = p.frontmatter.last_understanding_change;
      const staleDays = luc ? Math.floor((Date.now() - new Date(luc).getTime()) / 86_400_000) : null;
      const bits = [staleDays != null ? `${staleDays}d since last understanding-change` : null, detail].filter(Boolean);
      console.log(`  - ${p.frontmatter.id} [${p.scope}]${bits.length ? ` — ${bits.join(' — ')}` : ''}`);
    }
  }

  // Footer only (DESIGN §6a.8): a plain count, a separate read path outside the 5-lens computation
  // above, which stays byte-unchanged — folding insights into a lens would violate ATT-1's own
  // "one object, one question" rule.
  const openInsights = await countOpenInsights();
  console.log(`\n${openInsights} open insight${openInsights === 1 ? '' : 's'} → node mechanical-insights.mjs list`);
}

main().catch((e) => { console.error('board failed:', e.message); process.exit(1); });
