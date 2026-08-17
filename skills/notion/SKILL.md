---
name: notion
description: Read public or link-shared Notion pages as text, with no API key and no login. Only pages Notion already serves to anonymous requests are readable, so private workspace pages are not. Write and edit are not supported yet. Use whenever a Notion URL needs to be read.
version: 1.0.0
triggers: [notion page, notion url, read notion, notion.so, notion.site]
tags: [notion, read, fetch, stdlib]
allowed-tools: Bash Read
---

# notion, the read lane for public Notion pages

Calls the Notion web client's own `POST /api/v3/loadPageChunk` endpoint and renders the
page as markdown-ish text. No API key, no login, Python 3 standard library only.

This does not bypass access control. Notion's server decides what an anonymous request
gets. Link-readable pages come back with `"role":"reader"`, and everything else is
refused. Pages genuinely private to a workspace are not readable by this skill, and no
flag changes that.

## Run

```bash
python3 ~/cockpit/skills/notion/notion_read.py <url> [more urls...]
```

Page text goes to stdout. Banners go to stderr. With several URLs, each page prints under
its own header, and the process exits with the worst code any of them produced, so a
partial failure cannot read as success.

## Contract (do not silently change)

- **Exit 0 = READ.** Content was retrieved and printed.
- **Exit 2 = NOT PUBLIC.** The endpoint answered, and the page is not anonymously
  readable (auth required, or no content returned for that page). Prints a NOT PUBLIC
  banner naming the URL.
- **Exit 3 = FETCH FAILED.** Network error, non-200 status, malformed JSON, or a
  response shape we do not recognize (the endpoint may have changed). Prints a FETCH
  FAILED banner with the underlying reason.
- **Exit 1 = bad CLI usage only** (no arguments, or a URL with no page id in it).
- A caller must be able to tell "this page is gated" apart from "Notion changed the
  endpoint". Never let a failure look like an empty but successful read.

## Scope and limits

- **Read only, for now.** Write, edit, and page creation are not implemented. That is a
  planned expansion, not a capability you can reach today.
- **Anonymously readable pages only.** If Notion would not show it to a logged out
  browser, this skill cannot show it either.
- **Undocumented endpoint.** Notion does not support `loadPageChunk` for outside callers,
  so it can change or break without notice. Exit 3 is the signal that it did.
- **All chunks, up to a cap.** Each request uses `limit: 50` (a limit of 200 gets an HTTP
  400 back), and the tool follows the continuation cursor until the returned stack is
  empty, merging every chunk. It stops after 20 requests; if content is still pending
  then, it prints a `TRUNCATED:` warning to stderr naming the URL and still prints what it
  read. The exit code does not change for that case.
- **Nesting cap of 20 levels.** Blocks nested deeper than that are not read; the first
  time the cap is hit on a page, a `DEPTH CAP:` warning naming the URL goes to stderr.
- Text blocks are rendered: headers, bulleted and numbered lists, to do items, quotes,
  and code. Tables are rendered as markdown tables, with cells in the column order the
  table itself declares, and a separator row only when the table marks its first row as a
  header. Nested blocks are walked to the depth cap above, so content inside a container
  is not lost unless it sits deeper than 20 levels. Images,
  embeds, and database views are skipped.
