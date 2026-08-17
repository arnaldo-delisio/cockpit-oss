#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests>=2.31"]
# ///
"""watch — capture a transcript from a local media file, a YouTube link, or any
yt-dlp-supported URL, and autosave it (transcript + frontmatter) to the scope's
sources/ layer (MEM-14).

Routing (cheapest path first):
  local file        -> ffmpeg extract/downsample -> Groq Whisper
  YouTube/other URL -> yt-dlp captions (free) -> Supadata fallback -> yt-dlp audio -> Groq

Cross-brain shared skill: both Claude Code and Hermes invoke it as
  uv run <repo>/skills/watch/watch.py <input> [--visual] [--scope S] [--no-save]
Keys (GROQ_API_KEY, SUPADATA_API_KEY) are read from ~/.config/cockpit/env (layout §7).
"""
import argparse, os, re, sys, json, subprocess, tempfile, shutil, datetime, glob

UA = "Mozilla/5.0 (X11; Linux x86_64) cockpit-watch/1.0"  # Groq/Supadata sit behind Cloudflare; default urllib UA is 403'd
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3"
SUPADATA_URL = "https://api.supadata.ai/v1/transcript"
# Repo root resolved from this script's own location (layout §6: one root rule), via
# realpath rather than abspath since skills are installed as directory symlinks, so
# abspath would resolve the root to the symlink's parent.
COCKPIT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
sys.path.insert(0, os.path.join(COCKPIT, "skills", "lib"))  # watch runs standalone (uv script), so the shared module needs an explicit path
from sources import slugify, assets_dir, land  # noqa: E402
from cookies import cookie_args  # noqa: E402
ENV_FILE = os.path.expanduser("~/.config/cockpit/env")
GROQ_MAX_BYTES = 24 * 1024 * 1024  # stay under Groq's 25 MB upload cap
FRAMES_PER_MIN = 2     # coverage scene detection must reach before it is trusted
TARGET_FRAMES = 40     # clock fallback aims for this many, however long the video is
MIN_FRAME_GAP = 2      # …but never closer together than this many seconds


def log(*a): print("[watch]", *a, file=sys.stderr)


def load_env():
    p = ENV_FILE
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v.strip())


def yt(*args):
    """Run yt-dlp, preferring an installed binary, falling back to ephemeral uvx."""
    base = ["yt-dlp"] if shutil.which("yt-dlp") else ["uvx", "yt-dlp"]
    return subprocess.run(base + COOKIES + list(args), capture_output=True, text=True)


def is_url(s):
    return s.startswith("http://") or s.startswith("https://")


def title_of(src, is_url_):
    if is_url_:
        r = yt("--no-warnings", "--print", "%(title)s", src)
        t = (r.stdout or "").strip().splitlines()
        if t and t[0]:
            return t[0]
        # no title from yt-dlp: fall back to the video id so same-day captures
        # never collide on one shared "untitled" filename
        m = re.search(r"(?:v=|youtu\.be/|/shorts/|/embed/|/reel/|/p/)([\w-]{6,})", src)
        return m.group(1) if m else "untitled"
    return os.path.splitext(os.path.basename(src))[0]


# ---------- transcript sources ----------
def parse_vtt(text):
    out, seen = [], None
    for line in text.splitlines():
        line = line.strip()
        if (not line or line == "WEBVTT" or "-->" in line or line.isdigit()
                or line.startswith(("Kind:", "Language:", "NOTE"))):
            continue
        line = re.sub(r"<[^>]+>", "", line)  # strip inline timing tags
        if line and line != seen:
            out.append(line)
            seen = line
    return " ".join(out).strip()


def captions_via_ytdlp(url, tmp):
    """Free path: pull manual or auto subtitles, no audio download."""
    yt("--no-warnings", "--skip-download", "--write-subs", "--write-auto-subs",
       "--sub-langs", "en.*,it.*", "--sub-format", "vtt",
       "-o", os.path.join(tmp, "cap.%(ext)s"), url)
    vtts = glob.glob(os.path.join(tmp, "*.vtt"))
    if not vtts:
        return None
    text = parse_vtt(open(vtts[0], encoding="utf-8", errors="ignore").read())
    return text or None


def supadata(url):
    key = os.environ.get("SUPADATA_API_KEY", "").strip()
    if not key:
        return None
    import requests
    try:
        r = requests.get(SUPADATA_URL, params={"url": url, "text": "true"},
                         headers={"x-api-key": key, "User-Agent": UA}, timeout=90)
        if r.status_code != 200:
            log("supadata HTTP", r.status_code)
            return None
        j = r.json()
        return (j.get("content") or j.get("transcript") or "").strip() or None
    except Exception as e:
        log("supadata error:", e)
        return None


# ---------- audio -> Groq ----------
def to_audio(src, tmp):
    """Downsample any media to 16 kHz mono opus (small, Whisper-native rate)."""
    out = os.path.join(tmp, "audio.opus")
    r = subprocess.run(["ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000",
                        "-c:a", "libopus", "-b:a", "20k", out],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("ffmpeg audio extraction failed:\n" + r.stderr[-800:])
    return out


def chunk_audio(audio, tmp):
    """If over Groq's cap, split into time segments (re-encode-free copy)."""
    if os.path.getsize(audio) <= GROQ_MAX_BYTES:
        return [audio]
    pat = os.path.join(tmp, "chunk-%03d.opus")
    subprocess.run(["ffmpeg", "-y", "-i", audio, "-f", "segment",
                    "-segment_time", "1200", "-c", "copy", pat],
                   capture_output=True, text=True)
    return sorted(glob.glob(os.path.join(tmp, "chunk-*.opus"))) or [audio]


def groq_transcribe(audio, tmp, language=None, model=GROQ_MODEL):
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GROQ_API_KEY not set in ~/.config/cockpit/env — cannot transcribe audio")
    import requests
    parts = []
    for piece in chunk_audio(audio, tmp):
        data = {"model": model, "response_format": "json", "temperature": "0"}
        if language and language != "auto":
            data["language"] = language
        with open(piece, "rb") as f:
            r = requests.post(GROQ_URL,
                              headers={"Authorization": f"Bearer {key}", "User-Agent": UA},
                              files={"file": (os.path.basename(piece), f)},
                              data=data,
                              timeout=600)
        if r.status_code != 200:
            raise RuntimeError(f"Groq HTTP {r.status_code}: {r.text[:300]}")
        parts.append(r.json().get("text", "").strip())
    return "\n".join(p for p in parts if p).strip()


def duration_of(media):
    """Seconds, or None when ffprobe cannot tell (a stream, a broken container)."""
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", media], capture_output=True, text=True)
    try:
        return float((r.stdout or "").strip())
    except ValueError:
        return None


def visual_frames(src, slug, tmp, is_url_):
    """Optional: extract keyframes for visual context.

    Returns the directory relative to the scope's sources/ dir, because the value is
    written into a note that lives in the shared memory repo: an absolute path would
    bake in this box's home and this checkout's location (and COCKPIT_MEMORY_ROOT can
    move the root anyway), so it would not resolve on any other machine.
    """
    media = src
    if is_url_:
        out = os.path.join(tmp, "video.mp4")
        yt("--no-warnings", "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", out, src)
        if not os.path.exists(out):
            log("--visual: video download failed; skipping frames")
            return None
        media = out
    fdir, rel = assets_dir(ARGS_SCOPE, slug)
    pat = os.path.join(fdir, "frame-%03d.jpg")

    def cut(vf, extra=()):
        for old in glob.glob(os.path.join(fdir, "frame-*.jpg")):
            os.remove(old)
        subprocess.run(["ffmpeg", "-y", "-i", media, "-vf", vf, *extra, pat],
                       capture_output=True, text=True)
        return len(glob.glob(os.path.join(fdir, "frame-*.jpg")))

    n = cut("select=gt(scene\\,0.4)", ("-vsync", "vfr"))
    minutes = (duration_of(media) or 0) / 60
    if minutes and n < max(2, round(minutes * FRAMES_PER_MIN)):
        # Screen recordings, talking heads, and slow pans have no hard cuts, so scene
        # detection can return a frame or two for an entire video. Sample on a clock
        # instead, spacing frames to cover the whole thing rather than truncating it.
        every = max(MIN_FRAME_GAP, round(minutes * 60 / TARGET_FRAMES))
        log(f"--visual: scene detection found {n} frame(s) in {minutes:.1f} min;"
            f" sampling every {every}s instead")
        n = cut(f"fps=1/{every}")
    return rel if n else None


ARGS_SCOPE = "cockpit"
COOKIES = []


def main():
    global ARGS_SCOPE, COOKIES
    ap = argparse.ArgumentParser(prog="watch")
    ap.add_argument("input", help="local media path, YouTube link, or yt-dlp URL")
    ap.add_argument("--scope", default="cockpit", help="memory scope (default: cockpit)")
    ap.add_argument("--visual", action="store_true", help="also extract scene-change frames")
    ap.add_argument("--no-save", action="store_true", help="print transcript, do not autosave")
    ap.add_argument("--model", default=GROQ_MODEL, help="Groq whisper model")
    ap.add_argument("--language", help="input language as ISO-639-1 code (e.g. en, it, es); use 'auto' to omit")
    a = ap.parse_args()
    ARGS_SCOPE = a.scope
    load_env()

    src, urly = a.input, is_url(a.input)
    if not urly and not os.path.exists(src):
        sys.exit(f"[watch] not a URL and not an existing file: {src}")
    if urly:
        COOKIES = cookie_args(src)
        if COOKIES:
            log("using session cookies:", COOKIES[1])

    title = title_of(src, urly)
    slug = slugify(title)
    method, text = None, None

    with tempfile.TemporaryDirectory() as tmp:
        if urly:
            text = captions_via_ytdlp(src, tmp)
            if text:
                method = "captions"
            else:
                text = supadata(src)
                if text:
                    method = "supadata"
            if not text:
                log("no captions; downloading audio for Groq…")
                r = yt("--no-warnings", "-x", "--audio-format", "opus",
                       "-o", os.path.join(tmp, "dl.%(ext)s"), src)
                got = glob.glob(os.path.join(tmp, "dl.*"))
                if not got:
                    sys.exit("[watch] yt-dlp audio download failed:\n" + r.stderr[-600:])
                text = groq_transcribe(to_audio(got[0], tmp), tmp, a.language, a.model)
                method = "groq-whisper"
        else:
            text = groq_transcribe(to_audio(src, tmp), tmp, a.language, a.model)
            method = "groq-whisper"

        if not text:
            sys.exit("[watch] no transcript produced")

        frames = visual_frames(src, slug, tmp, urly) if a.visual else None

    if a.no_save:
        print(text)
        return
    path = land(text, scope=a.scope, type="transcript", title=title, slug=slug,
                source=src,
                source_type="youtube" if (urly and re.search(r"youtu\.?be", src)) else ("url" if urly else "local"),
                anchor=f"watch-{datetime.date.today().isoformat()}-{slug}",
                extra={"method": method, "frames": frames,
                       "language": a.language or "auto", "model": a.model})
    print(f"saved: {path}")
    # stored relative to the note, resolved here so the operator can open it directly
    where = f" | frames: {os.path.join(os.path.dirname(path), frames)}" if frames else ""
    print(f"method: {method} | {len(text)} chars{where}")


if __name__ == "__main__":
    main()
