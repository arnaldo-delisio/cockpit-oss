# generic

Any host with no platform module: articles, docs, blogs, newsletters, changelogs.

## What works
- **The `direct` lane handles almost all of it.** urllib GET with a browser User-Agent,
  redirects followed, body decoded by the response charset with a utf-8 fallback, capped at
  5MB, then run through the stdlib HTML-to-text extractor (`script`, `style`, `nav`,
  `footer`, `svg`, `noscript`, `form`, `head` dropped; block tags become newlines; entities
  unescaped). Title comes from `<title>`.
- **There is no `platform` lane here**, so a failed direct fetch falls straight to
  `browser` if you passed `--browser`, and otherwise to exit 2.

## What does not work
- **Client-rendered pages** come back as a shell. The extractor reads served HTML, not a
  rendered DOM, so a single-page app yields a nav bar and a loading string. That trips the
  gate's short-body floor (400 chars for a generic host) and reports as walled rather than
  as a thin success. `--browser` is the answer when the page genuinely needs JS.
- **Cloudflare and Anubis interstitials answer HTTP 200.** The gate rejects them by marker,
  not by status. If a new interstitial slips through, add its marker to `BLOCK_MARKERS` in
  `read.py`, in that one constant, and nowhere else.
- **Paywalls** read as either a short teaser or a consent gate. Both are exit 2. A jar in
  `~/.config/cockpit/cookies/<host>.txt` is the fix when the human has a subscription; the
  direct lane picks it up automatically.

## What to expect
No boilerplate stripping beyond dropped tags. This is a modest text extractor, not
Readability, and it must not grow into one: expect some site chrome in the output and
summarize past it.
