#!/usr/bin/env python3
"""Smoke test for sources.py: the module and its CLI (stdlib only).

sources.py reads COCKPIT_MEMORY_ROOT at import time, so the env var must be
set to a throwaway directory before the module is ever imported. That import
happens inside setUpModule, never at file top level, so no test can run
against the real memory/ tree by accident.
"""
import unittest
import subprocess
import tempfile
import shutil
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
SOURCES_PY = os.path.join(REPO, "skills", "lib", "sources.py")

TMP_ROOT = None
sources = None


def setUpModule():
    global TMP_ROOT, sources
    TMP_ROOT = tempfile.mkdtemp(prefix="cockpit-test-sources-")
    os.environ["COCKPIT_MEMORY_ROOT"] = TMP_ROOT
    sys.path.insert(0, os.path.join(REPO, "skills", "lib"))
    import sources as _sources
    sources = _sources
    # The whole point of COCKPIT_MEMORY_ROOT is that writes never land in the
    # real memory repo; assert the module actually picked up the override.
    assert sources.MEMORY_ROOT == TMP_ROOT


def tearDownModule():
    # Each run used to leak one temp root under /tmp.
    if TMP_ROOT:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)


class TestLand(unittest.TestCase):
    def test_frontmatter_order_and_body(self):
        # The real invariants are that the frontmatter parses as YAML and that
        # each key appears once: the engine reads it by key, not by position
        # (memory-engine/read-pass.mjs:186). Order is asserted anyway because an
        # unexplained reorder signals an accidental rewrite of this block.
        path = sources.land("hello world", scope="testscope", type="transcript",
                             title="A Title", source="src.mp4", source_type="local",
                             slug="a-title", anchor="anchor-1")
        lines = open(path, encoding="utf-8").read().splitlines()
        expected_order = ["type", "title", "source", "source_type", "captured",
                           "session_anchor", "scope", "status"]
        keys = [l.split(":", 1)[0] for l in lines[1:1 + len(expected_order)]]
        self.assertEqual(keys, expected_order)
        self.assertIn("title: 'A Title'", lines)
        self.assertIn("distilled_into: []", lines)
        self.assertIn("schema_version: 1", lines)
        self.assertIn("hello world", lines)

    def test_append_only_on_collision(self):
        # MEM-14: a raw capture must never be overwritten. Landing the same
        # date+slug twice must produce a second file, with the first file's
        # bytes untouched, not merely a filename that looks untouched.
        kwargs = dict(scope="testscope", type="transcript", title="Dup",
                       source="s", source_type="local", slug="dup-slug",
                       anchor="anchor-dup", date="2026-01-01")
        first = sources.land("first body", **kwargs)
        first_bytes = open(first, "rb").read()
        second = sources.land("second body", **kwargs)
        self.assertNotEqual(first, second)
        self.assertTrue(second.endswith("-2.md"))
        self.assertEqual(open(first, "rb").read(), first_bytes)

    def test_reserved_keys_all_raise(self):
        # Loop the real set, not a hardcoded sample, so a future reserved key
        # is automatically covered without editing this test.
        for key in sources.RESERVED_KEYS:
            with self.assertRaises(ValueError) as ctx:
                sources.land("body", scope="testscope", type="t", title="t",
                              source="s", source_type="local", slug=f"rk-{key}",
                              anchor="a", extra={key: "x"})
            self.assertIn(key, str(ctx.exception))
        # The loop above holds for any set, an empty one included, so pin the
        # keys the engine actually owns as a literal the set can fail against.
        self.assertTrue({"distilled_into", "scope", "session_anchor",
                         "schema_version", "concepts", "people", "products"}
                        <= sources.RESERVED_KEYS)

    def _land(self, **over):
        kwargs = dict(scope="testscope", type="t", title="t", source="s",
                      source_type="local", slug="bypass", anchor="a")
        kwargs.update(over)
        return sources.land("body", **kwargs)

    def test_extra_cannot_duplicate_a_fixed_line(self):
        # concepts/people/products are emitted as fixed lines, so an extra key
        # of that name is a duplicated mapping key: js-yaml throws and
        # read-pass.mjs swallows it into frontmatter = null.
        for key in ("concepts", "people", "products"):
            with self.assertRaises(ValueError):
                self._land(slug=f"fixed-{key}", extra={key: "x"})

    def test_extra_key_syntax_is_rejected(self):
        # "scope " emits "scope : x", which YAML reads as the key `scope`.
        for key in ("scope ", " scope", "Scope", "a-b", "9x", "", "distilled_into:x"):
            with self.assertRaises(ValueError):
                self._land(slug="keysyntax", extra={key: "x"})

    def test_extra_value_cannot_span_lines(self):
        # A newline in a value forges a whole extra frontmatter line, reaching
        # the very key the reserved-key check exists to protect.
        for value in ("ok\ndistilled_into: [fake]", "ok\rx"):
            with self.assertRaises(ValueError):
                self._land(slug="multiline", extra={"note": value})

    def test_traversing_scope_and_slug_are_rejected(self):
        outside = os.path.join(os.path.dirname(TMP_ROOT), "cockpit-test-escape")
        with self.assertRaises(ValueError):
            self._land(scope="../../../../tmp/cockpit-test-escape")
        with self.assertRaises(ValueError):
            self._land(slug="../../../../tmp/cockpit-test-escape")
        with self.assertRaises(ValueError):
            sources.assets_dir("../evil", "s")
        with self.assertRaises(ValueError):
            sources.assets_dir("testscope", "../evil")
        self.assertFalse(os.path.exists(outside))

    def test_extra_must_be_a_mapping(self):
        with self.assertRaises(ValueError):
            self._land(slug="extra-str", extra="some string")

    def test_quote_bearing_title_and_values_parse(self):
        extra = {"note": "value: with colon", "bare": "plainword"}
        path = self._land(slug="quoting", title='Don\'t call it "AI"',
                           source="https://x.example/a?b=c", status="captured",
                           anchor="anchor-1", extra=extra)
        text = open(path, encoding="utf-8").read()
        lines = text.splitlines()
        # Plain-scalar values must keep their exact current bytes.
        self.assertIn("source: https://x.example/a?b=c", lines)
        self.assertIn("source_type: local", lines)
        self.assertIn("status: captured", lines)
        self.assertIn("session_anchor: anchor-1", lines)
        self.assertIn("bare: plainword", lines)
        self.assertIn("""title: 'Don''t call it "AI"'""", lines)
        self.assertIn("note: 'value: with colon'", lines)
        try:
            import yaml
        except ImportError:
            self.skipTest("no YAML library available; quoting shape asserted above")
        fm = yaml.safe_load(text.split("---")[1])
        self.assertEqual(fm["title"], 'Don\'t call it "AI"')
        self.assertEqual(fm["note"], "value: with colon")
        self.assertEqual(fm["source"], "https://x.example/a?b=c")

    def test_extra_ordering_and_falsy_skip(self):
        # extra is emitted in insertion order, and None/"" values are dropped
        # rather than written as empty frontmatter lines.
        from collections import OrderedDict
        extra = OrderedDict([("method", "captions"), ("skip_me", None),
                              ("also_skip", ""), ("frames", "assets/x")])
        path = sources.land("body", scope="testscope", type="t", title="t",
                             source="s", source_type="local", slug="ordering",
                             anchor="a", extra=extra)
        lines = open(path, encoding="utf-8").read().splitlines()
        self.assertNotIn("skip_me", "\n".join(lines))
        self.assertNotIn("also_skip", "\n".join(lines))
        method_idx = lines.index("method: captions")
        frames_idx = lines.index("frames: assets/x")
        self.assertLess(method_idx, frames_idx)

    def test_assets_dir_creates_and_returns_relative(self):
        # An absolute rel_dir would bake in this box's home and checkout
        # location, so it would not resolve when the note is read elsewhere.
        abs_dir, rel_dir = sources.assets_dir("testscope", "some-slug")
        self.assertTrue(os.path.isdir(abs_dir))
        self.assertFalse(os.path.isabs(rel_dir))
        self.assertTrue(rel_dir.startswith("assets"))


class TestCLI(unittest.TestCase):
    def _run(self, stdin_text):
        env = dict(os.environ)
        env["COCKPIT_MEMORY_ROOT"] = TMP_ROOT
        return subprocess.run([sys.executable, SOURCES_PY, "land", "--json"],
                               input=stdin_text, capture_output=True, text=True, env=env)

    def test_cli_happy_path(self):
        payload = {"text": "cli body", "scope": "testscope", "type": "transcript",
                   "title": "CLI Title", "source": "s", "source_type": "local",
                   "slug": "cli-title", "anchor": "cli-anchor"}
        r = self._run(json.dumps(payload))
        self.assertEqual(r.returncode, 0)
        out = json.loads(r.stdout)
        self.assertTrue(os.path.exists(out["path"]))
        self.assertIn("cli body", open(out["path"], encoding="utf-8").read())

    def test_cli_error_paths(self):
        # Malformed JSON, a reserved key, and a missing required key are all
        # caller error: exit 2, a parsed {"error": ...} on stdout, no traceback.
        r_bad_json = self._run("not json")
        self.assertEqual(r_bad_json.returncode, 2)
        self.assertIn("error", json.loads(r_bad_json.stdout))
        self.assertEqual(r_bad_json.stderr, "")

        reserved_payload = {"text": "x", "scope": "testscope", "type": "t", "title": "t",
                             "source": "s", "source_type": "local", "slug": "rk",
                             "anchor": "a", "extra": {"scope": "override"}}
        r_reserved = self._run(json.dumps(reserved_payload))
        self.assertEqual(r_reserved.returncode, 2)
        self.assertIn("error", json.loads(r_reserved.stdout))
        self.assertEqual(r_reserved.stderr, "")

        missing_payload = {"text": "x", "type": "t", "title": "t",
                            "source": "s", "source_type": "local", "slug": "missing",
                            "anchor": "a"}
        r_missing = self._run(json.dumps(missing_payload))
        self.assertEqual(r_missing.returncode, 2)
        self.assertIn("error", json.loads(r_missing.stdout))
        self.assertEqual(r_missing.stderr, "")

    def test_cli_rejects_non_object_payload(self):
        # Valid JSON that is not an object used to traceback at payload.pop.
        for stdin_text in ("[]", '"str"', "3", "null"):
            r = self._run(stdin_text)
            self.assertEqual(r.returncode, 2, stdin_text)
            self.assertIn("error", json.loads(r.stdout))
            self.assertEqual(r.stderr, "")

    def test_cli_rejects_non_mapping_extra(self):
        # A string extra used to AttributeError at .items() with exit 1.
        payload = {"text": "x", "scope": "testscope", "type": "t", "title": "t",
                   "source": "s", "source_type": "local", "slug": "extra-str-cli",
                   "anchor": "a", "extra": "some string"}
        r = self._run(json.dumps(payload))
        self.assertEqual(r.returncode, 2)
        self.assertIn("error", json.loads(r.stdout))
        self.assertEqual(r.stderr, "")


if __name__ == "__main__":
    unittest.main()
