#!/usr/bin/env node
// reset-managed-region.mjs, part of the public export (publish/publish.sh step 6c and check i).
//
// The reconciler owns a fenced region inside every always-load file it targets
// (memory-engine/projection.mjs, DESIGN §6a.4). In the author's own tree that region holds
// real rules, each a [[wikilink]] to a graph node that never ships. A cloner reading the
// export before running anything would read those rules as if they were the project's own.
//
// So the export ships the region in the state the reconciler itself writes when no rule
// meets the always-load bar. The markers, the header, and the empty-state line below are
// copied from projection.mjs and must stay identical to it: a fresh install's first
// reconcile should recognise the region, not fight it.
//
// Usage:
//   node publish/reset-managed-region.mjs --reset <file>...   rewrite each region to empty
//   node publish/reset-managed-region.mjs --check <file>...   exit 1 if any region is non-empty
//
// Both modes validate the WHOLE file, never just its first match. A file may carry at most ONE
// managed region, and it must be well formed: one begin marker, one end marker, in that order. Zero
// markers is the legitimate state of a projection target the reconciler has not written yet
// (shells/CLAUDE.md and shells/SOUL.md are in exactly that state today), so it is a skip, not a
// failure. Anything else — two regions, a begin with no end, an end with no begin — is a hard error
// in both modes. Handling only the first match was the bug: --reset emptied region one, --check then
// saw an empty region one and exited 0 while a second, possibly private, region shipped untouched.

import { readFile, writeFile } from 'node:fs/promises';

// projection.mjs FENCE_RE, verbatim, plus a global twin for whole-file counting.
const FENCE_RE = /[ \t]*<!-- managed:reconciler:begin\b[^>]*-->[\s\S]*?<!-- managed:reconciler:end -->\n?/;
const FENCE_RE_G = new RegExp(FENCE_RE.source, 'g');
const BEGIN_RE_G = /<!-- managed:reconciler:begin\b[^>]*-->/g;
const END_RE_G = /<!-- managed:reconciler:end -->/g;

// Returns { region } for the single well-formed region, { region: null } for a file with no markers
// at all, or { error } for anything the export must refuse to ship.
function findRegion(text) {
  const begins = text.match(BEGIN_RE_G)?.length ?? 0;
  const ends = text.match(END_RE_G)?.length ?? 0;
  const regions = text.match(FENCE_RE_G) ?? [];
  if (begins === 0 && ends === 0) return { region: null };
  if (begins !== 1 || ends !== 1 || regions.length !== 1) {
    return { error: `expected exactly one well-formed managed region, found ${begins} begin marker(s), ${ends} end marker(s), ${regions.length} complete region(s)` };
  }
  return { region: regions[0] };
}

// projection.mjs renderFence(), the branch taken when both layers are empty. `inputs=` carries
// a hash of the gate inputs, which only a real reconcile can compute, so the export writes
// `none` and the first reconcile fills in the real signature.
const EMPTY_FENCE = '<!-- managed:reconciler:begin schema=2 inputs=none -->\n'
  + '## Rules (projected from memory: do not edit; edit the source node)\n'
  + '_(no rules currently meet the always-load bar; see retrieval-gated memory)_\n'
  + '<!-- managed:reconciler:end -->\n';

const [mode, ...files] = process.argv.slice(2);
if ((mode !== '--reset' && mode !== '--check') || !files.length) {
  console.error('usage: reset-managed-region.mjs --reset|--check <file>...');
  process.exit(2);
}

let changed = 0;
let offenders = 0;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const { region, error } = findRegion(text);
  if (error) {
    console.error(`  malformed managed region: ${file} (${error})`);
    offenders++;
    continue;
  }
  if (region === null) continue;
  if (region.trimStart() === EMPTY_FENCE) continue;
  if (mode === '--check') {
    console.error(`  non-empty managed region: ${file}`);
    offenders++;
    continue;
  }
  // Replaces the one region findRegion() validated: FENCE_RE is non-global, and the file is now
  // known to hold exactly one match.
  await writeFile(file, text.replace(FENCE_RE, EMPTY_FENCE), 'utf8');
  console.log(`  reset managed region: ${file}`);
  changed++;
}

// A malformed file fails --reset too: the export must not commit a file this script could not
// account for in full.
if (offenders > 0) process.exit(1);
if (mode === '--check') process.exit(0);
if (!changed) console.log('  no managed region needed resetting');
