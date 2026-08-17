# linkedin

## URL shapes
- profile: `https://www.linkedin.com/in/<slug>/`
- post: `https://www.linkedin.com/posts/<slug>_<hash>` or `/feed/update/urn:li:activity:<id>/`
- company: `https://www.linkedin.com/company/<slug>/`
- feed: `https://www.linkedin.com/feed/`

## What works, and what does not
- **A cookie jar plus the `direct` lane is the working path.** Export the scope's live
  session with `skills/lib/cdp-cookies.mjs <scope> linkedin.com`, then read normally:
  measured 2026-08-17, a 25-cookie jar (including `li_at`) returned the authenticated feed
  over plain HTTP, exit 0 on lane `direct`. No browser needed for a credentialed read.
- **Anonymous direct fetch gets a login wall or a stub.** Without a jar LinkedIn serves a
  sign-in interstitial for anything past a teaser, and it answers 200 doing so. The content
  gate catches that (`join linkedin`, `sign in to continue`) and falls through rather than
  handing back a wall as content.
- **`--browser` is the fallback**, for what a jar cannot reach. The scope's live logged-in
  Chrome over CDP, run as `--browser --scope <scope>`; the lane must already be up
  (`provision/browser-lane.sh <scope>`), and this skill will not start it.
- No selectors are used. The lane extracts `document.body.innerText` from the rendered
  page, so what you get is what the human would see, in reading order, with the app's
  chrome mixed in. Do not add CSS paths here: none have been verified.

## The side effect, before you run it
Driving the human's real logged-in session means **reading a profile through `--browser`
generates a real, visible profile view for that person**, and everything read lands in the
human's browsing history. It is a side effect of a "read". That is why the lane is opt-in
and why it must be named out loud before use, not discovered afterwards.

## What to expect
Locale: this VPS is a Hetzner datacenter IP and LinkedIn serves it German locale (BUILD-7,
recorded as a standing risk). Expect German UI strings mixed into the extracted text.
