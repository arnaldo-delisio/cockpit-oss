#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""read — fetch one external page (thread, post, profile, article) and return its text.

The shared core behind the `read` skill (BUILD-6): the fetch ladder, cookie handling,
the content gate, the cache, and the one output shape every platform returns.

Ladder, in order, each lane returning text or None:
  1. direct    urllib GET through the host's cookie jar when one exists
  2. platform  a per-platform keyless endpoint, where one exists (reddit)
  3. browser   the scope's live logged-in Chrome over CDP, opt-in via --browser only

Every lane's body passes the content gate before it is accepted, because a 200 is not
evidence that we got content: proof-of-work challenge pages and consent walls answer 200.

Landing is per invocation, not always (BUILD-6 amendment): the default returns content
and writes nothing. --land writes a sources/ note through skills/lib/sources.py.

usage: read.py <url> [--scope S] [--json] [--land] [--browser] [--no-cache] [--refresh]

exit codes: 0 read, 1 bad usage (not an http(s) URL, or --land/--browser without --scope,
all checked before any fetch), 2 walled or blocked (every lane refused or was rejected
by the content gate), 3 fetch failed (network, timeout, unparseable). A caller must be
able to tell "this needs credentials or the browser lane" apart from "the network broke".
"""
import argparse, os, sys, json, re, hashlib, subprocess, datetime
import urllib.error
import urllib.request
import urllib.parse
from html.parser import HTMLParser
from html import unescape

# Repo root resolved from this script's own location (layout §6: one root rule), via
# realpath rather than abspath since skills are installed as directory symlinks, so
# abspath would resolve the root to the symlink's parent.
COCKPIT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
sys.path.insert(0, os.path.join(COCKPIT, "skills", "lib"))  # standalone uv script: shared modules need an explicit path
sys.path.insert(0, os.path.join(COCKPIT, "skills", "read", "platforms"))
from cookies import jar_for, opener_for  # noqa: E402
from sources import slugify, land  # noqa: E402

CDP_FETCH = os.path.join(COCKPIT, "skills", "lib", "cdp-fetch.mjs")

# A real browser UA: many hosts serve a stripped or refused page to urllib's default.
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = 25
MAX_BYTES = 5 * 1024 * 1024  # size cap so one huge page cannot hang or exhaust memory
CACHE_TTL = 6 * 3600
BROWSER_TIMEOUT = 90  # the CDP lane enforces its own wall clock; this is the outer backstop

EXIT_READ = 0
EXIT_USAGE = 1
EXIT_WALLED = 2
EXIT_FETCH_FAILED = 3

# The whole reason the content gate exists. Every marker below has been observed on a
# page that answered HTTP 200, so a status-code-only check accepts all of them as
# content: Anubis proof-of-work gates on Redlib-style mirrors return 200 on the
# challenge page itself. Lowercased substring match against the extracted text.
BLOCK_MARKERS = [
    "making sure you're not a bot",       # Anubis proof-of-work gate
    "anubis",
    "proof-of-work",
    "just a moment",                      # Cloudflare interstitial
    "checking your browser before",
    "enable javascript and cookies to continue",
    "please enable javascript",
    "verify you are human",
    "attention required! | cloudflare",
    "ddos protection by cloudflare",
    "whoa there, pardner",                # Reddit rate/block page
    "blocked by network security",
    "sign in to continue",                # login wall
    "log in to continue",
    "join linkedin",
    "you must log in to continue",
    "create an account or sign in",
    "accept all cookies",                 # consent gate served in place of content
    "we use cookies to",
    "before you continue to",
]
# The two consent markers above were suspected of falsely rejecting ordinary pages that
# merely mention cookies. Measured 2026-08-17 on the direct lane: a Python docs page,
# Hacker News, BBC News, Ars Technica, and the Wikipedia article titled "Cookie" all read
# clean (exit 0, 3856 to 25816 chars). The worry did not reproduce, so do not loosen these
# on a hunch; a real false rejection has to be produced first.

# Below this, an extracted body is a stub (an error card, a redirect shim, an empty
# shell), not the thing the URL names. Profiles and articles both clear it easily.
MIN_CHARS = 400
# Reddit thread and profile pages carry more chrome than text, so the floor is lower for
# short link posts, which are legitimately near-empty apart from title and comments.
MIN_CHARS_SHORT_KINDS = 120
SHORT_KIND_HOSTS = ("reddit.com", "x.com", "twitter.com", "news.ycombinator.com")


class FetchFailed(Exception):
    """We never got an answer we understand: network, timeout, status, or unparseable."""


# ---------- html to text ----------
class _Extractor(HTMLParser):
    """Modest text extractor. Not a Readability reimplementation, and must not become one."""

    SKIP = {"script", "style", "nav", "footer", "svg", "noscript", "head", "form"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
             "section", "article", "blockquote", "pre", "td"}

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.parts = []
        self.title = ""
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip_depth:
            self.parts.append(data)


def html_to_text(html):
    p = _Extractor()
    try:
        p.feed(html)
        p.close()
    except Exception:
        # A malformed document still yields whatever was parsed before the break.
        pass
    text = "".join(p.parts)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n[ \n]*", "\n", text)
    lines = [ln.strip() for ln in text.split("\n")]
    text = "\n".join(ln for ln in lines if ln)
    return unescape(text).strip(), " ".join(p.title.split()).strip()


# ---------- the content gate ----------
def min_chars_for(url):
    host = urllib.parse.urlparse(url).netloc.lower()
    if any(h in host for h in SHORT_KIND_HOSTS):
        return MIN_CHARS_SHORT_KINDS
    return MIN_CHARS


def looks_like_content(text, url):
    """Return (ok, reason). A 200 is not evidence, so every lane's body comes through here."""
    if not text or not text.strip():
        return False, "empty body"
    low = text[:20000].lower()
    for marker in BLOCK_MARKERS:
        if marker in low:
            return False, f"block marker matched: {marker!r}"
    floor = min_chars_for(url)
    if len(text.strip()) < floor:
        return False, f"implausibly short: {len(text.strip())} chars, floor {floor}"
    return True, "passed gate"


# ---------- cache ----------
def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    d = os.path.join(base, "cockpit", "read")
    os.makedirs(d, exist_ok=True)
    return d


def normalise_url(url):
    """Strip the fragment and a trailing slash so the same page keys to one entry."""
    u = urllib.parse.urlsplit(url)
    path = u.path.rstrip("/") or "/"
    return urllib.parse.urlunsplit((u.scheme.lower(), u.netloc.lower(), path, u.query, ""))


def cache_path(url):
    key = hashlib.sha256(normalise_url(url).encode()).hexdigest()
    return os.path.join(cache_dir(), key + ".json")


def cache_read(url):
    path = cache_path(url)
    try:
        with open(path, encoding="utf-8") as f:
            entry = json.load(f)
    except (OSError, ValueError):
        return None
    age = datetime.datetime.now().timestamp() - entry.get("stored_at", 0)
    if age > CACHE_TTL:
        return None
    return entry


def cache_write(url, entry):
    entry = dict(entry, stored_at=datetime.datetime.now().timestamp())
    try:
        with open(cache_path(url), "w", encoding="utf-8") as f:
            json.dump(entry, f)
    except OSError:
        # A cache we cannot write is a slower read, never a failed one.
        pass


# ---------- lanes ----------
def lane_direct(url):
    """GET through the host's jar when one exists, else plain. Raises FetchFailed."""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    opener = opener_for(url)
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            raw = r.read(MAX_BYTES)
            charset = r.headers.get_content_charset() or "utf-8"
            ctype = (r.headers.get_content_type() or "").lower()
    except urllib.error.HTTPError as e:
        # Status is reported, not trusted: a 403 here is a refusal, and 2xx still
        # has to clear the content gate upstream.
        raise FetchFailed(f"HTTP {e.code} {e.reason}")
    except Exception as e:
        raise FetchFailed(f"{type(e).__name__}: {e}")
    body = raw.decode(charset, errors="replace")
    if "html" in ctype or "xml" in ctype or body.lstrip().startswith("<"):
        return html_to_text(body)
    return body.strip(), ""


def lane_platform(url, trail):
    """The per-platform keyless endpoint, where one exists. Absent for most hosts.

    Passes the core's own content gate down as `accept` and its extractor as `to_text`, so a
    platform lane judges each of its own lanes individually instead of stopping at the first
    one that returns merely truthy text (the bug where a 69-char `.rss` body masked the
    untried arctic-shift and shreddit lanes), and turns HTML into text with this extractor
    rather than a second one. The gate still runs again on the winning text below
    (looks_like_content), so a lane cannot bypass the gate by miscalling `accept`: this is the
    single definition, reused, not a second gate.
    """
    host = urllib.parse.urlparse(url).netloc.lower()
    if "reddit.com" not in host:
        return None
    import reddit
    text, title, lane_or_trail = reddit.fetch(
        url, opener_for(url), lambda t: looks_like_content(t, url)[0], html_to_text)
    if not text:
        for line in lane_or_trail:
            trail.append(f"platform: {line}")
        return None
    trail.append(f"platform: {lane_or_trail} accepted")
    return text, title


def lane_browser(url, scope):
    """The scope's live logged-in Chrome over CDP. Opt-in only, never automatic.

    This drives the human's real session, so it is visible to the platform and lands in
    the human's history. provision/browser-lane.sh owns starting Chrome: a read must
    never launch a browser as a side effect, so a lane that is down is an error here.
    """
    try:
        p = subprocess.run(["node", CDP_FETCH, scope, url],
                           capture_output=True, text=True, timeout=BROWSER_TIMEOUT)
    except FileNotFoundError:
        raise FetchFailed("node not found: the browser lane needs Node >= 22")
    except subprocess.TimeoutExpired:
        raise FetchFailed(f"browser lane timed out after {BROWSER_TIMEOUT}s")
    if p.returncode != 0:
        raise FetchFailed(f"browser lane exited {p.returncode}: {p.stderr.strip()[:400]}")
    # No title: innerText carries no reliable title line, and guessing one would put an
    # invented string into a note's frontmatter. The core falls back to the URL.
    return p.stdout.strip(), ""


def platform_of(url):
    host = urllib.parse.urlparse(url).netloc.lower()
    for name in ("reddit.com", "linkedin.com", "x.com", "twitter.com"):
        if name in host:
            return name.split(".")[0]
    return "generic"


# ---------- the ladder ----------
def fetch(url, scope=None, use_browser=False, no_cache=False, refresh=False):
    """Walk the ladder and return the output shape. Raises FetchFailed when nothing ran."""
    trail = []
    if not no_cache and not refresh:
        entry = cache_read(url)
        if entry:
            trail.append("cache: hit, within 6h TTL")
            return dict(entry["result"], cached=True, trail=trail)
        trail.append("cache: miss")
    elif refresh:
        trail.append("cache: ignored (--refresh)")
    else:
        trail.append("cache: bypassed (--no-cache)")

    lanes = [("direct", lambda: lane_direct(url)),
             ("platform", lambda: lane_platform(url, trail))]
    if use_browser:
        lanes.append(("browser", lambda: lane_browser(url, scope)))

    errors = []
    gated = False  # some lane produced a body and the gate refused it: that is a wall
    for name, run in lanes:
        if name == "direct":
            trail.append("direct: jar " + ("present" if jar_for(url) else "absent"))
        try:
            got = run()
        except FetchFailed as e:
            trail.append(f"{name}: failed ({e})")
            errors.append(f"{name}: {e}")
            continue
        if got is None:
            if name != "platform":
                trail.append(f"{name}: no lane for this host")
            # else: lane_platform already recorded per-lane detail (or there is no
            # platform lane for this host, in which case it recorded nothing and this
            # is silently equivalent to "no lane").
            continue
        text, title = got
        ok, reason = looks_like_content(text, url)
        if not ok:
            gated = True
            trail.append(f"{name}: rejected by content gate ({reason})")
            continue
        trail.append(f"{name}: accepted ({reason})")
        result = {
            "url": url,
            "platform": platform_of(url),
            "lane": name,
            "cached": False,
            "fetched_at": datetime.datetime.now().isoformat(timespec="seconds"),
            "title": title or url,
            "chars": len(text),
            "text": text,
            "landed": None,
        }
        if not no_cache:
            # Never cache a body the gate rejected: a cached wall reads as content later.
            cache_write(url, {"result": dict(result, trail=None)})
        return dict(result, trail=trail)

    if not use_browser:
        trail.append("browser: not tried (--browser is opt-in; it drives the human's real session)")
    raise Walled(trail, errors, gated)


class Walled(Exception):
    """Every lane refused. `walled` separates "needs credentials" from "network broke"."""

    def __init__(self, trail, errors, gated):
        Exception.__init__(self, "every lane refused or was rejected by the content gate")
        self.trail = trail
        self.errors = errors
        # A gate rejection, or a host answering with a status, is a wall: the request
        # arrived and was refused. Only pure transport failures are exit 3.
        self.walled = gated or any("HTTP" in x for x in errors)


# ---------- landing ----------
def land_note(result, scope):
    slug = slugify(result["title"] or result["platform"])
    anchor = f"read-{datetime.date.today().isoformat()}-{slug}"
    return land(
        result["text"],
        scope=scope,
        type="read",
        title=result["title"],
        source=result["url"],
        source_type=result["platform"],
        slug=slug,
        anchor=anchor,
        extra={
            "platform": result["platform"],
            "lane": result["lane"],
            "url_fetched": result["url"],
        },
    )


# ---------- CLI ----------
def main():
    ap = argparse.ArgumentParser(prog="read.py", description="fetch one external page as text")
    ap.add_argument("url")
    ap.add_argument("--scope", help="scope for --land and for the --browser lane's Chrome")
    ap.add_argument("--json", action="store_true", help="print the output object only")
    ap.add_argument("--land", action="store_true", help="also write a sources/ note")
    ap.add_argument("--browser", action="store_true",
                    help="allow the live Chrome lane (visible to the platform)")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()

    if not re.match(r"^https?://", args.url):
        sys.stderr.write("usage: url must be http(s)\n")
        return EXIT_USAGE
    if args.land and not args.scope:
        sys.stderr.write("usage: --land needs --scope\n")
        return EXIT_USAGE
    # Caught here rather than inside the lane so a malformed command never reports exit 2:
    # a caller reading "walled or blocked" would go hunting for credentials it already has.
    if args.browser and not args.scope:
        sys.stderr.write("usage: --browser needs --scope: the lane is one Chrome per scope\n")
        return EXIT_USAGE

    try:
        result = fetch(args.url, scope=args.scope, use_browser=args.browser,
                       no_cache=args.no_cache, refresh=args.refresh)
    except Walled as e:
        payload = {"url": args.url, "error": str(e), "trail": e.trail}
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            sys.stderr.write(("WALLED: " if e.walled else "FETCH FAILED: ") + str(e) + "\n")
            for line in e.trail:
                sys.stderr.write("  " + line + "\n")
        return EXIT_WALLED if e.walled else EXIT_FETCH_FAILED
    except FetchFailed as e:
        sys.stderr.write(f"FETCH FAILED: {e}\n")
        return EXIT_FETCH_FAILED

    if args.land:
        result["landed"] = land_note(result, args.scope)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{result['platform']} via {result['lane']}"
              + (" (cached)" if result["cached"] else ""))
        print(result["title"])
        print(f"{result['chars']} chars"
              + (f" | landed: {result['landed']}" if result["landed"] else ""))
        print()
        print(result["text"])
    return EXIT_READ


if __name__ == "__main__":
    sys.exit(main())
