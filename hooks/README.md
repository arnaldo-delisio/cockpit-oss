# hooks/

`settings.template.json` is the single source for the Claude Code hook wiring (capture, recall,
history-search, skill inject/capture). Bootstrap renders it into `~/.claude/settings.json` with
`{{REPO_ROOT}}` and `{{HOME}}` substituted, gated behind `--write-settings` (or `--cutover`); a
flagless run only reports. Hook entries whose script is absent on the box are skipped, so a fresh
VPS without the laptop-local `~/.claude` helpers still installs cleanly.

Hook commands always use absolute paths, on both brains: `~/` does not expand reliably inside a
hook command (Claude Code settings or `~/.hermes/config.yaml`), so the template carries resolved
paths and Hermes hooks are written with `/home/<you>/...` explicitly.
