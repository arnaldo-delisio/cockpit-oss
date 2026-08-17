#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""sources — shared landing primitives for the scope's sources/ layer (MEM-14).

Extracted from watch.py so any writer (watch, record's transcribe.py, others) lands
notes with the same slug, frontmatter, and append-only behaviour, instead of each
writer re-deriving them.
"""
import os, re, sys, json, datetime

# Repo root resolved from this script's own location (layout §6: one root rule), via
# realpath rather than abspath since skills are installed as directory symlinks, so
# abspath would resolve the root to the symlink's parent.
# lib/ sits one level deeper than watch/, so one extra dirname than watch.py.
COCKPIT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
# MEM-32 seam: COCKPIT_MEMORY_ROOT overrides the in-tree memory root (paths.mjs semantics).
MEMORY_ROOT = os.environ.get("COCKPIT_MEMORY_ROOT") or os.path.join(COCKPIT, "memory")

# Keys the engine owns: a caller passing these through extra would silently corrupt the
# contract. distilled_into is the reconciler's consumed-marker (memory-engine/dossiers.mjs:268,
# documented at memory-engine/read-pass.mjs:169), so a caller overriding it would break
# distillation silently. The rest are either explicit `land` parameters or fixed lines
# emitted below.
#
# The guard in `land` covers three surfaces, not just this set: the key NAME (this set), the
# key SYNTAX (a trailing space makes "scope " a duplicate `scope` to a YAML reader), and the
# VALUE (a newline inside a value forges a whole extra frontmatter line, reaching the very
# keys this set protects). The value was the hole. A duplicated mapping key makes js-yaml
# throw, and read-pass.mjs:186 swallows that into `frontmatter = null`, silently dropping
# the note from ingestion.
RESERVED_KEYS = {
    "distilled_into", "scope", "session_anchor", "schema_version",
    "type", "title", "source", "source_type", "captured", "status",
    "concepts", "people", "products",
}

_KEY_RE = re.compile(r"[a-z][a-z0-9_]*")
_COMPONENT_RE = re.compile(r"[\w.-]+")

# YAML plain scalars that would not survive unquoted.
_UNSAFE_FIRST = set("[{}],&*#?|-<>=!%@`\"'")
_YAML_WORDS = {"true", "false", "yes", "no", "on", "off", "null", "~",
               "y", "n", "t", "f"}


def _check_component(name, value):
    """A scope or slug is one path component, never a path: otherwise `makedirs` below
    happily creates the escape and lands the note outside the scope's sources dir."""
    if not isinstance(value, str) or not _COMPONENT_RE.fullmatch(value):
        raise ValueError(
            f"{name} must be a single path component, not a path: {value!r}")


def _needs_quoting(s):
    if s == "" or s != s.strip():
        return True
    if ": " in s or s.endswith(":") or " #" in s:
        return True
    if s[0] in _UNSAFE_FIRST:
        return True
    if s.lower() in _YAML_WORDS:
        return True
    try:  # a text value that would read back as a number
        float(s)
        return True
    except ValueError:
        return False


def _yaml_scalar(v, *, always=False):
    """Emit a value as a YAML scalar, single-quoting by doubling embedded quotes ('' is
    YAML's actual escape rule; the old `repr` emitted backslash escapes, which a
    single-quoted YAML scalar does not honour, so the line was a parse error).

    This deliberately breaks byte-identity with the pre-migration output ONLY for inputs
    whose old output was invalid YAML — notes the reconciler silently dropped. Values that
    already survive as plain scalars (a URL, `youtube`, `captured`, an anchor, a method
    name) keep their exact current bytes.
    """
    s = str(v)
    if always or _needs_quoting(s):
        return "'" + s.replace("'", "''") + "'"
    return s


def slugify(s):
    s = re.sub(r"[^\w\s-]", "", s.lower()).strip()
    s = re.sub(r"[\s_-]+", "-", s)
    return (s or "untitled")[:60]


def assets_dir(scope, slug):
    """Directory for a source's extracted assets (frames, etc), plus its stored form.

    Returns (abs_dir, rel_dir): rel_dir is relative to the scope's sources/ dir, because
    that value is written into a note that lives in the shared memory repo: an absolute
    path would bake in this box's home and this checkout's location (and
    COCKPIT_MEMORY_ROOT can move the root anyway), so it would not resolve on any other
    machine.
    """
    _check_component("scope", scope)
    _check_component("slug", slug)
    abs_dir = os.path.join(MEMORY_ROOT, "scopes", scope, "sources", "assets", slug)
    os.makedirs(abs_dir, exist_ok=True)
    return abs_dir, os.path.join("assets", slug)


# ---------- save ----------
def land(text, *, scope, type, title, source, source_type, slug, anchor,
         captured=None, date=None, status="captured", extra=None):
    _check_component("scope", scope)
    _check_component("slug", slug)
    if not anchor:
        raise ValueError("anchor is required: callers own their anchor convention")
    if extra is not None and not hasattr(extra, "items"):
        # `type` the builtin is shadowed by this function's `type` parameter.
        raise ValueError(f"extra must be a mapping, got {extra!r}")
    if extra:
        for k, v in extra.items():
            if k in RESERVED_KEYS:
                raise ValueError(f"extra cannot override {k!r}: it is engine contract")
            if not isinstance(k, str) or not _KEY_RE.fullmatch(k):
                raise ValueError(
                    f"invalid extra key {k!r}: frontmatter keys are lowercase words "
                    "(letters, digits, underscore)")
            if "\n" in str(v) or "\r" in str(v):
                raise ValueError(
                    f"value for {k!r} may not span lines: it would forge a frontmatter key")
    captured = captured or datetime.datetime.now().isoformat(timespec="seconds")
    date = date or datetime.date.today().isoformat()

    sdir = os.path.join(MEMORY_ROOT, "scopes", scope, "sources")
    os.makedirs(sdir, exist_ok=True)
    # raw capture is append-only (MEM-14): never overwrite an existing source
    path = os.path.join(sdir, f"{date}-{slug}.md")
    n = 2
    while os.path.exists(path):
        path = os.path.join(sdir, f"{date}-{slug}-{n}.md")
        n += 1

    fm = [
        "---", f"type: {type}", f"title: {_yaml_scalar(title, always=True)}",
        f"source: {_yaml_scalar(source)}", f"source_type: {_yaml_scalar(source_type)}",
        f"captured: {captured}", f"session_anchor: {_yaml_scalar(anchor)}",
        f"scope: {scope}", f"status: {_yaml_scalar(status)}",
    ]
    for k, v in (extra or {}).items():
        if v:
            fm.append(f"{k}: {_yaml_scalar(v)}")
    fm += ["distilled_into: []", "concepts: []", "people: []", "products: []",
           "schema_version: 1", "---", "", text, ""]
    open(path, "w", encoding="utf-8").write("\n".join(fm))
    return path


# ---------- CLI ----------
# record's transcribe.py is a real, machine-local writer of sources/ notes living outside
# this repo, so it cannot import a repo-relative module; it shells out to this CLI instead.
# Authored prose must never travel as a shell argument, hence stdin rather than argv.
def main():
    if len(sys.argv) < 2 or sys.argv[1] != "land":
        sys.exit("usage: sources.py land --json  (reads one JSON object from stdin)")
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"malformed JSON on stdin: {e}"}))
        sys.exit(2)
    if not isinstance(payload, dict):
        print(json.dumps({"error": "stdin must be one JSON object, got "
                                   f"{type(payload).__name__}"}))
        sys.exit(2)
    text = payload.pop("text", "")
    try:
        path = land(text, **payload)
    except (ValueError, TypeError) as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(2)
    print(json.dumps({"path": path}))


if __name__ == "__main__":
    main()
