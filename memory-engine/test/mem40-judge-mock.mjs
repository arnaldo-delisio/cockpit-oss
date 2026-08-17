// mem40-judge-mock.mjs — deterministic offline judge() for the MEM-40 tests
// (source-sha-contradiction.test.mjs, driven through step9-reconcile-driver.mjs). Content-routed
// like step9-judge-mock.mjs (never call-order-indexed: the fragmentation insight path fires
// unawaited background judge() calls that race the main thread). Two additions over step9's mock:
//
// 1. Every prompt is APPENDED as a JSON line to MEM40_PROMPT_LOG, so the calling test can assert
//    what the distiller was actually shown (the CONTRADICTION OVERRIDE block, the EXISTING NODES
//    cap/truncation) and which work-units reached distill at all (the scan-classification tests
//    assert a prompt's ABSENCE for skipped/backfill-only sources).
// 2. MEM40_JUDGE_RESPONSES routes a distinct canned reply to the SOURCE distill prompt
//    ("SOURCE DOCUMENT" framing, which returns { nodes, entities }) vs the conversation distill
//    (bare array), so the reExtract-guard tests can hand the extractor real entity claims.
import { appendFileSync } from 'node:fs';

const responses = JSON.parse(process.env.MEM40_JUDGE_RESPONSES || '{}');
const log = process.env.MEM40_PROMPT_LOG;

// A canned reply of exactly '__THROW__' makes that call throw instead of answering, so a test can
// simulate an unreachable adapter (the real judge() surfaces a transport failure as a rejection).
const THROW = '__THROW__';
const reply = (v, fallback) => {
  if (v === THROW) throw new Error('mem40-judge-mock: simulated unreachable adapter');
  return v ?? fallback;
};

export async function judge(prompt, opts) {
  const text = String(prompt);
  if (log) appendFileSync(log, `${JSON.stringify({ prompt: text })}\n`, 'utf8');
  if (text.includes('You are rewriting an automatically detected insight')) {
    throw new Error('mem40-judge-mock: compose-insights judge() call always fails offline (fail-soft path)');
  }
  if (text.includes('SAME cluster')) return reply(responses.merge, []);
  if (text.includes('CONSOLIDATOR for the')) return reply(responses.consolidate, []);
  if (text.includes('SOURCE DOCUMENT') && text.includes('distiller for the')) {
    return reply(responses.sourceDistill, { nodes: [], entities: null });
  }
  if (text.includes('distiller for the')) {
    // per-work-unit routing: the first key that appears in the digest wins, so one staging file can
    // fail while another yields in the same run (the mixed-outcome case).
    for (const [needle, v] of Object.entries(responses.distillByMatch || {})) if (text.includes(needle)) return reply(v);
    return reply(responses.distill, []);
  }
  return (opts && opts.json) ? [] : { stale: false };
}
