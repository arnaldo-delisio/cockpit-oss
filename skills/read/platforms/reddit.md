# reddit

## URL shapes
- thread: `https://www.reddit.com/r/<sub>/comments/<id>/<slug>/`
- comment permalink: the same, plus `/<comment-id>/`
- subreddit: `https://www.reddit.com/r/<sub>/` (`/top/`, `/hot/`, `/new/`)
- user: `https://www.reddit.com/user/<name>/`
- old and mobile hosts (`old.reddit.com`, `m.reddit.com`) resolve to the same content.

## From this box, Reddit reads work through the keyless rss lane
Measured 2026-08-17:
- **the `platform` lane's `_lane_rss`: WORKING.** On a live thread it returned 12329 chars,
  the post plus its comments, accepted by the gate. No credentials, no jar, no browser. This
  is the lane a Reddit read comes through here.
- **`direct`, no jar: HTTP 403, permanently.** The block is IP/network reputation on this
  Hetzner datacenter ASN. Scrapling, curl_cffi, and Firecrawl all returned the same 403 that
  plain curl gets, byte-identical block pages. Not TLS fingerprint, not JS, so no stealth
  library moves it, and no retry loop either: a 403 here is not a rate limit.
- **`--browser --scope personal`: blocked.** The real headed logged-in Chrome got a `blocked
  by network security` page, rejected by the gate. That is the notable finding: a full real
  browser on a real profile does not defeat this IP, so it is not a credential problem and
  `--browser` does not rescue a Reddit read.
- **`_lane_arctic`: reachable, the fallback.** arctic-shift never touches reddit.com, so the
  ASN block cannot reach it; `/api/posts/ids` answers this box with the full post object. It
  is thin on dead threads: its comments endpoint takes `link_id` and returned nothing for one.
- **`_lane_shreddit`: no text.** Same host, same block.

The practical consequence: **a dead or removed thread yields nothing from any lane**, and that
is indistinguishable from a block unless you read the trail. That is why the trail names each
lane — the first thread measured here was dead, and the whole "Reddit is blocked everywhere"
reading came from generalising it.

Redlib-style mirrors are not among the lanes, because they sit behind an Anubis proof-of-work
gate answering **HTTP 200 on the challenge page itself**; one mirror that worked once did not
reproduce.

## What to expect
Exit 0 via `platform`, with the trail naming `_lane_rss`. Exit 2 means either the ASN block
held on every lane or the thread is gone — read the trail to tell them apart, and try the
thread URL of something live before concluding the block moved. Because the gate rejects a
block page even though it answers 200, a walled read never looks like a successful empty one.
Read the `SKILL.md` warning before reaching for `--browser`: it is measured blocked here, and
still a visible, history-leaving action.
