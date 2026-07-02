<div align="center">

# 🗂️ Claude Session Dashboard

**A local dashboard that shows _what you built with Claude Code_ — per work session.**

Plain-language summaries · files changed · token usage · estimated cost.

<br>

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)
![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwindcss&logoColor=white)
![No API key](https://img.shields.io/badge/ANTHROPIC__API__KEY-not%20required-success)

</div>

---

## ✨ What it does

Every Claude Code session you run gets captured, summarized, and laid out on a local
dashboard — so you can see your work history at a glance, with real token counts and a
cost estimate, **without** an `ANTHROPIC_API_KEY`.

It has two parts:

| Part | What it is |
| ---- | ---------- |
| 🪝 **Hook** (`tools/feature-logger/`) | A global Claude Code hook that records each session — files, tokens, commands — and writes a Claude-authored _"what we did"_ summary at session end. The summary uses `claude -p`, riding your existing Claude Code subscription. |
| 📊 **Dashboard** (this app) | A Next.js app that reads those records and displays them, grouped by lifecycle status. |

## ⚙️ How it works

```
Claude Code session
   │  SessionStart      → seeds a "To do" record (started, not picked up)
   │  UserPromptSubmit  → "In progress" (clears any waiting state)
   │  Stop (every turn) → records files, tokens, commands, prompts;
   │                       marks "Finished — waiting for input"
   │  Notification      → "Waiting for you" when Claude needs a permission accepted
   │  PostToolUse       → clears "Waiting for you" once the tool runs (accepted)
   │  SessionEnd (once) → "Done": `claude -p` writes the narrative + its cost
   ▼
~/.claude/feature-log/<project>/<session>.json
   ▼
Next.js dashboard  (groups by status; polls every 3s for near-live updates)
```

Each record carries a lifecycle **status**, derived on read:

| Badge | Meaning |
| ----- | ------- |
| ⚪ **To do** | Session started, no work captured yet (0 iterations, 0 changes). |
| 🟡 **Waiting for you** | Claude is paused on a permission prompt — needs you to accept. |
| 🔵 **In progress** | Actively being worked on. |
| 🩵 **Finished — waiting for input** | Claude ended its turn; waiting for your next message. |
| 🟢 **Done** | Finished, with a Claude-written summary (session ended). |

The waiting/finished states are driven live by Claude Code hooks and the dashboard's 3s
poll. Token counts come straight from the transcript's `usage` data (zero LLM cost). The
end-of-session summary is the **only** LLM call, bounded by a compact prompt.

## ✅ Approving permissions from the dashboard

Toggle the header **CLI mode / Dashboard mode** button. In **Dashboard mode**, when a
session needs permission to run a gated tool (`Bash`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`), its card shows the command/file with **Approve** / **Deny** buttons.
Don't answer within ~5 minutes and it falls back to the normal terminal prompt.
**CLI mode** (the default) changes nothing — answer in the terminal as usual.

Only one surface is live at a time: while Dashboard mode waits for your click the
terminal isn't prompting yet; on timeout it hands back to the terminal. Powered by a
second hook, `tools/approval-gate/approval-gate.mjs`, installed by `npm run hooks`.

### Sending a prompt from the dashboard

In **Dashboard mode**, when a session finishes a turn its card shows a **Send a
follow-up prompt** box. Type an instruction and **Send** — the session continues with
it. A **wait** dropdown (next to the mode toggle) sets the shared dashboard wait window —
how long a finished session waits for a prompt **and** how long a permission prompt
waits for an approval (1–10 min; 10 is Claude's hook ceiling). You can only send/approve
within that window — once it lapses, control falls back (idle for prompts, terminal
prompt for approvals).

Powered by a third hook, `tools/prompt-relay/prompt-relay.mjs` (a `Stop` hook),
installed by `npm run hooks`.

## 🚀 Setup

### 1. Install the hook _(one time, global)_

```bash
node tools/feature-logger/install.mjs
```

Copies the logger to `~/.claude/feature-logger/` and merges the `SessionStart`,
`UserPromptSubmit`, `Notification`, `PostToolUse`, `Stop`, and `SessionEnd` hooks into
`~/.claude/settings.json` (backs up first, never touches the managed
`launcher-settings.json`). **Start a new Claude Code session** for the hooks to load.

Re-run any time to update — `npm run hooks` (or the command above) re-copies the latest
script, adds new hook events, and prunes ones it no longer uses, leaving other tools'
hooks untouched. See [`tools/feature-logger/README.md`](tools/feature-logger/README.md)
for manual install + testing.

### 2. Run the dashboard

```bash
npm install
npm run dev      # → http://localhost:3000
```

The dashboard reads `~/.claude/feature-log/`. If it's empty, work in a Claude Code
session (with the hook installed) and refresh.

> **Remove the hook later:** `node tools/feature-logger/uninstall.mjs`
> (backs up `settings.json`, leaves captured records in place).

## 📜 Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build (type-check + lint) |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm test` | Run unit tests (`node --test`) |
| `npm run hooks` | Install/update the feature-logger hooks in `~/.claude/settings.json` |

## 🗂️ Project layout

```
tools/feature-logger/
  feature-logger.mjs   # standalone hook (no deps) — lifecycle + live status
  install.mjs          # installer/updater for BOTH hooks (adds + prunes)
  uninstall.mjs        # reverses install.mjs (backs up settings.json)
  README.md            # hook docs + manual install + testing
tools/approval-gate/
  approval-gate.mjs    # PreToolUse hook — routes gated approvals to the dashboard
tools/prompt-relay/
  prompt-relay.mjs     # Stop hook — sends dashboard prompts into a session
src/
  app/page.tsx         # server: reads feature log + mode + pending + awaiting → <FeatureDashboard>
  app/layout.tsx
  app/api/mode/route.ts          # POST: set CLI/Dashboard mode
  app/api/decision/route.ts      # POST: write an allow/deny decision
  app/api/prompt/route.ts        # POST: queue a follow-up prompt for a session
  app/api/relay-window/route.ts  # POST: set the prompt wait window
  components/
    FeatureDashboard.tsx  # stats header + project filter + list (client)
    FeatureItem.tsx       # one session: summary, files, token breakdown, cost
    StatsHeader.tsx       # totals: features, projects, output tokens, est. cost
    ModeToggle.tsx        # CLI/Dashboard mode switch (client)
    PendingApproval.tsx   # Approve/Deny panel for a paused session (client)
    SendPrompt.tsx        # follow-up prompt box (client)
    RelayWindowSelect.tsx # wait-window dropdown (client)
  lib/
    featureLog.ts      # reads/validates ~/.claude/feature-log/**/*.json (server)
    featureTypes.ts    # client-safe types + aggregate()
    approvals.ts       # mode + pending-approval + relay-window/prompt read/write (server)
    pricing.ts         # token → USD estimate (per-model rates, cache discounts)
    format.ts          # deterministic token/USD/date formatters
```

## 💰 Cost estimation

Per-session cost is estimated from token counts and a per-model price map
(`src/lib/pricing.ts`): input/output at list price, cache reads ≈ 0.1× input, cache
writes ≈ 1.25× input. The end-of-session summary also records its own real
`total_cost_usd` reported by `claude -p`.

## 🔒 Privacy

Feature-log records contain file paths, commands, your prompts, and summaries. They live
under `~/.claude/feature-log/` on your machine. **This is a local dev tool — don't deploy
it publicly.**
