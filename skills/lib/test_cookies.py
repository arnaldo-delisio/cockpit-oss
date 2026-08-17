#!/usr/bin/env python3
"""Smoke test for cookies.py: jar lookup, both call shapes, and the no-values rule.

cookies.py reads COCKPIT_COOKIES_DIR at import time, so the env var must be set to a
throwaway directory before the module is ever imported. That import happens inside
setUpModule, never at file top level, so no test can read the box's real jars (live
account credentials) by accident.
"""
import unittest
import tempfile
import os
import json
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))

TMP_DIR = None
cookies = None

# A minimal valid Netscape jar. The distinctive value string is what test 5 hunts for.
SECRET_VALUE = "ZZ-do-not-leak-this-value-ZZ"
JAR = (
    "# Netscape HTTP Cookie File\n"
    ".example.com\tTRUE\t/\tFALSE\t0\tsessionid\t" + SECRET_VALUE + "\n"
    ".example.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tabc123\n"
)


def setUpModule():
    global TMP_DIR, cookies
    TMP_DIR = tempfile.mkdtemp(prefix="cockpit-test-cookies-")
    os.environ["COCKPIT_COOKIES_DIR"] = TMP_DIR
    sys.path.insert(0, os.path.join(REPO, "skills", "lib"))
    import cookies as _cookies
    cookies = _cookies
    # The whole point of COCKPIT_COOKIES_DIR is that reads never touch the real jar
    # home; assert the module actually picked up the override.
    assert cookies.COOKIE_DIR == TMP_DIR


def write_jar(name, text=JAR):
    path = os.path.join(TMP_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


# The pre-migration watch.py implementation, copied verbatim from
# `git show 086c8f7^:skills/watch/watch.py`. cookie_args must still agree with it: the
# extraction is a migration, and watch's behaviour is the contract.
def watch_cookie_args_before_migration(url):
    from urllib.parse import urlsplit
    host = (urlsplit(url).hostname or "").lower()
    parts = host.split(".")
    for i in range(len(parts) - 1):
        path = os.path.join(cookies.COOKIE_DIR, ".".join(parts[i:]) + ".txt")
        if os.path.exists(path):
            return ["--cookies", path]
    return []


class TestJarLookup(unittest.TestCase):
    def test_parent_domain_jar_covers_subdomain(self):
        # One example.com.txt has to cover www.example.com, or every site needs a jar
        # per hostname.
        path = write_jar("example.com.txt")
        self.assertEqual(cookies.jar_for("https://www.example.com/x"), path)
        self.assertEqual(cookies.jar_for("https://example.com/"), path)
        self.assertIsNone(cookies.jar_for("https://nosuchsite.test/x"))


class TestCookieArgs(unittest.TestCase):
    def test_shape_matches_pre_migration_watch(self):
        path = write_jar("example.com.txt")
        for url in ("https://www.example.com/x", "https://example.com/",
                    "https://nosuchsite.test/x", "https://localhost/x"):
            self.assertEqual(cookies.cookie_args(url),
                             watch_cookie_args_before_migration(url), url)
        self.assertEqual(cookies.cookie_args("https://www.example.com/x"), ["--cookies", path])
        self.assertEqual(cookies.cookie_args("https://nosuchsite.test/x"), [])


class TestOpener(unittest.TestCase):
    def _jar_of(self, opener):
        import urllib.request
        for h in opener.handlers:
            if isinstance(h, urllib.request.HTTPCookieProcessor):
                return h.cookiejar
        return None

    def test_opener_carries_jar_cookies(self):
        # Asserted against the opener's own cookie processor, so the check needs no
        # network and no live site.
        write_jar("example.com.txt")
        jar = self._jar_of(cookies.opener_for("https://www.example.com/x"))
        self.assertIsNotNone(jar)
        self.assertEqual(sorted(c.name for c in jar), ["csrftoken", "sessionid"])

    def test_plain_opener_when_no_jar(self):
        opener = cookies.opener_for("https://nosuchsite.test/x")
        self.assertIsNone(self._jar_of(opener))
        self.assertTrue(hasattr(opener, "open"))

    def test_netscape_writer_format_is_loadable(self):
        # The jar fixture is the exact format cdp-cookies.mjs writes (field order,
        # TRUE/FALSE casing, 0 for a session cookie). If http.cookiejar can load it,
        # the writer's format contract holds; a jar only yt-dlp reads is a failed export.
        write_jar("format.test.txt")
        jar = self._jar_of(cookies.opener_for("https://format.test/x"))
        by_name = {c.name: c for c in jar}
        self.assertEqual(by_name["sessionid"].domain, ".example.com")
        self.assertTrue(by_name["csrftoken"].secure)
        self.assertFalse(by_name["sessionid"].secure)

    def test_malformed_jar_raises_instead_of_downgrading(self):
        # A silent fall back to an uncredentialed opener looks exactly like the site
        # refusing us, which sends the caller off diagnosing the wrong thing.
        write_jar("broken.test.txt", "this is not a cookie jar\n")
        with self.assertRaises(RuntimeError) as ctx:
            cookies.opener_for("https://broken.test/x")
        self.assertIn("broken.test.txt", str(ctx.exception))


class TestJarSummary(unittest.TestCase):
    def test_summary_reports_names_never_values(self):
        path = write_jar("summary.test.txt")
        s = cookies.jar_summary(path)
        self.assertEqual(s["host"], "summary.test")
        self.assertEqual(s["cookies"], 2)
        self.assertEqual(sorted(s["names"]), ["csrftoken", "sessionid"])
        # A cookie value is a live credential: it must not reach chat, a log, or shell
        # history, so it must appear nowhere in what this function hands back.
        self.assertNotIn(SECRET_VALUE, repr(s))


CDP_COOKIES_MJS = os.path.join(REPO, "skills", "lib", "cdp-cookies.mjs")


class TestCdpCookiesMatch(unittest.TestCase):
    """cdp-cookies.mjs's `matches(cookieDomain, domain)` decides which cookies from the
    live browser profile go into the exported jar. It is a pure function exported from a
    .mjs, so it is exercised here via a single `node --input-type=module` subprocess that
    asserts every case and prints ALL OK; Python has no stdlib way to call into a JS
    module directly, and this keeps `python3 skills/lib/test_cookies.py` as the one
    entry point that runs everything (option (a) from the task: no sibling
    node:test file needed since the matcher needed no other exercising machinery).
    """

    def test_match_rule_cases(self):
        cases = [
            # (cookieDomain, requestedDomain, expected) - domain relevance, never a value.
            (".linkedin.com", "www.linkedin.com", True),   # dot-parent
            (".www.linkedin.com", "linkedin.com", True),   # subdomain
            ("linkedin.com", "linkedin.com", True),        # exact
            (".LinkedIn.COM", "linkedin.com", True),       # case-insensitive
            (".evil-linkedin.com", "linkedin.com", False),  # sibling, bare-suffix trap
            (".linkedin.com.attacker.net", "linkedin.com", False),  # attacker suffix trap
        ]
        assertions = "\n".join(
            f"assert.strictEqual(matches({json.dumps(c)}, {json.dumps(d)}), {str(e).lower()}, "
            f"{json.dumps(f'matches({c!r}, {d!r}) should be {str(e).lower()}')});"
            for c, d, e in cases
        )
        script = (
            f"import {{ matches }} from {CDP_COOKIES_MJS!r};\n"
            "import assert from 'node:assert';\n"
            f"{assertions}\n"
            "console.log('ALL OK');\n"
        )
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ALL OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
