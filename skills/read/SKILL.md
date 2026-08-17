---
name: read
description: Fetch and return the content of one external page — a Reddit thread, a LinkedIn profile or post, an article, a blog, a docs page — as text for immediate use. Handles cookie jars, blocked and walled pages honestly, and an opt-in live-browser lane for login-walled platforms. Use when the user pastes a URL and wants what is on it, asks to read/pull/open/summarize a link, thread, post, or profile.
version: 1.0.0
model: sonnet
triggers: [read this, read the thread, pull this page, what does this link say, open this url, fetch this article, read this profile, read this post, summarize this link]
tags: [read, fetch, platforms, consumption, sources]
allowed-tools: Bash Read
prerequisites:
  commands: [uv]
---

## Purpose
CONSUMPTION of external platforms: fetch one thing and return its content. `read` is the
consumption half of BUILD-6; `act` is the sibling that changes state on a platform, and
nothing here writes to a platform.

It is a thin router: this file routes, one per-platform file is loaded when that platform is
in play, and all of them run over one core (`read.py`) that owns the fetch ladder, cookie
handling, the content gate, the cache, and the output shape.

**The default is content in context, not a file.** A `sources/` note is written only with
`--land`, and only when the artifact test passes: would a future session redo this work if
the note did not exist? A link read once to answer a question fails that test. Research that
feeds a decision, or material worth distilling, passes it.

## Procedure
1. **Identify the platform from the URL host.** `reddit.com` → reddit. `linkedin.com` →
   linkedin. Anything else → generic.
2. **Read ONLY that platform's file**: `platforms/reddit.md`, `platforms/linkedin.md`, or
   `platforms/generic.md`. Do not read the others; that is the whole point of the split.
   For LinkedIn, read the file before running anything, because of the side effect below.
3. **Run the core:**
   ```
   uv run ~/cockpit/skills/read/read.py "<URL>" [--scope <scope>] [--json] [--land] [--browser] [--no-cache] [--refresh]
   ```
   - `--scope` is required for `--land` and for `--browser` (one Chrome per scope).
   - `--json` prints the output object only: `url`, `platform`, `lane`, `cached`,
     `fetched_at`, `title`, `chars`, `text`, `trail`, `landed`. Without it, a short header
     then the text.
   - `--no-cache` skips reading and writing the cache; `--refresh` ignores an existing entry
     and rewrites it. Default TTL is 6 hours.
4. **Read the `trail`, not just the text.** It records which lane produced the content and
   why each earlier lane was skipped or rejected, including the exact gate marker that
   matched. When a read later breaks, that trail is the diagnosis.
5. **Decide whether to land.** Apply the artifact test from Purpose. If it passes, re-run
   with `--land --scope <scope>` (the cache makes that free) and report the path.

## The `--browser` lane: read this before using it
**Try a cookie jar first.** For a login-walled platform the working path is exporting the
scope's live session (`skills/lib/cdp-cookies.mjs <scope> <domain>`) and then the plain
`direct` lane: measured on LinkedIn 2026-08-17, a 25-cookie jar returned the genuinely
authenticated feed over plain HTTP, no browser involved. `--browser` is the fallback for
what a jar cannot reach, not the first resort.

`--browser` drives **the human's real logged-in Chrome session**. That has consequences a
"read" is not supposed to have:

- **Reading a LinkedIn profile through it generates a real, visible profile view for that
  person.** They can see it. It is not reversible.
- **Everything read through it lands in the human's browsing history**, and in the
  platform's own record of that account's activity.

That is why the lane is **opt-in and never automatic**: the ladder tries `direct`, then the
platform lane, and stops. It does not reach for the browser on its own. Say what the lane
will do and get the human's go before passing `--browser`, especially for a profile view.

The lane also never starts Chrome. `provision/browser-lane.sh <scope>` owns that; if the
lane is down, the read fails with that instruction rather than launching a browser as a side
effect of a read.

## Exit codes
- **0 read.** Content retrieved and printed.
- **1 bad usage.** Not an http(s) URL, or `--land` or `--browser` without `--scope`. All
  checked before any fetch, so a malformed command never comes back as a wall.
- **2 walled or blocked.** Every lane refused, or every body was rejected by the content
  gate. This means "needs credentials, or the browser lane, or the block held", not "the
  network broke". The trail names the marker that matched.
- **3 fetch failed.** Network, timeout, or an unparseable response: nothing ever answered.

Never report exit 2 as an empty successful read. A wall is a result.

## Rules
1. **A 200 is not evidence.** Every lane's body passes the content gate before it is
   accepted, because proof-of-work gates (Anubis) and consent walls answer 200 on the
   challenge page itself. Never add a lane that trusts a status code, and never bypass the
   gate to "get something back".
2. **Block markers live in ONE constant.** `BLOCK_MARKERS` in `read.py`. A new interstitial
   gets a line there, not a per-platform check.
3. **Do not add a stealth fetch library.** Scrapling, curl_cffi, and Firecrawl were all
   tested from this box and returned the same 403 that plain curl gets. The block is
   IP/network reputation on this datacenter ASN. Stdlib urllib only.
4. **Do not retry a 403 with backoff.** It is not a rate limit.
5. **Reddit reads work, but only on the keyless platform lane.** Measured 2026-08-17: the
   `direct` lane is a permanent 403 from this IP and `--browser` does not rescue it (the real
   headed logged-in Chrome, a stronger case than any jar, got a `blocked by network security`
   page), while the platform lane's `.rss` route returned a full live thread with no
   credentials. Claim a lane works only once it has been measured working, and do not
   generalise one thread's result to the platform.
6. **`--browser` only on an explicit decision**, per the section above.
7. **Never print or log a cookie, a token, or a URL query string.** The browser lane prints
   origin plus path only, for exactly that reason.
8. Cookie jars have one home, `~/.config/cockpit/cookies/`, shared with `watch` (BUILD-6).
   Never mint a second jar directory.
9. **Landing is per invocation.** Default writes nothing. `sources/` holds research and
   ingests, never a decision record.
10. The HTML-to-text extractor stays modest. It is not Readability and must not become one.
11. `read` does not own media: a video or podcast URL goes to the `watch` skill, and
    cross-platform research aggregation goes to `last30days`.
