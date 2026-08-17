#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""cookies — shared credentialed-fetch layer over the box's cookie jars.

Extracted from watch.py, which held the only jar code in the tree, so read (and any
later fetcher) uses the same lookup and the same jar format instead of copying it.
Two shapes come out of one lookup: the yt-dlp flag pair, and a urllib opener.
"""
import os
import http.cookiejar
import urllib.request
from urllib.parse import urlsplit

# Login-walled sites (Instagram, TikTok, X) hand a fetcher nothing without a session.
# Drop a Netscape cookie file named for the host here and every caller picks it up; no
# code change per site. Cookies are account credentials, so they live outside the tree
# with the box's other secrets (layout §7).
COOKIE_DIR = os.environ.get("COCKPIT_COOKIES_DIR") or os.path.expanduser("~/.config/cockpit/cookies")


def jar_for(url):
    """Path of the jar holding a session for this URL's host, or None.

    Checks the host and each parent domain, so one instagram.com file covers
    www.instagram.com too.
    """
    host = (urlsplit(url).hostname or "").lower()
    parts = host.split(".")
    for i in range(len(parts) - 1):
        path = os.path.join(COOKIE_DIR, ".".join(parts[i:]) + ".txt")
        if os.path.exists(path):
            return path
    return None


def cookie_args(url):
    """The same lookup as --cookies flags, the shape yt-dlp callers pass straight through."""
    path = jar_for(url)
    return ["--cookies", path] if path else []


def opener_for(url):
    """A urllib opener carrying this host's session, or a plain one when no jar exists.

    A jar that exists but does not parse raises instead of quietly returning an
    uncredentialed opener: the site would then answer as if it refused us, sending the
    caller to diagnose a login wall when the real fault is a malformed file.
    """
    path = jar_for(url)
    if not path:
        return urllib.request.build_opener()
    jar = http.cookiejar.MozillaCookieJar(path)
    try:
        # Session cookies and stale expiries still carry the login on these sites, so
        # load them rather than dropping them on the floor.
        jar.load(ignore_discard=True, ignore_expires=True)
    except (http.cookiejar.LoadError, OSError) as e:
        raise RuntimeError(f"cookie jar {path} is unreadable, refusing to fetch uncredentialed: {e}")
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def jar_summary(path):
    """What a jar holds, in a form safe to print: names only, never values.

    A cookie value is a live credential, so it must never reach chat, a log, or shell
    history; the names are enough to tell a real session from an empty export.
    """
    jar = http.cookiejar.MozillaCookieJar(path)
    jar.load(ignore_discard=True, ignore_expires=True)
    names = [c.name for c in jar]
    host = os.path.basename(path)
    if host.endswith(".txt"):
        host = host[:-4]
    return {"host": host, "cookies": len(names), "names": names}
