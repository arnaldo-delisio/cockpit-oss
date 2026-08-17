#!/usr/bin/env python3
"""Read a link-readable Notion page as markdown-ish text.

Uses the Notion web client's own loadPageChunk endpoint. This only returns
pages Notion already serves to anonymous requests; it does not bypass any
access control. Notion's server decides: link-readable pages come back with
"role":"reader", everything else is refused. Undocumented endpoint, so treat
breakage as expected.

usage: notion_read.py <notion-url> [more urls...]

exit codes: 0 read, 1 bad CLI usage, 2 not public, 3 fetch failed.
"""
import json
import re
import sys
import urllib.error
import urllib.request

API = "https://www.notion.so/api/v3/loadPageChunk"
# The endpoint refuses requests that do not look like the web client.
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

EXIT_READ = 0
EXIT_USAGE = 1
EXIT_NOT_PUBLIC = 2
EXIT_FETCH_FAILED = 3


class UsageError(Exception):
    """The URL is unusable, so there is nothing to ask Notion about."""


class NotPublic(Exception):
    """Notion answered, and the answer is that anonymous readers get nothing.

    Kept distinct from FetchFailed on purpose: a caller must be able to tell
    "this page is gated" apart from "Notion changed the endpoint".
    """


class FetchFailed(Exception):
    """We never got an answer we understand: network, status, JSON, or shape."""


def page_id(url):
    """Pull the 32-hex id off the end of a notion URL slug and dash it.

    The id is always the trailing token, so anchor there. Searching loosely
    lets hex letters from the slug itself (the 'e' in 'template') join the
    run and shift the match by a character.
    """
    slug = url.split("?")[0].split("#")[0].rstrip("/")
    slug = slug.split("/")[-1]
    m = re.search(r"([0-9a-f]{32})$", slug.replace("-", ""))
    if not m:
        raise UsageError(f"no page id found in: {url}")
    h = m.group(1)
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def load(pid, cursor=None, chunk_number=0):
    body = {
        "pageId": pid,
        # 50 is the working ceiling here; 200 gets an HTTP 400 back.
        "limit": 50,
        "cursor": cursor or {"stack": []},
        "chunkNumber": chunk_number,
        "verticalColumns": False,
    }
    req = urllib.request.Request(
        API,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        # Notion states refusal through the status line for gated pages.
        if e.code in (401, 403, 404):
            raise NotPublic(f"HTTP {e.code} from loadPageChunk") from e
        raise FetchFailed(f"HTTP {e.code} from loadPageChunk") from e
    except Exception as e:
        raise FetchFailed(f"{type(e).__name__}: {e}") from e

    try:
        data = json.loads(raw)
    except Exception as e:
        raise FetchFailed(f"response was not JSON: {e}") from e
    if not isinstance(data, dict):
        raise FetchFailed("response JSON was not an object")
    return data


# A page longer than this many chunks is pathological, or the cursor is not
# terminating. Either way, stop and say so rather than loop forever.
MAX_CHUNKS = 20


def load_all(pid):
    """Follow the continuation cursor and merge every chunk's block map.

    The response cursor carries a "stack": empty means the page is complete,
    non-empty means more content is pending. Returns (blocks, truncated).
    """
    blocks = {}
    cursor = None
    truncated = False
    for chunk_number in range(MAX_CHUNKS):
        data = load(pid, cursor, chunk_number)

        rm = data.get("recordMap")
        if rm is None:
            # No recordMap at all means the payload is not the shape we parse.
            # That is an endpoint problem, not an access decision.
            raise FetchFailed("no recordMap in response (endpoint may have changed)")
        if not isinstance(rm, dict):
            raise FetchFailed("recordMap was not an object (endpoint may have changed)")

        chunk_blocks = rm.get("block", {})
        if not isinstance(chunk_blocks, dict):
            raise FetchFailed("block map was not an object (endpoint may have changed)")
        blocks.update(chunk_blocks)

        cursor = data.get("cursor")
        if cursor is None:
            # No cursor at all: nothing more is pending.
            break
        if not isinstance(cursor, dict):
            raise FetchFailed("cursor was not an object (endpoint may have changed)")
        stack = cursor.get("stack")
        if stack is None:
            break
        if not isinstance(stack, list):
            raise FetchFailed("cursor.stack was not a list (endpoint may have changed)")
        if not stack:
            break
    else:
        truncated = True
    return blocks, truncated


def spans_text(spans):
    """Join a Notion rich-text value (a list of spans) into plain text."""
    if not spans:
        return ""
    out = []
    for span in spans:
        out.append(span[0] if span else "")
    return "".join(out)


def text_of(val):
    props = val.get("properties")
    if not isinstance(props, dict):
        return ""
    return spans_text(props.get("title"))


def row_cells(node, column_order):
    """Cell texts of a table_row, in the parent table's column order.

    table_row cells live under arbitrary column-id keys, not under "title".
    The parent table carries the authoritative order in
    format.table_block_column_order; only when that is missing do we fall
    back to the row's own key order, which is merely dict insertion order
    and is not guaranteed to match the table's columns.
    """
    props = node.get("properties") or {}
    if not isinstance(props, dict):
        props = {}
    keys = column_order if column_order else list(props.keys())
    return [spans_text(props.get(k)) for k in keys]


# Deep enough for real nesting, shallow enough to stop runaway structures.
MAX_DEPTH = 20


PREFIX = {
    "header": "# ",
    "sub_header": "## ",
    "sub_sub_header": "### ",
    "bulleted_list": "- ",
    "numbered_list": "1. ",
    "to_do": "- [ ] ",
    "quote": "> ",
    "code": "    ",
}


def render(url):
    """Return the page text, or raise NotPublic / FetchFailed / UsageError."""
    pid = page_id(url)
    blocks, truncated = load_all(pid)
    if truncated:
        print(
            f"TRUNCATED: {url}\n  stopped after {MAX_CHUNKS} chunks with more"
            " content still pending",
            file=sys.stderr,
        )
    # A well-formed recordMap carrying no blocks is Notion's way of saying an
    # anonymous reader gets nothing here. That is an access decision, so it
    # stays exit 2 and must not be reported as a broken endpoint.

    entry = blocks.get(pid)
    if not entry:
        # Well-formed answer, but the page itself is absent: Notion served us
        # nothing for this id, which is what a gated or missing page looks like.
        raise NotPublic("Notion returned no content for this page")
    if not isinstance(entry, dict):
        raise FetchFailed("block entry was not an object (endpoint may have changed)")

    role = entry.get("role")
    if role in ("none", "no_permission"):
        raise NotPublic(f"role={role}")

    root = entry.get("value", {})
    if isinstance(root, dict):
        inner = root.get("value")
        if isinstance(inner, dict):
            root = inner
    if not isinstance(root, dict) or not root:
        raise NotPublic("Notion returned no content for this page")

    # Walk from the page root so blocks come out in document order.
    order = root.get("content", []) or list(blocks.keys())

    lines = []

    def node_of(bid):
        entry = blocks.get(bid)
        if not isinstance(entry, dict):
            return {}
        node = entry.get("value", {})
        if not isinstance(node, dict):
            return {}
        inner = node.get("value")
        return inner if isinstance(inner, dict) else node

    def emit_table(node):
        """Render a table block and its rows as one markdown table."""
        fmt = node.get("format", {}) or {}
        column_order = fmt.get("table_block_column_order") or []
        rows = []
        for rid in node.get("content", []) or []:
            row = node_of(rid)
            if not row or row.get("type") != "table_row":
                continue
            cells = row_cells(row, column_order)
            rows.append("| " + " | ".join(cells) + " |")
        if not rows:
            return
        if fmt.get("table_block_header_row") and len(rows) >= 1:
            width = rows[0].count("|") - 1
            rows.insert(1, "| " + " | ".join(["---"] * width) + " |")
        lines.append("\n".join(rows))

    depth_capped = []

    def walk(bid, depth, seen):
        if depth > MAX_DEPTH:
            if not depth_capped:
                depth_capped.append(True)
                print(
                    f"DEPTH CAP: {url}\n  nesting deeper than {MAX_DEPTH} levels"
                    " was not read",
                    file=sys.stderr,
                )
            return
        if bid in seen:
            return
        seen.add(bid)
        node = node_of(bid)
        if not node:
            return
        if node.get("type") == "table":
            emit_table(node)
            return
        txt = text_of(node)
        if txt.strip():
            lines.append(PREFIX.get(node.get("type", ""), "") + txt)
        for child in node.get("content", []) or []:
            walk(child, depth + 1, seen)

    seen = {pid}
    for bid in order:
        walk(bid, 1, seen)

    if not lines:
        # An empty read must never pass for a successful one.
        raise NotPublic("no readable content returned for this page")
    return "\n\n".join(lines)


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return EXIT_USAGE

    worst = EXIT_READ
    for u in argv[1:]:
        print(f"\n{'=' * 70}\n{u}\n{'=' * 70}\n")
        try:
            print(render(u))
        except UsageError as e:
            print(f"BAD USAGE: {e}", file=sys.stderr)
            worst = max(worst, EXIT_USAGE)
        except NotPublic as e:
            print(f"NOT PUBLIC: {u}\n  {e}", file=sys.stderr)
            worst = max(worst, EXIT_NOT_PUBLIC)
        except FetchFailed as e:
            print(f"FETCH FAILED: {u}\n  {e}", file=sys.stderr)
            worst = max(worst, EXIT_FETCH_FAILED)
        except Exception as e:
            # An unrecognized payload shape must land on exit 3, never on the
            # usage code a bare traceback would produce.
            print(
                f"FETCH FAILED: {u}\n  unexpected error: {type(e).__name__}: {e}",
                file=sys.stderr,
            )
            worst = max(worst, EXIT_FETCH_FAILED)
    # Exit with the worst code seen, so a partial failure cannot read as success.
    return worst


if __name__ == "__main__":
    sys.exit(main(sys.argv))
