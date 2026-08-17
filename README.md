# cockpit

Ephemeral execution, durable organizational state.

Cockpit is the plumbing that lets AI agents be started, replaced, and run side by side while
the work they do outlives them. What the work knows, the decisions behind it, where each
claim came from, and the capabilities the agents share all live outside every session, as
plain markdown in a git repo you own. Any agent can be thrown away. Nothing it learned goes
with it.

---

## The problem it solves

AI assistants forget everything when a session ends. You explain your architecture, argue
through a tradeoff, settle on an approach, and tomorrow you explain it again from scratch.

Run more than one and the problem compounds: they forget *separately*. Work fragments across
sessions, tools, and context windows. Architectural choices get rediscovered instead of
recalled. What you worked out in a coding session on Monday is invisible to the research
agent on Tuesday. Every tool becomes its own island.

The tools ship built-in memory, and it does not solve this. Built-in memory decides for
itself what is worth keeping, gives you no way to inspect or correct what it kept, and costs
thousands of tokens of context on every single session. Your preferences end up in a store
you cannot audit, and two such stores that cannot see each other is worse than one.

Cockpit takes the memory out of the tools and puts it somewhere none of them owns.

---

## The idea

**Agents run. State stays.**

Execution, memory, and orchestration are three separate things here. Agents execute: they
start, do work, and end. Memory is a single store that no agent owns, written by one program
and read by all of them. Orchestration is its own layer: sessions are launched into a scope
on the box and outlive the pane that opened them, so a terminal window is a view onto an
agent rather than the agent itself.

Nothing becomes the source of truth by virtue of running. What a session learned counts only
once the reconciler has written it into the graph, and what a session must obey it reads
from doctrine files at the start. Coordination survives individual agents because the
knowledge, the decisions, and the operating rules sit outside them.

The memory layer is not subordinate to whatever orchestrates execution. No assistant owns
the store or speaks for it: each writes into the same shared record, and a human can read
every line of it. Two assistants working the same scope coordinate through that record
rather than through each other.

The parts, by role:

- **Interactive builders** work with you in a terminal. One session at a time, good at
  writing code and reasoning through design.
- **Background workers** run asynchronously, several at once, good at research runs, content
  pipelines, and routine operations.
- **The orchestration layer** is the launchers and services that put a session in the right
  scope on the box and keep it running when you disconnect.
- **The memory and reconciliation layer** is the shared substrate: capture, distillation,
  the graph, and the rules projected back into every session.

Cockpit ships the shared parts: the memory engine, the skills every role loads, and the
written doctrine that tells all of them how to work. The agents themselves are third-party
tools you install separately.

---

## How the memory actually works

The memory is not a database and not a vector index with a service in front of it. It is a
directory of markdown files under version control, and a program that maintains them.

**1. Capture.** When a session ends, a hook appends the raw material to a staging inbox.
Nothing is interpreted yet. Each agent writes to its own lane, append-only, so parallel
sessions never collide.

**2. Reconcile.** A single program is the only thing allowed to write finished memory. It
runs at session boundaries for a quick pass, and once a night for a thorough one. It reads
the staging inbox and does three things: distills raw capture into candidate facts, groups
them by subject, then decides for each one whether it is new, updates something already
known, or supersedes it. Superseded knowledge is marked, never deleted.

Because one program is the sole writer, there is no merge conflict between brains and no
question about where a claim came from.

**3. Store.** Each piece of knowledge is one markdown file with a metadata header: what kind
of claim it is, which scope it belongs to, how confident it is, where it came from, and
whether a human has ratified it. Claims that assert fact without a citation are
automatically downgraded to inference. Files link to each other with wiki-style links, so
the pool is a graph rather than a pile.

**4. Recall.** When a session starts, a retrieval pass finds the handful of notes relevant
to what you are about to do and puts them in front of the assistant. It runs in-process
using a small local embedding model plus keyword search, combined and ranked. There is no
server and no external service to provision.

**5. Projection.** A few notes are not facts but behavior: rules the system learned about
how you want work done. Those get written into the always-loaded instruction files inside a
fenced region the reconciler owns. A rule starts as *emerging* and is promoted to *durable*
only after it survives several passes, which keeps a one-off remark from hardening into law.

The whole thing is a git repo, so you can read every note, correct one by editing a file,
and see the history of how the system's understanding changed.

---

## Scopes

Work is partitioned into scopes: one per venture, client, or area of life. A scope has its
own memory, its own workspace, and its own decision record. Nothing is global, and there
are no scopes by default. Registering one is a deliberate act, because an unregistered
directory is a warning rather than an invitation.

Confidentiality is enforced at the machine level, not with tags inside the graph. A client
that needs isolation gets its own machine running its own copy. Nothing crosses.

---

## The written constitution

`shells/doctrine.md` is the rulebook both assistants load on every session: how to verify
work before calling it done, when to ask before acting, what never gets built speculatively,
how research gets grounded and cited. It is the most opinionated file in the repo and the
one most worth reading if you want to understand how this system behaves.

Its companion is the decision ledger. Every architectural choice is recorded with its
reasoning, the alternatives rejected, and a status. Entries are superseded in place rather
than removed, so the trail survives, and meaty ones get a longer deep dive alongside. The
point is to stop the same argument being had twice, and the doctrine requires reading the
relevant entries before building anything that touches them.

The engine ships the ledger mechanism and the discipline around it. It does not ship the
author's own entries, which are specific to one person's ventures and stay private. You
start your own on first run.

---

## Skills

`skills/` holds capabilities both assistants share, each one a directory with instructions
and optional scripts. Both roles load from the same source, so a skill improved during a
build session is immediately available to the agent fleet.

The shipped set includes transcript capture from video and audio, voice-grounded writing,
multi-perspective research, a tutor that keeps state across sessions, session handoffs, and
an independent code review lane. A manifest declares which are core and what each one
requires, and setup links them into both assistants.

---

## Current implementation

The two roles are genuinely different tools, which is why the split exists rather than
picking one.

The interactive builder is Claude Code. The background workers are
[Hermes](https://github.com/NousResearch/hermes-agent), an open-source agent CLI from Nous
Research; the provisioning script installs it by cloning that repo into a Python venv, so
there is no Hermes subscription to buy. Model access is separate, and the reconciler splits
it by tier. Its heavy tier (distill, conflict resolution, centrality) calls Hermes in
oneshot mode (`hermes -z`) pinned to the `openai-codex` provider, so it rides an existing
Codex CLI login rather than a metered API key. Its lighter tiers (triage, classify,
summarize, phrasing) call the Claude Code CLI on your subscription. Both paths are
subscription-based, so no API key is involved, and both are required: without Hermes plus a
Codex login the reconciler cannot distill at all, and it says so instead of producing an
empty run.

Swapping either tool is a change of implementation, not of design. The memory, the doctrine,
and the skills do not move.

---

## What is in the repo

| Path | What it is |
|---|---|
| `memory-engine/` | The engine: capture, reconcile, retrieval, projection, plus the project and board tooling |
| `memory-engine/DESIGN.md` | The full specification, and the right place to go deeper |
| `shells/` | Doctrine and the two role identities |
| `skills/` | Shared capabilities |
| `provision/` | Server setup and laptop launchers, for running the tree on a VPS |
| `bootstrap.mjs` | Clone-clean setup |
| `publish/` | The export machinery that built this public copy: the manifest of what is held back, and the scripts that apply it. Owner-side tooling, shipped so the boundary is readable; it refuses to run outside the source tree |
| `migrations/` | One-off scripts that reshape your `memory/` data when a release changes its format. Empty until the first such change ships |
| `update.sh` | The sanctioned update path: `update.sh <tag>` prints the plan and writes nothing, `--apply` performs it. The apply run snapshots your data, migrates, regenerates, and verifies, rolling everything back together on any failure. It also writes outside the repo: regeneration is a bootstrap cutover, so an apply run rewrites `~/.claude/settings.json`, and it advances `~/cockpit-template` if that tree exists |

Your data is not in this repo. It lives inside the tree in `memory/`, a nested private git
repository, and in `scopes/`, a workspace directory. This repo ignores both, so pulling
engine updates can never touch what you have accumulated. Secrets live outside the tree entirely, in a single file
at `~/.config/cockpit/env`.

There is an operator console, a web dashboard over the memory graph and your tool usage. It
is not included here: it is built on a third-party product whose license does not permit
redistribution. Everything in this repo works without it.

---

## Getting started

Setup, the bootstrap flags, and the VPS launcher configuration are in
**[INSTALL.md](INSTALL.md)**.

The short version: Node 20 or newer, a Claude Code subscription, Hermes installed from
source, and a Codex CLI login. All three are required, not optional: the engine's heavy tier
runs on Codex through Hermes and its lighter tiers on Claude Code. No API key is needed for
the engine itself. You declare your scopes, run bootstrap, and opt in explicitly to each
thing that writes outside the repo. A flagless run touches nothing in your home directory.

---

## Status

This is one person's working system, published because the design is more useful shared than
kept. It is opinionated, it assumes the specific pair of tools it was built for, and it
changes as the person using it learns something. Where a choice looks strange, it usually
survived an argument you cannot see: the reasoning was recorded, but the author's own ledger
stays private.

The tree you get is deliberately empty of content. Bootstrap gives you the structure and a
demo scope to smoke-test the pipeline, then the system learns your work from your work.

---

## License

MIT, see [LICENSE](LICENSE).
