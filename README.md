<div align="center">

# 🗂️ Claude Code Session Summarizer

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
   │  SessionStart hook       → seeds a "To do" record (started, not picked up)
   │  Stop hook (every turn)  → "In progress": files, tokens, commands, prompts
   │  SessionEnd hook (once)  → "Done": `claude -p` writes the narrative + its cost
   ▼
~/.claude/feature-log/<project>/<session>.json
   ▼
Next.js dashboard  (groups by status — iterations, changes, tokens + est. cost)
```

Each record carries a lifecycle **status**, derived on read:

| Badge | Meaning |
| ----- | ------- |
| 🔵 **To do** | Session started, no work captured yet (0 iterations, 0 changes). |
| 🟡 **In progress** | Has activity, but no end-of-session summary yet. |
| 🟢 **Done** | Finished, with a Claude-written summary. |

Token counts come straight from the transcript's `usage` data (zero LLM cost). The
end-of-session summary is the **only** LLM call, bounded by a compact prompt.

## 🚀 Setup

### 1. Install the hook _(one time, global)_

```bash
node tools/feature-logger/install.mjs
```

Copies the logger to `~/.claude/feature-logger/` and merges `SessionStart` + `Stop` +
`SessionEnd` hooks into `~/.claude/settings.json` (backs up first, never touches the
managed `launcher-settings.json`). **Start a new Claude Code session** for the hooks to
load. See [`tools/feature-logger/README.md`](tools/feature-logger/README.md) for manual
install + testing.

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

## 🗂️ Project layout

```
tools/feature-logger/
  feature-logger.mjs   # standalone Stop + SessionEnd hook (no deps)
  install.mjs          # safe, idempotent global installer
  uninstall.mjs        # reverses install.mjs (backs up settings.json)
  README.md            # hook docs + manual install + testing
src/
  app/page.tsx         # server: reads feature log → <FeatureDashboard>
  app/layout.tsx
  components/
    FeatureDashboard.tsx  # stats header + project filter + list (client)
    FeatureItem.tsx       # one session: summary, files, token breakdown, cost
    StatsHeader.tsx       # totals: features, projects, output tokens, est. cost
  lib/
    featureLog.ts      # reads/validates ~/.claude/feature-log/**/*.json (server)
    featureTypes.ts    # client-safe types + aggregate()
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
