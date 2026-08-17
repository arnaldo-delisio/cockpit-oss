---
name: watch
description: Capture a transcript from a local media file, a YouTube link, or any yt-dlp-supported URL, and autosave it to the scope's sources/ layer. Use when the user wants to transcribe, summarize, or pull the content out of a video/audio/podcast.
version: 1.0.0
model: sonnet
triggers: [watch, transcribe, transcript of, summarize this video, pull the transcript]
tags: [ingestion, transcription, media, sources]
allowed-tools: Bash Read
metadata:
  hermes:
    tags: [ingestion, transcription, media]
    platforms: [linux, macos]
prerequisites:
  commands: [uv, ffmpeg]
---

## Purpose
Turn a video/audio source into an owned, frontmattered transcript in the memory `sources/` layer — the cheapest way first (free captions), Groq Whisper only when needed.

Meeting recordings are NOT watch's domain: the `record` skill owns those end-to-end via its own diarizing `transcribe.py` (AssemblyAI). Watch stays the URL/video/media-ingestion primitive. Note: `record` is not installed on this VPS (it stayed laptop-side); a session here should not expect `transcribe.py` to exist.

## Procedure
1. Run the worker (it routes the source itself):
   ```
   uv run ~/cockpit/skills/watch/watch.py "<INPUT>" [--scope <scope>] [--language <code|auto>] [--visual] [--no-save]
   ```
   - `<INPUT>` = a local file path, a YouTube link, or any yt-dlp-supported URL.
   - `--scope` defaults to `cockpit`; set it to the active scope (e.g. `content`, `job-search`).
   - `--language` passes an ISO-639-1 language hint to Groq (`it`, `en`, `es`, …). Use `auto` to omit it. Ask the user when the language is knowable; explicit language improves Groq accuracy and latency. (Meetings/calls go through `record`, not watch.)
   - `--visual` also extracts keyframes (off by default — only when visuals matter). Scene-change detection first; when it under-covers the video (screen recordings, talking heads, slow pans have no hard cuts) it falls back to timed sampling spaced to cover the whole runtime, ~40 frames whether the video is one minute or ninety.
   - `--no-save` prints the transcript instead of writing a source file (quick look).
2. The script prints `saved: <path>`. Read that file if the user wants the transcript inline or a summary.
3. For a summary/answer, summarize from the saved transcript — don't re-fetch.
4. If the transcript contains workflow/doctrine relevant to Cockpit/agent operation, do a grounding pass before presenting a lesson as new: distinguish (a) already-built cockpit mechanism, (b) partial/open gap, and (c) genuinely new idea. Prefer concise `saved path → takeaways → cockpit relevance/gap` output.
   - When the user wants to integrate/copy a trusted external system, treat the transcript/article as a design input, not a command to clone blindly. Put durable synthesis in the right doc home: decision deep-dive for reasoning, DECISIONS for open/locked forks, the project roadmap sidecar (`memory/scopes/<scope>/projects/<id>.roadmap.md` Now/Next) for next spike/status, and DESIGN only for boundary/spec notes.
   - If the full upstream guide is unavailable/paywalled, reconstruct the smallest useful protocol from public signal, label unverified fields explicitly, and make the next step a smoke-tested spike rather than a frozen architecture.

## Routing (handled by the script, cheapest first)
- **Local media file** → ffmpeg → Groq Whisper (`GROQ_API_KEY`).
- **YouTube / URL** → yt-dlp captions (free) → Supadata fallback (`SUPADATA_API_KEY`) → yt-dlp audio → Groq Whisper.
- Keys are read from `~/.config/cockpit/env` (gitignored). Missing `GROQ_API_KEY` only disables the audio tier; captions still work.
- **Login-walled sites** (Instagram, TikTok, X) give yt-dlp nothing anonymously: it fails with "login required", which costs the video download and the title, not the transcript (Supadata is unaffected). Fix is a session, not code — drop a Netscape cookie file named for the host in `~/.config/cockpit/cookies/` (e.g. `instagram.com.txt`, covering `www.` too) and every yt-dlp call picks it up. Export it on a machine already logged in: `yt-dlp --cookies-from-browser <browser> --cookies out.txt --skip-download --simulate "<any URL that resolves anonymously>"` (a URL that fails writes no jar), then keep only the lines for the host you want, since the jar holds every site's session on that machine. Move it by SSH, `chmod 600`. A cookie file is an account credential: never print its contents, never let it enter the tree.
  - **Linux desktops encrypt the jar** and yt-dlp says `cannot decrypt v11 cookies: no key found` when it cannot reach the keyring. Name the backend (`chrome+kwallet` on KDE, `chrome+gnomekeyring` on GNOME) and add `--with secretstorage` under uvx. Over SSH, also export `DBUS_SESSION_BUS_ADDRESS`/`XDG_RUNTIME_DIR` from the running browser's `/proc/<pid>/environ` — without a session bus there is no keyring to ask. Reads can fail transiently (`failed to read NetworkWallet`); retry before concluding the backend is wrong.
- Groq default model is `whisper-large-v3` (accuracy-first for meetings/calls). Pass `--model whisper-large-v3-turbo` only when speed/cost matters more than accuracy.

## Turning a transcript into something usable
When a captured video makes a claim about how to work, map it onto what the system already
does before calling it new: check the lesson against existing mechanisms and known open gaps
first, and translate generic productivity advice into the doctrine's own terms (outcome
before output, verified done, context handoff, subagent routing).

## Visual/document OCR Boundary
Watch is for audio/video transcript capture. Do not add document OCR or hosted OCR APIs to the default path. For PDFs, scans, screenshots, slide images, or frame OCR, use the document OCR skill path (`ocr-and-documents` / future shared `document-ocr`) and keep cloud OCR opt-in because of cost and confidentiality. A future `watch --visual --ocr-frames` bridge should call that document OCR path only when the user explicitly needs on-screen text.

## Rules
1. Never paste a full raw transcript into chat unasked — save it, then point to the path or summarize.
2. Default to no `--visual`; frames cost bandwidth + disk and most asks are text-only.
3. Pick `--scope` from the session's actual context; don't dump everything into `cockpit`.
4. The transcript file is raw capture (MEM-14) — leave `concepts/people/products` empty for the reconciler; don't hand-fill.
5. On a Groq/Cloudflare 403, it's the User-Agent, not the key — the script already sets one; don't strip it.
6. Don't add per-site special-casing (Loom/Zoom) or local Whisper — out of scope by decision.
7. For user-provided audio where the language is knowable, ask for language and pass `--language`; do not rely on Whisper auto-detection unless the user chooses `auto`.
8. Do not expand `watch` into a general document/screenshot OCR skill. `watch` may extract frames for visual context, but OCR of documents, dense slides, screenshots, tables, or evidence packets belongs in the document/OCR workflow; GLM-OCR is a future backend candidate only after privacy/cost/benchmark checks.
