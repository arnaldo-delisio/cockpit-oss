// setup.mjs — ESM preload (`node --import ./test/setup.mjs`). Runs before ANY module of the
// test file graph is evaluated, so the engine's import-time root resolution (paths.mjs:17,
// nodes.mjs:14) can never see the real memory repo regardless of import order.
//
// Nothing else belongs here, and it must not import engine code (that would defeat the point) —
// the transformers import below is a DEPENDENCY, not engine code, and touches no root resolution.

// It also owns teardown: --import runs in the runner process AND in every test-file process, so
// each one mints its own root and must remove its own on exit (guarded to our tmpdir).

// It also owns the OFFLINE guard (Codex review 2026-07-25). The engine embeds through
// retrieval.mjs embed() -> pipeline('feature-extraction', …), which loads (and on a cold cache
// DOWNLOADS ~23 MB of) ONNX weights. A test suite must never depend on a network or a warm HF
// cache, and the durable-suppression backstop (projection.mjs:501) is reachable from the real
// project() run in pool-invariants. Disabling BOTH model sources makes any embed() call reject
// immediately — structurally, for every test file — instead of hitting the network. Every engine
// caller of embed() is fail-open (projection.mjs:520/599: suppression skipped, nothing demoted,
// nothing lost), so the guard suppresses a model load, never an assertion.
import { env as hfEnv } from '@huggingface/transformers';
hfEnv.allowRemoteModels = false;
hfEnv.allowLocalModels = false;

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'cockpit-memory-test-'));
process.env.COCKPIT_MEMORY_ROOT = root;

process.on('exit', () => {
  if (!root.startsWith(resolve(tmpdir()) + '/')) return;  // never rm outside tmpdir
  rmSync(root, { recursive: true, force: true });
});
