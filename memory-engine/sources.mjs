#!/usr/bin/env node
// sources.mjs — source verdict write-back verb CLI (AR-5 task-7, MEM-37 §4 lane 1).
//
//   node sources.mjs verdict <scope> <source-id> <interesting|expand|bullshit> [--dry-run]
//
// Records a human verdict for a deliberate source save into the reconciler's
// semantic-source-verdicts negative-memory sidecar, keyed exactly like the
// source-insight detector's own entries: `${sha8(fileContent)}|${scope}|<detector>`
// (see semantic-insights.mjs gatherSourceInsightCandidates). Human verdicts land
// under the `human` detector slot; a `bullshit` verdict ALSO writes the
// `source-insight` slot (only when absent, never clobbering a detector entry) so
// the detector's existing skip check makes the blacklist permanent. Modeled on
// roadmap.mjs / decisions.mjs: fixed positionals, flags parsed only past the
// positionals, --dry-run, atomic tmp+rename write.

import { readFile, writeFile, rename, mkdir, rmdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_ROOT } from './bootstrap.mjs'; // COCKPIT_MEMORY_ROOT seam (MEM-32)

const VERDICT_FILE = join(MEMORY_ROOT, '.reconciler', 'semantic-source-verdicts.json');
const VERDICT_LOCK = `${VERDICT_FILE}.lock`;

// Cross-process mutex for the verdicts sidecar: the dashboard middleware, this CLI,
// and the nightly semantic scan all read-modify-rename the same file, and process
// boundaries make in-process serialization insufficient. mkdir is atomic on POSIX;
// a lock older than 30s is presumed dead (crashed holder) and broken.
export async function withVerdictsLock(fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(VERDICT_LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - (await stat(VERDICT_LOCK)).mtimeMs > 30_000) { await rmdir(VERDICT_LOCK); continue; } } catch { /* raced away */ }
      if (Date.now() > deadline) throw new Error(`verdicts sidecar locked (${VERDICT_LOCK})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await fn(); } finally { await rmdir(VERDICT_LOCK).catch(() => {}); }
}
const VERDICTS = ['interesting', 'expand', 'bullshit'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Source filenames may carry underscores/uppercase, unlike node ids. No dots or
// slashes: the .md extension is appended here, so this charset cannot traverse.
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const sha8 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

function usage(msg) {
  if (msg) console.error(`sources: ${msg}`);
  console.error('usage: sources.mjs verdict <scope> <source-id> <interesting|expand|bullshit> [--dry-run]');
  process.exit(1);
}

async function knownScopes() {
  try {
    const raw = JSON.parse(await readFile(join(MEMORY_ROOT, 'scopes.json'), 'utf8'));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch { /* fall through */ }
  return ['global', 'cockpit'];
}

async function atomicWriteJson(path, obj, dryRun) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  if (dryRun) {
    console.log(`(--dry-run: nothing written)\n\n=== would write ${path} ===`);
    return;
  }
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, text, 'utf8');
  await rename(tmpPath, path); // atomic on the same filesystem
}

async function main() {
  const args = process.argv.slice(2);
  const [verb, scope, id, verdict] = args;
  if (verb !== 'verdict') usage(`unknown verb "${verb || ''}" (must be verdict)`);
  if (!scope || !KEBAB.test(scope)) usage('need <scope> as a kebab-slug');
  if (!(await knownScopes()).includes(scope)) usage(`unknown scope "${scope}"`);
  if (!id || !SOURCE_ID.test(id)) usage('bad <source-id>');
  if (!VERDICTS.includes(verdict)) usage('verdict must be interesting|expand|bullshit');
  // Flags parsed only past the fixed positionals (roadmap.mjs precedent).
  const dryRun = args.slice(4).includes('--dry-run');

  const sourcePath = join(MEMORY_ROOT, 'scopes', scope, 'sources', `${id}.md`);
  let raw;
  try { raw = await readFile(sourcePath, 'utf8'); } catch { usage(`no source file at ${sourcePath}`); }
  const hash = sha8(raw);

  const prior = await withVerdictsLock(async () => {
    let verdicts = {};
    try { verdicts = JSON.parse(await readFile(VERDICT_FILE, 'utf8')); } catch { /* first write */ }

    const humanKey = `${hash}|${scope}|human`;
    const previous = verdicts[humanKey];
    verdicts[humanKey] = { ts: new Date().toISOString(), outcome: verdict };
    if (verdict === 'bullshit') {
      // Permanent detector blacklist: the source-insight gatherer skips any source
      // whose `${hash}|${scope}|source-insight` key exists. Never overwrite a real
      // detector entry, absence is the only thing being fixed here.
      const detectorKey = `${hash}|${scope}|source-insight`;
      if (!verdicts[detectorKey]) {
        verdicts[detectorKey] = { ts: new Date().toISOString(), outcome: 'blacklisted-by-human' };
      }
    }

    await atomicWriteJson(VERDICT_FILE, verdicts, dryRun);
    return previous;
  });
  console.log(`sources: ${scope}/${id} (${hash}) verdict ${verdict}${prior ? ` (replaces ${prior.outcome})` : ''}`);
}

// Run ONLY when invoked directly — importing this module must never trigger writes.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error('sources failed:', e.message); process.exit(1); });
