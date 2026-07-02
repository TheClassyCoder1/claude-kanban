# Feature Logger (Claude Code hook)

Records what each Claude Code **work session** did — files changed, token usage, and a
plain-language "what we did" summary — to `~/.claude/feature-log/`. The companion app
(this repo) reads those files and shows them as a **Feature Dashboard**.

No `ANTHROPIC_API_KEY` required: the end-of-session summary is written by `claude -p`,
which uses your existing Claude Code subscription.

## How it works

It registers six global hooks that map to a lifecycle status the dashboard shows:

- **`SessionStart`** → seeds a record so the session shows as **To do** (started, not
  picked up yet) even before any work happens.
- **`UserPromptSubmit`** → clears any live waiting state (back to **In progress**) when you
  send a prompt.
- **`Notification`** → sets **Waiting for you** when the message is a permission prompt
  (matches `/permission/i`); other notifications (e.g. idle) are ignored.
- **`Stop`** (fires every turn) — cheap, no LLM. Parses the session transcript and upserts
  `~/.claude/feature-log/<project-slug>/<session_id>.json` with token totals, files changed
  (bucketed by feature area), key commands, your prompts, and timestamps. Marks the record
  **Finished — waiting for input**. Idempotent: it recomputes from the transcript each turn.
- **`PostToolUse`** → clears **Waiting for you**: a tool only runs once its permission is
  accepted, so reaching PostToolUse means Claude is working again.
- **`SessionEnd`** (fires once when the session ends) — builds a compact prompt from the
  captured data (never the whole transcript) and calls `claude -p --output-format json` to
  write a headline + 2–4 sentence narrative, marking the record **Done**. Falls back to a
  heuristic summary if `claude` isn't available.

The waiting/finished state lives in a `liveState` field on each record; the dashboard
polls every 3s so transitions show up near-live.

Recursion is prevented two ways: the hook exits early when `stop_hook_active` is true, and
it sets `FEATURE_LOGGER_ACTIVE=1` before calling `claude -p` (the child inherits it and
its hooks short-circuit). Every path exits 0, so it never blocks your turn.

## Install

```bash
node tools/feature-logger/install.mjs
```

This copies the script to `~/.claude/feature-logger/` and merges the six hooks into
`~/.claude/settings.json` (backing it up first; it never touches the managed
`launcher-settings.json`). Start a **new** Claude Code session for the hooks to load.

Re-run it (or `npm run hooks`) to **update**: it always re-copies the latest script, adds
any new hook events, and prunes events it no longer registers — other tools' hooks are
left intact.

The same installer also copies `tools/approval-gate/approval-gate.mjs` and registers it
on `PreToolUse`. That hook only acts in **Dashboard mode** (the `~/.claude/feature-log/mode.json`
flag, default `cli` = no-op); in Dashboard mode it routes gated-tool permission prompts to
the dashboard, falling back to the terminal prompt on timeout.

It also copies `tools/prompt-relay/prompt-relay.mjs` and registers it on `Stop`. In
Dashboard mode it blocks a finished turn up to the configured window (`relayWindowMs` in
`mode.json`) waiting for a dashboard-sent prompt, returning it as a continuation; on
timeout the session stops normally. Blocking hooks (approval-gate, prompt-relay) register
`timeout: 600`; feature-logger stays `60`.

## Manual install

If the installer can't write `~/.claude/settings.json` (e.g. a managed/cloud container),
copy `feature-logger.mjs` to `~/.claude/feature-logger/` yourself and add this to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "~/.claude/feature-logger/feature-logger.mjs", "timeout": 60 } ] }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "~/.claude/feature-logger/feature-logger.mjs", "timeout": 60 } ] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "~/.claude/feature-logger/feature-logger.mjs", "timeout": 60 } ] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "~/.claude/feature-logger/feature-logger.mjs", "timeout": 60 } ] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "~/.claude/feature-logger/feature-logger.mjs", "timeout": 60 } ] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "~/.claude/feature-logger/feature-logger.mjs", "timeout": 60 } ] }
    ]
  }
}
```

## Test without installing

You can exercise the hook by piping a synthetic event at a real transcript:

```bash
echo '{"hook_event_name":"Stop","session_id":"test","stop_hook_active":false,
  "cwd":"'"$PWD"'","transcript_path":"<path-to-a-session>.jsonl"}' \
  | node tools/feature-logger/feature-logger.mjs

cat ~/.claude/feature-log/*/test.json
```

Use `"hook_event_name":"SessionEnd"` to also generate the Claude-written summary.

## Privacy

Records contain file paths, commands, your prompts, and a summary — keep them local; the
dashboard is a local dev tool, not something to deploy publicly.
