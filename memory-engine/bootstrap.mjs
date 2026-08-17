#!/usr/bin/env node
// bootstrap.mjs — idempotent instance bootstrap (MEM-13 / DESIGN §6a.3).
//
// Safe to re-run: creates only what's missing, NEVER overwrites an existing file
// (so it can't clobber /watch's captured sources). The one exception is
// shells/SOUL.generated.md, which is generated output and regenerated every run.
// Clone-clean (MEM-23/OSS-1): every path resolves via paths.mjs — no hardcoded
// absolute paths, no secrets.
//
// `node bootstrap.mjs` (or the thin root wrapper <repo>/bootstrap.mjs) materializes
// EVERYTHING for the scopes registered in memory/scopes.json (layout §5):
//   memory/knowledge/{nodes,dossiers}/ + INDEX.md   graph store (both recall pools)
//   memory/scopes/<scope>/{identity,log,staging,sources,projects}/  + identity stub
//   scopes/<scope>/                          scope workspace + loader pair (CLAUDE.md
//                                            @-importing the memory-side scope shell)
//   shells/SOUL.generated.md                 SOUL.md + doctrine.md concat (layout §4)
//
// It also leaves memory/ as a git repo with the seed committed, since the reconciler refuses to
// run over an uncommitted knowledge/ tree.
//
// Registration is a deliberate act: no scopes.json -> warn and exit (never seed legacy
// defaults); unregistered dirs under scopes/ are warned about, never auto-adopted.
//
// Everything above stays INSIDE the repo tree. Out-of-tree wiring is opt-in:
//   ~/.hermes/SOUL.md symlink   created ONLY with --write-hermes (and only if ~/.hermes
//                               exists and the file is absent); default prints the command.
//   ~/.claude/settings.json     written from hooks/settings.template.json ONLY with
//                               --write-settings (this laptop is still live on the old tree).
//   ~/.claude/skills/<name>     core-tier symlinks (skills/skills.json) into ~/.claude/skills
//   ~/.hermes/skills/<name>     and, when ~/.hermes exists, ~/.hermes/skills — ONLY with
//                               --write-skills.
//   --cutover                   implies all write flags (mirrors bootstrap.sh).

import { mkdir, writeFile, readFile, access, lstat, readdir, readlink, unlink, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT, MEMORY_ROOT, IS_ISOLATED_ROOT, SCOPES_ROOT, isScopeSlug, symlinkedAncestor } from './paths.mjs';

const execFileAsync = promisify(execFile);

// Re-exported for existing importers (capture-core.mjs, nodes.mjs, projection.mjs, sources.mjs).
export { MEMORY_ROOT, IS_ISOLATED_ROOT };

const SCOPES_FILE = resolve(MEMORY_ROOT, 'scopes.json');
const SCOPE_DIRS = ['identity', 'log', 'staging', 'sources', 'projects'];

// Registration is deliberate (layout §5, Codex finding 2): a fresh box gets its
// scopes.json written by provisioning BEFORE the first bootstrap run. No silent
// legacy defaults — `global` does not exist in the new system.
//
// EVERY entry is slug-gated here, before the first write. ensureScope() gates too, but that gate
// fires halfway through main(), with knowledge/ and INDEX.md already on disk: a name like
// "../escape" would leave the user's data root partially initialized on the failure path. The
// validator is the shared isScopeSlug from paths.mjs, never a second copy of the pattern.
//
// The file is JSON, so an entry can be any JSON value: a nested array, a number, null, an object.
// isScopeSlug() is typeof-checked, so all of those are rejected by the same test. One bad entry
// rejects the WHOLE file: a partially valid roster is not something to silently proceed with, and
// the offending entry is named so the operator can find it.
async function loadScopes() {
  let raw;
  try {
    raw = JSON.parse(await readFile(SCOPES_FILE, 'utf8'));
  } catch {
    console.error(`bootstrap: no ${relative(REPO_ROOT, SCOPES_FILE)} found (or it is not valid JSON).`);
    console.error('bootstrap: write it first, e.g.: ["cockpit","personal","studio"] — then re-run.');
    process.exit(1);
  }
  if (!Array.isArray(raw) || !raw.length) {
    console.error(`bootstrap: ${relative(REPO_ROOT, SCOPES_FILE)} must be a non-empty array of scope names.`);
    console.error('bootstrap: write it first, e.g.: ["cockpit","personal","studio"] — then re-run.');
    process.exit(1);
  }
  const bad = raw.filter((s) => !isScopeSlug(s));
  if (bad.length) {
    console.error(`bootstrap: ${relative(REPO_ROOT, SCOPES_FILE)} has invalid scope name(s): `
      + bad.map((s) => JSON.stringify(s)).join(', '));
    console.error('bootstrap: a scope name must match /^[a-z0-9][a-z0-9-]*$/. Nothing was written; fix the file and re-run.');
    process.exit(1);
  }
  return raw;
}

const created = [];
const rel = (p) => relative(REPO_ROOT, p);

// Every memory/ path bootstrap is RESPONSIBLE for, whether or not this run wrote it, mapped to the
// EXACT bytes bootstrap would seed there. Ownership is by path AND by content, and both halves are
// needed:
//   • by path, because only ensureFile() calls from bootstrap's own seeding code claim anything;
//   • by content, because claiming a path says nothing about who wrote the file sitting on it.
// A path is recorded even when the file already exists on disk, since a first run that died partway
// (say, before scopes.json was written) leaves its files behind: `created` is one invocation's
// memory, and the resumed run must still commit what the crashed run orphaned.
//
// So the commit step tells a genuine orphan from a user's own file by comparing bytes. An orphan was
// written by ensureFile() with exactly this template, so it matches. A file the user put at a seed
// path (their own memory/knowledge/INDEX.md) is arbitrary text, so it does not, and it stays
// untracked. A symlink at a seed path is never staged at all, whatever it points at.
//
// The template is recorded here, at the moment the path is claimed, rather than recomputed at commit
// time. Recomputing would need a second path -> template table beside this one (identityStub() and
// the demo staging are per-call values, not constants), and two tables that must agree is exactly the
// drift that lets a stale entry stage a file it never wrote. One fact, one home.
const owned = new Map();
function claimOwned(p, content) {
  const r = relative(MEMORY_ROOT, p);
  if (r && !r.startsWith('..') && !r.startsWith('/')) owned.set(r, content);
}

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

// Containment lives in paths.mjs (symlinkedAncestor): reconcile's --forget-scope needs the same
// wall, and two copies of a security check are two chances to fix only one of them.

// Refuse rather than write through. A symlinked ancestor cannot be supported by following it:
// memory/ has to be ONE git repo (the reconciler refuses to run over an uncommitted knowledge/
// tree), and git cannot track a path that lies beyond a symlink, so those files would be created
// and then never committable. Skipping quietly would leave a half-materialized tree that fails
// later somewhere less obvious. A user who wants the node pool on another disk still can: mount
// it at the real path, or put memory/ itself on that disk. Both keep one real tree.
async function assertContained(p) {
  const bad = await symlinkedAncestor(p);
  if (bad) {
    throw new Error(
      `bootstrap: refusing to write through a symlinked directory: memory/${bad} is a symlink, `
      + `so ${rel(p)} would be created outside the memory root. `
      + 'Replace it with a real directory (mount the other disk at that path, or move memory/ itself).',
    );
  }
}

async function ensureDir(p) {
  await assertContained(p);
  if (await exists(p)) {
    const st = await lstat(p);
    if (st.isSymbolicLink() && !relative(MEMORY_ROOT, p).startsWith('..')) {
      throw new Error(
        `bootstrap: refusing to write through a symlinked directory: ${rel(p)} is a symlink. `
        + 'Replace it with a real directory (mount the other disk at that path, or move memory/ itself).',
      );
    }
    if (!st.isDirectory()) throw new Error(`bootstrap: ${p} exists but is not a directory`);
    return;
  }
  await mkdir(p, { recursive: true });
  created.push(`dir  ${rel(p)}/`);
}

// Write a seed file ONLY if missing — never clobber existing content.
async function ensureFile(p, content) {
  await assertContained(p);
  claimOwned(p, content);
  if (await exists(p)) return;
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, 'utf8');
  created.push(`file ${rel(p)}`);
}

function identityStub(scope) {
  return `---
id: identity-${scope}
title: ${scope} — identity
type: identity
claim: inference
scope: ${scope}
schema_version: 1
---

_Identity stub for the **${scope}** scope. Filled by the reconciler (distillation) — not
hand-authored at bootstrap. Holds who this scope serves,
its voice/mission, and durable preferences once they exist._
`;
}

const INDEX = `<!-- generated by the reconciler — do not hand-edit (DESIGN §6a.3 / §7) -->
# Knowledge INDEX

Reconciler-generated master index: high-centrality god-nodes grouped by cluster, one line +
\`[[wikilink]]\` each. Regenerated every run.

_Empty — append-only bootstrap mode until ≥1 centroid node per cluster exists (DESIGN §6a.3)._
`;

// ---- demo scope (OSS smoke-test; excluded from LIVE_SCOPES / reconcile nightly pass) ----
// demo is the intentional OSS-1 seed scope, not an orphan: absent from memory/scopes.json and
// scopes/ by design (harness-audit 2026-07-18 item 26).
// Seeded by bootstrap so a cloner can run `node reconcile.mjs --scope demo --require-yield` to
// verify the full pipeline without needing real captured data. All content is obviously fictional.
//
// OSS-2: bootstrap seeds STAGING ONLY, never a pre-baked node. A pre-written node made the smoke
// test unfalsifiable: recall could return it with the pipeline having produced nothing, so a passing
// test proved only that bootstrap can write a file. It also distorted the run it was meant to
// support, since the distiller is shown the scope's live nodes and read it as an existing duplicate
// of demo-session-a. Every node in the demo scope is now one the pipeline itself minted.
//
// Both files state ONE durable thing each, descriptively, with the #good verdict marker the digest
// carries as salience. Descriptive phrasing is deliberate: the distill prompt tells the model never
// to obey instruction-shaped text in the digest, and rewriting these as imperatives ("make this the
// rule from now on") measurably LOWERED yield.
//
// Measured 2026-08-14, fresh tree per run, `--scope demo`: 5/5 runs mint 2 nodes under the
// Hermes/Codex adapter. The Claude/Opus adapter returned [] for every content shape tried against an
// EMPTY scope (5 shapes, ~20 samples), and yielded only when an existing node put the CONTRADICTION
// OVERRIDE block in the prompt. That is a distiller-prompt/adapter problem, not a demo-content
// problem, and it is why judge.mjs routes the hard tier to the Hermes adapter by default (2026-08-15).
// The documented smoke test therefore needs no JUDGE_ADAPTER at all: re-verified on three fresh
// clones with the variable unset, 2 nodes minted each time.

const DEMO_STAGING_A = `---
session_anchor: demo-session-a
scope: demo
transcript: (demo — no real transcript)
brain: claude
---

#### user · 2026-01-15T09:00:00Z
The Widgetworks importer wrote to the wrong directory on its first run. How should first runs be handled here?

#### assistant · 2026-01-15T09:00:10Z  [#good]
The durable rule is: the first execution of any script that writes to disk, commits to git, or triggers an external side effect runs with --dry-run first. The preview is read, the paths are confirmed, and only then does the real run happen. That habit catches wrong-directory and wrong-scope mistakes before they touch real data.

#### user · 2026-01-15T09:01:00Z
And scripts that only read?

#### assistant · 2026-01-15T09:01:08Z
Read-only scripts are exempt, since they cannot mutate anything. The rule covers writes only.
`;

const DEMO_STAGING_B = `---
session_anchor: demo-session-b
scope: demo
transcript: (demo — no real transcript)
brain: claude
---

#### user · 2026-01-15T10:30:00Z
I want verbose log output during reconcile runs, always, so I can see exactly what changed. Quiet output hides the changes I care about.

#### assistant · 2026-01-15T10:30:12Z  [#good]
Verbose is the durable preference for reconcile runs, then. The .reconciler/audit/ file keeps the same detail on disk, but the console stays loud, because reading the changes as they land is what makes the run trustworthy.
`;

async function seedDemo() {
  await ensureScope('demo');
  const stagingDir = resolve(MEMORY_ROOT, 'scopes', 'demo', 'staging');
  await ensureFile(resolve(stagingDir, 'demo-session-a.md'), DEMO_STAGING_A);
  await ensureFile(resolve(stagingDir, 'demo-session-b.md'), DEMO_STAGING_B);
}

// The reconciler-projected scope shell, in the state projection.mjs renderFence() writes when
// neither layer holds a rule. Seeded at scope creation because the workspace CLAUDE.md
// `@`-imports this path from its first line (claudeSeed below): without the file, every fresh
// scope opens with a dangling import until a reconcile happens to project something.
//
// The markers, the header, and the empty-state line are copied from projection.mjs and must stay
// identical to it (publish/reset-managed-region.mjs carries the same copy for the export). `inputs=`
// is the gate signature, which only a real reconcile can compute, so the empty state carries `none`
// on all three sides and the first projection over an empty scope is a byte-identical no-op.
const PROJECTED_SHELL = '<!-- managed:reconciler:begin schema=2 inputs=none -->\n'
  + '## Rules (projected from memory: do not edit; edit the source node)\n'
  + '_(no rules currently meet the always-load bar; see retrieval-gated memory)_\n'
  + '<!-- managed:reconciler:end -->\n';

export async function ensureScope(scope) {
  // Slug gate (Codex finding 5): a scope name reaching the filesystem must never path-escape.
  if (!isScopeSlug(scope)) throw new Error(`bootstrap: invalid scope name ${JSON.stringify(scope)}`);
  for (const d of SCOPE_DIRS) await ensureDir(resolve(MEMORY_ROOT, 'scopes', scope, d));
  await ensureFile(resolve(MEMORY_ROOT, 'scopes', scope, 'identity', `${scope}.md`), identityStub(scope));
  // `cockpit` and `global` are the system scopes: projection.mjs targetFor() routes them at the
  // repo-root CLAUDE.md and shells/CLAUDE.md instead, so a memory-side shell there would be a file
  // nothing reads. Every data scope routes into memory/ and gets one.
  if (!['cockpit', 'global'].includes(scope)) {
    await ensureFile(resolve(MEMORY_ROOT, 'scopes', scope, 'CLAUDE.md'), PROJECTED_SHELL);
  }
}

// ---- DOC-3 workspace doc spine ----
// Per-scope spine: DECISIONS.md (index-grade ledger) + decisions/ (dives) + CLAUDE.md
// (loader pair: workspace CLAUDE.md @-imports the memory-side scope shell, layout §3/§5).
// Materialized structurally so a scope cannot be created off-template, and re-run
// idempotently over existing scopes (missing files created, existing NEVER clobbered).
// cockpit's workspace is the repo root itself; demo has no workspace.

// Scope-slug gate: shared validator from paths.mjs (Codex finding 5) — a malformed or
// hostile name must never become a path escape ('.', '..', separators, absolute paths).
function workspaceFor(scope) {
  if (!isScopeSlug(scope)) {
    console.warn(`bootstrap: skipping doc spine for invalid scope name ${JSON.stringify(scope)}`);
    return null;
  }
  if (scope === 'demo') return null;
  if (scope === 'cockpit') return REPO_ROOT;
  const ws = resolve(SCOPES_ROOT, scope);
  if (!ws.startsWith(SCOPES_ROOT + '/')) return null;   // containment backstop
  return ws;
}

function decisionsSeed(scope) {
  return `# ${scope}: DECISIONS ledger

Index-grade decision ledger (DOC-3 schema): one entry per locked decision, at most 3 sentences
(Decision / Why / Rejected), with a \`Relates:\` line and, for meaty decisions, a
\`decisions/<topic>.md\` deep dive. Open questions at the bottom. One fact, one home.

---

## Open questions
`;
}

function claudeSeed(scope) {
  return `# ${scope.charAt(0).toUpperCase() + scope.slice(1)}: scope shell

Memory scope → \`../../memory/scopes/${scope}/\`. Sessions in this directory auto-resolve to
the **${scope}** data scope (MEM-14) and are auto-captured to its staging timeline.

## Spine map (DOC-3)

| Doc | Owns |
|---|---|
| \`../../memory/scopes/${scope}/projects/<id>.md\` | Project objects (WORK-1) |
| \`../../memory/scopes/${scope}/projects/<id>.roadmap.md\` | Now/Next/Done, the only stored roadmap |
| \`DECISIONS.md\` | decision ledger (≤3-sentence entries) + open questions |
| \`decisions/<topic>.md\` | deep dives behind meaty decisions |
| this file | structure map + resume packet + guardrails |

## Resume packet

Orient: roadmap Now/Next per active Project, then the newest ledger entries. (No active
Projects declared yet: declare one via \`closure.mjs declare\` before real work.)

## Guardrails (scope-specific)

(none yet)

@../../memory/scopes/${scope}/CLAUDE.md
`;
}

async function ensureDocSpine(scope) {
  const ws = workspaceFor(scope);
  if (!ws) return;
  if (scope !== 'cockpit') {
    // A symlinked workspace root could route writes outside the tree (MEM-32 wall):
    // materialize only real directories, skip symlinks loudly.
    try {
      const st = await lstat(ws);
      if (st.isSymbolicLink()) {
        console.warn(`bootstrap: skipping doc spine for ${scope}: workspace is a symlink`);
        return;
      }
    } catch { /* missing: created below */ }
    if (!(await exists(ws))) await ensureDir(ws);
  }
  await ensureDir(resolve(ws, 'decisions'));
  await ensureDir(resolve(ws, 'handoff'));
  await ensureFile(resolve(ws, 'DECISIONS.md'), decisionsSeed(scope));
  if (scope !== 'cockpit') {
    // cockpit's CLAUDE.md is hand-maintained (build context); never seed over it.
    await ensureFile(resolve(ws, 'CLAUDE.md'), claudeSeed(scope));
  }
}

// ---- SOUL concat (layout §4): SOUL.md + doctrine.md -> SOUL.generated.md ----
// SOUL.md cannot @-import, so Hermes gets a build-time concat. Regenerated (overwritten)
// every run — it is generated output, gitignored, never hand-edited. Idempotent: skipped
// when content already matches.
export async function generateSoul() {
  const shells = resolve(REPO_ROOT, 'shells');
  const soul = await readFile(resolve(shells, 'SOUL.md'), 'utf8');
  const doctrine = await readFile(resolve(shells, 'doctrine.md'), 'utf8');
  const out = `<!-- GENERATED by bootstrap.mjs (layout §4): shells/SOUL.md + shells/doctrine.md.
     NEVER hand-edit — edit the sources and re-run bootstrap. -->

${soul.trimEnd()}

${doctrine.trimEnd()}
`;
  const target = resolve(shells, 'SOUL.generated.md');
  const current = await readFile(target, 'utf8').catch(() => null);
  if (current === out) return target;
  await writeFile(target, out, 'utf8');
  created.push(`file ${rel(target)} (regenerated)`);
  return target;
}

// ~/.hermes/SOUL.md -> shells/SOUL.generated.md. Out-of-tree, so gated behind an explicit
// flag (Codex 2nd-round finding 2, consistent with bootstrap.sh --write-hermes/--cutover):
// the default run only prints the instruction. Even with the flag, an existing file is
// never replaced (this laptop's live symlink points at the old tree until cutover).
async function wireHermesSoul(target, write) {
  const hermesDir = resolve(homedir(), '.hermes');
  const link = resolve(hermesDir, 'SOUL.md');
  if (!write) {
    console.log(`bootstrap: hermes SOUL link NOT written (pass --write-hermes): ln -sfn ${target} ${link}`);
    return;
  }
  if (!(await exists(hermesDir))) {
    console.log(`bootstrap: ~/.hermes not found — when Hermes is installed, link it: ln -sfn ${target} ${link}`);
    return;
  }
  try {
    await lstat(link);   // exists (file or symlink) — never clobber out-of-tree state
    console.log(`bootstrap: ~/.hermes/SOUL.md already exists — to repoint at cutover: ln -sfn ${target} ${link}`);
  } catch {
    await symlink(target, link);
    console.log(`bootstrap: linked ${link} → ${target}`);
  }
}

// ---- ~/.claude/settings.json hooks (layout §6) ----
// Rendered from hooks/settings.template.json ({{REPO_ROOT}} / {{HOME}} placeholders).
// Out-of-tree write, gated behind --write-settings; without the flag the rendered hook
// block is only reported. The merge preserves every other key in an existing settings.json
// and replaces only the hook groups the template owns (append-if-absent per command).
async function writeSettings(write) {
  const templatePath = resolve(REPO_ROOT, 'hooks', 'settings.template.json');
  let raw;
  try { raw = await readFile(templatePath, 'utf8'); } catch {
    console.warn(`bootstrap: ${rel(templatePath)} missing — settings step skipped`);
    return;
  }
  const rendered = JSON.parse(raw.replaceAll('{{REPO_ROOT}}', REPO_ROOT).replaceAll('{{HOME}}', homedir()));
  // Skip hook entries whose referenced script is absent on this box (Codex finding 7):
  // a fresh VPS lacks the laptop-local ~/.claude helper scripts.
  for (const groups of Object.values(rendered.hooks || {})) {
    for (const group of groups) {
      const kept = [];
      for (const h of group.hooks || []) {
        const m = /^(?:node|bash|sh|python3?) "([^"]+)"/.exec(h.command || '');
        if (m && !(await exists(m[1]))) {
          console.log(`bootstrap: hook skipped (script missing on this box): ${h.command}`);
          continue;
        }
        kept.push(h);
      }
      group.hooks = kept;
    }
  }
  const file = resolve(homedir(), '.claude', 'settings.json');
  if (!write) {
    console.log(`bootstrap: settings hooks NOT written (pass --write-settings to install into ${file}).`);
    return;
  }
  let s = {};
  try { s = JSON.parse(await readFile(file, 'utf8')); } catch { /* fresh */ }
  s.hooks ||= {};
  for (const [event, groups] of Object.entries(rendered.hooks || {})) {
    s.hooks[event] ||= [];
    for (const group of groups) {
      for (const h of group.hooks || []) {
        const present = s.hooks[event].some((g) => (g.hooks || []).some((x) => x.command === h.command));
        if (!present) s.hooks[event].push({ ...(group.matcher ? { matcher: group.matcher } : {}), hooks: [h] });
      }
    }
  }
  if (rendered.autoMemoryEnabled === false) s.autoMemoryEnabled = false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(s, null, 2) + '\n', 'utf8');
  console.log(`bootstrap: settings hooks ensured in ${file}`);
}

// ---- shared skills (fleet manifest: skills/skills.json) ----
// Core skills get symlinked into ~/.claude/skills/ (and, when it exists, ~/.hermes/skills/)
// so both brains load from the single in-tree source. Out-of-tree writes, gated the same
// way as the hermes SOUL link and settings.json: without the flag, print the ln command it
// would run; with it, do the linking. Idempotent: a correct existing symlink is a skip, a
// wrong target is repointed only when writing, and a real directory at the destination is
// reported and left untouched (never clobbered).
async function ensureSkillLink(name, destDir, write) {
  const target = resolve(REPO_ROOT, 'skills', name);
  const link = resolve(destDir, name);
  let st;
  try { st = await lstat(link); } catch {
    if (!write) {
      console.log(`bootstrap: skill link NOT written (pass --write-skills/--cutover): ln -sfn ${target} ${link}`);
      return;
    }
    await mkdir(destDir, { recursive: true });
    await symlink(target, link);
    console.log(`bootstrap: linked ${link} → ${target}`);
    return;
  }
  if (!st.isSymbolicLink()) {
    console.warn(`bootstrap: ${link} is a real directory, not a symlink — left untouched`);
    return;
  }
  const current = resolve(dirname(link), await readlink(link));
  if (current === target) {
    console.log(`bootstrap: skill ${name} already linked in ${rel(destDir)} — skip`);
    return;
  }
  if (!write) {
    console.log(`bootstrap: skill ${name} link wrong target, NOT repointed (pass --write-skills/--cutover): ln -sfn ${target} ${link}`);
    return;
  }
  await unlink(link);
  await symlink(target, link);
  console.log(`bootstrap: repointed ${link} → ${target}`);
}

async function which(bin) {
  try { await execFileAsync('which', [bin]); return true; } catch { return false; }
}

// Remove manifest-owned symlinks whose skill left the core tier. Only ever touches a
// symlink pointing INTO <repo>/skills/ (dream and hand-made links point elsewhere or are
// real directories, both left untouched). Gated on the same write flag as the linking
// above; in dry mode it prints the rm it would run instead of running it.
// Safety rule: only prune a link whose name appears in NO manifest tier at all (core,
// optional). A name in any tier is never pruned even when not core, since that
// would delete hand-made links to optional skills.
async function pruneSkillLinks(knownNames, destDir, write) {
  const skillsRoot = resolve(REPO_ROOT, 'skills');
  const entries = await readdir(destDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (knownNames.includes(e.name)) continue;
    const link = resolve(destDir, e.name);
    let st;
    try { st = await lstat(link); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let target;
    try { target = resolve(dirname(link), await readlink(link)); } catch { continue; }
    if (dirname(target) !== skillsRoot) continue;
    if (!write) {
      console.log(`bootstrap: stale skill link NOT removed (pass --write-skills/--cutover): rm ${link}`);
      continue;
    }
    await unlink(link);
    console.log(`bootstrap: removed stale skill link ${link} (skill no longer in the manifest)`);
  }
}

// Warn-only check of ~/.hermes/config.yaml wiring (Hermes owns the file; bootstrap never
// writes YAML). Flags a repo skills dir under external_dirs as a tier bypass, and reports
// the exact snippet for any of the three settings that is missing.
async function checkHermesConfig() {
  const configPath = resolve(homedir(), '.hermes', 'config.yaml');
  let raw;
  try { raw = await readFile(configPath, 'utf8'); } catch {
    console.log(`bootstrap: ~/.hermes/config.yaml not found — Hermes config wiring not checked.`);
    return;
  }
  // Deliberate warn-only heuristic, not YAML parsing: block-style lists put "external_dirs:"
  // and its "- path" entries on separate lines, so this checks substrings over the whole
  // file content rather than matching external_dirs on a single line.
  const repoSkills = resolve(REPO_ROOT, 'skills');
  if (raw.includes(repoSkills) || raw.includes('~/.cockpit/skills') || raw.includes('$HOME/.cockpit/skills')) {
    console.warn(`bootstrap: ~/.hermes/config.yaml external_dirs points at a repo/laptop skills dir directly — that bypasses the core tier; point it at ~/.hermes/skills instead.`);
  } else if (!raw.includes('.hermes/skills')) {
    console.warn(`bootstrap: ~/.hermes/config.yaml missing external_dirs entry — add by hand: external_dirs: ["~/.hermes/skills"]`);
  }
  if (!/on_session_end[\s\S]*?hermes-capture\.mjs/.test(raw)) {
    console.warn(`bootstrap: ~/.hermes/config.yaml missing on_session_end hook — add by hand: on_session_end: node hermes-capture.mjs`);
  }
  if (!/pre_llm_call[\s\S]*?recall-hermes\.mjs/.test(raw)) {
    console.warn(`bootstrap: ~/.hermes/config.yaml missing pre_llm_call hook — add by hand: pre_llm_call: node recall-hermes.mjs`);
  }
}

async function wireSkills(write) {
  const manifestPath = resolve(REPO_ROOT, 'skills', 'skills.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {
    console.warn(`bootstrap: ${rel(manifestPath)} missing — skills wiring skipped`);
    return;
  }
  const core = manifest.core || [];
  const optional = manifest.optional || [];
  const knownNames = [...core, ...optional];
  const claudeDir = resolve(homedir(), '.claude', 'skills');
  const hermesDir = resolve(homedir(), '.hermes', 'skills');
  const hermesPresent = await exists(resolve(homedir(), '.hermes'));

  for (const name of core) {
    await ensureSkillLink(name, claudeDir, write);
    if (hermesPresent) await ensureSkillLink(name, hermesDir, write);
  }

  await pruneSkillLinks(knownNames, claudeDir, write);
  if (hermesPresent) await pruneSkillLinks(knownNames, hermesDir, write);
  if (hermesPresent) await checkHermesConfig();

  if (optional.length) console.log(`bootstrap: skills skipped (optional tier, install on demand): ${optional.join(', ')}`);

  const requires = manifest.requires || {};
  for (const name of core) {
    const req = requires[name];
    if (!req) continue;
    for (const bin of req.bin || []) {
      if (!(await which(bin))) console.warn(`bootstrap: skill ${name} missing binary ${bin}`);
    }
    for (const key of req.env || []) {
      if (!process.env[key]) console.warn(`bootstrap: skill ${name} missing env ${key} (add to ~/.config/cockpit/env)`);
    }
  }
}

// ---- memory/ is a committed git repo when bootstrap is done ----
// The reconciler refuses to run over a dirty knowledge/ tree (crash recovery, locks.mjs
// knowledgeTreeDirty). Bootstrap seeds knowledge/ and the demo staging, so leaving those files
// uncommitted made the very first documented reconcile abort. Bootstrap owns the repo now: it
// initializes memory/ if absent and commits what it seeded, so the guard's precondition holds.
// Stays inside the tree, so no flag gates it. Paths are staged explicitly, never `git add -A`,
// so a parallel session's in-flight work in memory/ cannot ride along.
async function memoryGit(args) {
  return execFileAsync('git', ['-C', MEMORY_ROOT, ...args]);
}

// Already in the index or in history? Then it is the user's file to commit, not bootstrap's.
async function isTracked(path) {
  try { await memoryGit(['ls-files', '--error-unmatch', '--', path]); return true; }
  catch { return false; }
}

// Undo exactly the staging bootstrap did, leaving working-tree files alone and every unrelated
// index entry untouched. On a repo with history `git reset -- <paths>` restores those paths from
// HEAD; on a brand-new repo there is no HEAD, so `git reset` errors and `git rm --cached` is the
// only way to drop the entries.
async function unstage(paths) {
  try { await memoryGit(['reset', '--quiet', '--', ...paths]); return; } catch { /* no HEAD */ }
  try { await memoryGit(['rm', '--cached', '--quiet', '-r', '--', ...paths]); }
  catch (err) { console.warn(`bootstrap: could not unstage memory/ seed files (${err.message.trim()}).`); }
}

async function ensureMemoryRepo() {
  if (!(await exists(resolve(MEMORY_ROOT, '.git')))) {
    await memoryGit(['init', '--quiet']);
    created.push('repo memory/ (git init)');
  }
  // scopes.json is user-authored, not bootstrap-created, but it is the file the whole tree is
  // derived from: a memory repo whose seed is committed without it cannot be restored from its own
  // history. So it is the one explicitly named exception, never a wildcard.
  const candidates = [...owned];
  // scopes.json has no bootstrap template (the user authors it), so it is staged on identity of path
  // alone. `null` marks that, and it is the ONLY entry allowed to skip the byte check.
  if (await exists(SCOPES_FILE)) candidates.push(['scopes.json', null]);
  // Regular files only: git cannot stage a directory that holds no file, an empty pathspec is a hard
  // `git add` error, and a symlink at a seed path is out-of-tree state bootstrap must never commit.
  // Already in the index or in history -> the user owns its later edits, so bootstrap leaves it be.
  // Untracked -> nothing has ever recorded it, so it is the seed commit's job ONLY when its bytes are
  // the template bootstrap would have written there. Matching bytes means bootstrap wrote it (a
  // crashed run's orphan); differing bytes mean somebody else did, and it stays untracked.
  const paths = [];
  for (const [p, template] of candidates) {
    const abs = resolve(MEMORY_ROOT, p);
    let st;
    try { st = await lstat(abs); } catch { continue; }
    if (!st.isFile()) continue;
    // Defense in depth: ensureDir/ensureFile refuse a symlinked ancestor before anything is
    // written, so this normally never fires. It still guards the staging decision itself, since a
    // file reached through a symlinked directory lies outside the memory root and is not
    // bootstrap's to record.
    if (await symlinkedAncestor(abs)) continue;
    if (await isTracked(p)) continue;
    if (template !== null) {
      const onDisk = await readFile(abs, 'utf8').catch(() => null);
      if (onDisk !== template) continue;
    }
    paths.push(p);
  }
  // Nothing new to record: leave the tree exactly as found.
  if (!paths.length) return;
  try {
    await memoryGit(['add', '--', ...paths]);
  } catch (err) {
    console.warn(`bootstrap: could not stage memory/ seed files (${err.message.trim()}).`);
    return;
  }
  // `diff --cached --quiet` exits 0 when nothing is staged, so nothing needs committing.
  let staged = false;
  try { await memoryGit(['diff', '--cached', '--quiet', '--', ...paths]); }
  catch { staged = true; }
  if (!staged) return;
  const commit = (prefix) => memoryGit([...prefix, 'commit', '--quiet', '-m', 'bootstrap: seed memory tree', '--', ...paths]);
  try {
    await commit([]);
    created.push('commit memory/ seed committed');
    return;
  } catch { /* usually a box with no git identity yet: fall back below */ }
  // The seed commit is bootstrap's own, and INSTALL tells the user to set the memory/ identity
  // AFTER this step, so a missing identity must not leave the tree dirty and the reconciler
  // blocked. A per-command identity covers this one commit; every later commit uses the user's.
  try {
    await commit(['-c', 'user.name=cockpit bootstrap', '-c', 'user.email=bootstrap@cockpit.local']);
    created.push('commit memory/ seed committed (fallback identity: set your own for later commits)');
  } catch (err) {
    // Leave nothing staged: a later `git commit` by the user must not sweep bootstrap's paths in.
    await unstage(paths);
    console.warn(`bootstrap: memory/ seed files written but not committed (${err.message.trim()}).`);
    console.warn('bootstrap: set a git identity, then re-run bootstrap:');
    console.warn(`  git -C ${MEMORY_ROOT} config user.name "Your Name"`);
    console.warn(`  git -C ${MEMORY_ROOT} config user.email "you@example.com"`);
  }
}

// Unregistered dirs under scopes/ are reported, never auto-adopted (layout §5).
async function warnUnregistered(liveScopes) {
  const entries = await readdir(SCOPES_ROOT, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() && !liveScopes.includes(e.name)) {
      console.warn(`bootstrap: scopes/${e.name}/ is not registered in memory/scopes.json — ignored (register it to adopt).`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cutover = argv.includes('--cutover');
  const writeSettingsFlag = cutover || argv.includes('--write-settings');
  const writeHermesFlag = cutover || argv.includes('--write-hermes');
  const writeSkillsFlag = cutover || argv.includes('--write-skills');
  // Validate BEFORE the first write: loadScopes() exits 1 on a missing, empty, or malformed
  // scopes.json (invalid scope names included), and a run that refuses must leave nothing behind
  // rather than a half-built knowledge/ tree.
  const liveScopes = await loadScopes();
  await ensureDir(resolve(MEMORY_ROOT, 'knowledge', 'nodes'));
  // The keyword half of recall greps this pool (retrieval.mjs ripgrepSearch). Missing on a fresh
  // install, so every recall printed an rg failure and ran embeddings-only.
  await ensureDir(resolve(MEMORY_ROOT, 'knowledge', 'dossiers'));
  await ensureFile(resolve(MEMORY_ROOT, 'knowledge', 'INDEX.md'), INDEX);
  for (const scope of liveScopes) await ensureScope(scope);
  // Workspace doc spine (DOC-3) + generated shells only for the canonical root — an
  // isolated/walled run (MEM-32) must never touch the shared workspaces or shells.
  if (!IS_ISOLATED_ROOT) {
    for (const scope of liveScopes) await ensureDocSpine(scope);
    await warnUnregistered(liveScopes);
    const soulTarget = await generateSoul();
    await wireHermesSoul(soulTarget, writeHermesFlag);
    await writeSettings(writeSettingsFlag);
    await wireSkills(writeSkillsFlag);
  }
  await seedDemo();
  await ensureMemoryRepo();

  if (created.length === 0) {
    console.log('bootstrap: tree already complete — no changes (idempotent).');
  } else {
    console.log(`bootstrap: created ${created.length} item(s):`);
    for (const c of created) console.log('  + ' + c);
  }
}

// Run only when invoked directly (so capture.mjs can import ensureScope without running this).
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('bootstrap failed:', e); process.exit(1); });
}
