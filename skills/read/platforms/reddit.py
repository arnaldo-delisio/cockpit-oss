"""Reddit's keyless public lanes for reading one thread.

Endpoint shapes come from the vendored `last30days` skill, which already runs a working
keyless chain for this problem (scripts/lib/reddit_rss.py, reddit_listing.py,
reddit_shreddit.py, reddit_arctic.py). Nothing is imported from there on purpose: a
vendored third-party skill is not a dependency surface, so only the endpoint knowledge
is reused.

Measured from this box 2026-08-17, per lane:
  - _lane_json: FAILING, permanently. www.reddit.com answers 403 to this Hetzner datacenter
    ASN. That is IP/network reputation, not TLS fingerprint and not JS, so no library,
    pacing, or UA change moves it. There is no retry here: a 403 is not a rate limit.
    Credentials do not help: the real headed logged-in Chrome gets a block page from this
    IP too.
  - _lane_rss: WORKING. On a live thread it returned 12329 chars, the post plus its
    comments, and the core's gate accepted it. This is the lane reddit reads come through
    from this box, keyless. It returns nothing on a dead or removed thread, which is what
    the earlier "reddit is blocked everywhere" reading was actually measuring.
  - _lane_arctic: reachable. arctic-shift is a third-party public Reddit archive and the one
    lane here that never touches reddit.com, so the ASN block cannot reach it; `/api/posts/ids`
    answers this box with the full post object. Thin on dead threads: its comments endpoint
    takes `link_id` and returned nothing for one.
  - _lane_shreddit: no text from here. Same host, so the same ASN block applies.

_lane_rss used to mask the two lanes after it: fetch() returned on the first lane with
truthy text, and a 69-char non-content body is truthy, so a run that "failed" had really
tried two of four lanes and reported it as all four. fetch() now takes the core's own
accept() gate and judges each lane against it individually. That masking bug recurs in any
"try lane after lane, stop at first truthy" chain: truthy is not the same test as "is
content," and only the second one is safe to gate on.

The failing lanes stay: they are correct code for a box with a clean IP, and the core's gate
reports their failure honestly rather than as an empty read.

Every result here still goes through the core's content gate: these endpoints answer 200
with block pages.
"""
import json
import re
import urllib.error
import urllib.request
from html import unescape

TIMEOUT = 15
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
ARCTIC_POSTS = "https://arctic-shift.photon-reddit.com/api/posts/ids"
ARCTIC_COMMENTS = "https://arctic-shift.photon-reddit.com/api/comments/search"
MAX_COMMENTS = 100


def post_ref(url):
    """Return (subreddit, base36 post id) from a thread URL, or None."""
    m = re.search(r"/r/([^/]+)/comments/([A-Za-z0-9]+)", url or "")
    return (m.group(1), m.group(2)) if m else None


def _get(url, opener):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            return r.read(2 * 1024 * 1024).decode(
                r.headers.get_content_charset() or "utf-8", errors="replace")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _strip_tags(html):
    return unescape(re.sub(r"<[^>]+>", " ", html))


def _lane_json(url, opener, to_text):
    """The old `.json` view of a thread. Serves 403 to this box's ASN; kept because it is
    the cheapest full-fidelity lane on any host whose IP reddit will talk to."""
    base = url.split("?")[0].rstrip("/")
    body = _get(base + ".json?limit=200&raw_json=1", opener)
    if not body:
        return None
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, list) or not data:
        return None
    out = []
    title = ""
    posts = data[0].get("data", {}).get("children", [])
    if posts:
        d = posts[0].get("data", {})
        title = d.get("title", "")
        out.append(title)
        out.append(f"r/{d.get('subreddit', '')} | u/{d.get('author', '')} | "
                   f"score {d.get('score', 0)} | {d.get('num_comments', 0)} comments")
        if d.get("selftext"):
            out.append("\n" + d["selftext"])
    if len(data) > 1:
        out.append("\n--- comments ---")
        out.extend(_walk_comments(data[1].get("data", {}).get("children", [])))
    text = "\n".join(x for x in out if x)
    return (text, title) if text else None


def _walk_comments(children, depth=0):
    lines = []
    for c in children:
        if c.get("kind") != "t1":
            continue
        d = c.get("data", {})
        pad = "  " * depth
        lines.append(f"{pad}u/{d.get('author', '')} ({d.get('score', 0)}): "
                     f"{(d.get('body') or '').strip()}")
        replies = d.get("replies")
        if isinstance(replies, dict):
            lines.extend(_walk_comments(replies.get("data", {}).get("children", []), depth + 1))
    return lines


def _lane_rss(url, opener, to_text):
    """The thread's RSS view: the lane reddit reads actually come through from this box.
    Each entry's content is HTML, escaped once by the feed, so it is unescaped and then run
    through the core's extractor (`to_text`) rather than a second stripper of our own: a
    regex tag-strip leaves comment markers like `<!-- SC_OFF -->` as literal text. The feed
    title is the thread title, returned so a landed note is not titled with the URL."""
    base = url.split("?")[0].rstrip("/")
    body = _get(base + ".rss", opener)
    if not body:
        return None
    title = ""
    m = re.search(r"<title[^>]*>(.*?)</title>", body, re.S)
    if m:
        title = " ".join(_strip_tags(m.group(1)).split())
    out = [title] if title else []
    for item in re.findall(r"<entry\b.*?</entry>", body, re.S)[:MAX_COMMENTS]:
        author = re.search(r"<author>.*?<name>(.*?)</name>", item, re.S)
        content = re.search(r"<content[^>]*>(.*?)</content>", item, re.S)
        who = author.group(1).strip() if author else "?"
        what = " ".join(to_text(unescape(content.group(1)))[0].split()) if content else ""
        if what:
            out.append(f"{who}: {what}")
    text = "\n".join(out)
    return (text, title) if text else None


def _lane_arctic(url, opener, to_text):
    """arctic-shift, a public third-party archive. Does not touch reddit.com, so the
    datacenter-ASN block does not apply to it; measured reachable from this box."""
    ref = post_ref(url)
    if not ref:
        return None
    sub, pid = ref
    out = []
    title = ""
    body = _get(f"{ARCTIC_POSTS}?ids={pid}", opener)
    if body:
        try:
            items = json.loads(body).get("data") or []
        except (ValueError, AttributeError):
            items = []
        if items:
            d = items[0]
            title = d.get("title", "")
            out.append(title)
            out.append(f"r/{sub} | u/{d.get('author', '')} | score {d.get('score', 0)}")
            if d.get("selftext"):
                out.append("\n" + d["selftext"])
    body = _get(f"{ARCTIC_COMMENTS}?link_id=t3_{pid}&limit={MAX_COMMENTS}", opener)
    if body:
        try:
            comments = json.loads(body).get("data") or []
        except (ValueError, AttributeError):
            comments = []
        if comments:
            out.append("\n--- comments ---")
            for c in comments:
                text = (c.get("body") or "").strip()
                if text:
                    out.append(f"u/{c.get('author', '')} ({c.get('score', 0)}): {text}")
    text = "\n".join(x for x in out if x)
    return (text, title) if text else None


def _lane_shreddit(url, opener, to_text):
    """The comments partial the current Reddit web app calls for itself. Same host, so the
    same ASN block applies; it is last for that reason."""
    ref = post_ref(url)
    if not ref:
        return None
    sub, pid = ref
    body = _get(
        f"https://www.reddit.com/svc/shreddit/comments/r/{sub}/t3_{pid}?sort=top", opener)
    if not body:
        return None
    text = " ".join(_strip_tags(body).split())
    return (text, "") if text else None


def fetch(url, opener, accept, to_text):
    """Try Reddit's keyless lanes in order. `accept(text) -> bool` is the core's own content
    gate and `to_text(html) -> (text, title)` its own extractor, both passed down rather than
    reimplemented: a lane that merely returns truthy text (the _lane_rss masking bug) cannot
    short-circuit the ones after it, since a lane is only taken when `accept` says its text is
    real content. Returns (text, title, lane_name) for the accepted lane, or (None, "", trail)
    where trail lists each lane tried and why it was passed over, so a rejected lane is
    visible in the core's trail rather than silent."""
    trail = []
    for lane in (_lane_json, _lane_rss, _lane_arctic, _lane_shreddit):
        got = lane(url, opener, to_text)
        if not got:
            trail.append(f"{lane.__name__}: no text")
            continue
        text, title = got
        if accept(text):
            return text, title, lane.__name__
        trail.append(f"{lane.__name__}: text rejected ({len(text)} chars)")
    return None, "", trail
