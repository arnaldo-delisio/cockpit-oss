---
name: generate-image
description: Generate images via the Codex CLI's built-in image_gen tool, billed through the ChatGPT subscription (no API key). This is the cockpit's image lane; fal.ai is the video lane. Use whenever an image needs to be created from a text prompt.
version: 1.0.0
triggers: [generate image, create an image, make an image, image of]
tags: [image, generation, codex]
allowed-tools: Bash Read Write
---

# generate-image, the image lane wrapper

Wraps `codex exec` around its built-in image_gen tool. Why this lane: image generation
rides the ChatGPT subscription, so there is no per-image cost and no API key to manage.
The prompt travels by file and stdin, never as a shell word, and the outcome is an exit
code you can branch on.

## Run

```bash
# 1. write the image prompt to a file first, never pass prose on the command line
#    (the scratchpad directory is the right place for it)
# 2. run the script, pointing --out at the destination
node ~/cockpit/skills/generate-image/generate-image.mjs <prompt-file> \
  --out <output-path> [--timeout <seconds>]
```

`--timeout` sets the wall clock budget (default 300s). On success the absolute output
path is printed on stdout. On expiry the wrapper allows a short termination grace period
(up to about 7s) before settling, so total wall time can slightly exceed the budget.

## Contract (do not silently change)

- **Exit 0 = GENERATED.** The image exists at `--out` and is non-empty.
- **Exit 2 = IMAGE TOOL UNAVAILABLE.** Codex ran but reported it has no image
  generation tool. Prints an IMAGE TOOL UNAVAILABLE banner.
- **Exit 3 = DID NOT GENERATE.** Spawn failure, non-zero exit, timeout, missing or
  empty output file, or an unreadable/empty prompt file. Prints a NOT GENERATED banner.
- **Exit 1 = bad CLI usage only** (unknown flag, missing argument).
- A failure never looks like success; treat 2 and 3 as "no image exists". Exits 2 and 3
  leave a pre-existing `--out` untouched.

## Prompting notes

- Sizes are prompt-level hints: say "1024x1024" (or the aspect you want) inside the
  prompt text itself.
- Ask for "high quality" when the image carries dense text or fine detail.
- Generation only, no editing: the tool creates fresh images from prompts, it does not
  modify existing ones.

## Output placement

The image lands wherever `--out` points. Saved images that belong to a scope should
land in that scope's workspace, not in the engine tree or a temp directory.
