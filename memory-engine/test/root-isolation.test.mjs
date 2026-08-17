// root-isolation.test.mjs — proves the preload, not import order, pins the memory root.
//
// projection.mjs is imported FIRST on purpose: it is the cheapest engine module that resolves the
// root (projection.mjs:25 -> nodes.mjs:14 -> paths.mjs:17, no models pulled in). It does not
// re-export MEMORY_ROOT, so the assertion reads it from nodes.mjs — also evaluated before this
// file's body. If the root were set from a module body, these would see the real memory repo.
// Do not reorder these imports.
import '../projection.mjs';
import { MEMORY_ROOT } from '../nodes.mjs';
import { TEST_MEMORY_ROOT } from './fixtures.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('engine root is the temp root even when an engine module is imported first', () => {
  assert.equal(MEMORY_ROOT, process.env.COCKPIT_MEMORY_ROOT);
  assert.equal(MEMORY_ROOT, TEST_MEMORY_ROOT);
});
