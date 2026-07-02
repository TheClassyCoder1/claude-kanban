# Dashboard prompt relay: send a follow-up prompt to a session from the UI

Date: 2026-07-02

## Problem

Dashboard mode already lets you approve permissions from the UI. We also want to
**send a follow-up prompt** to a running session from the dashboard — the mirror of
approvals, on the other end of a turn.

## Mechanism (confirmed)

A `Stop` hook can return `{"decision":"block","reason":"<text>"}` on exit 0. This
makes Claude **not stop** and act on `reason`. `reason` is delivered as a
system-reminder Claude reads and follows — it is best-effort "here's what to do
next", not a formal user turn, but in practice Claude acts on it. Claude **waits**
for the Stop hook to exit (up to the hook `timeout`, max 600s). On timeout with no
`decision`, the session stops normally.

This is the approval pattern applied to `Stop`: block, poll for a dashboard-supplied
prompt, return it as `reason`.

**Load-bearing limitation:** you can only send within the post-turn wait window. Once
that window lapses and the session is fully idle, no blocked hook exists to catch a
prompt — nothing can wake a dead-idle session. (No hook wakes an idle session; same
wall as "can't inject into a live terminal".)

## Scope (v1)

In scope: in Dashboard mode, when a session finishes a turn, block briefly and let the
dashboard send one follow-up prompt that Claude continues with; timeout → idle.

Out of scope: waking a fully-idle session (mechanically impossible via hooks);
queueing multiple prompts; editing/streaming; launching new `claude -p` runs.

## Decisions

- **Same toggle:** Dashboard mode enables both approvals and prompt relay. No new switch.
- **Wait window (configurable from the UI):** default 10 min; the user picks 1/2/5/10 min. Stored in `mode.json` as `relayWindowMs`, read by the hook. `POLL_MS = 1000` (env `RELAY_POLL_MS` for tests). Clamped to `[30_000, 600_000]` — 600_000 is Claude's Stop-hook `timeout` ceiling; going higher would just be killed by Claude.
- **Delivery:** `reason` is set to the user's text, prefixed `Dashboard prompt: ` so Claude reads it as an instruction to act on.
- **One prompt per turn-end.** The queued file is consumed on inject.

### Hook timeout fix (applies to both blocking hooks)

The installer currently registers every hook with `timeout: 60` (seconds). A blocking
poll hook is therefore **killed by Claude at 60s**, regardless of its own poll window —
so today's approval fallback really fires at 60s, not 5 min. Fix: `INSTALLS` entries
carry a per-hook `timeout`; the blocking hooks (`approval-gate`, `prompt-relay`)
register `timeout: 600`, feature-logger stays `60`. Our in-script window then governs
fallback, bounded by Claude's 600s ceiling.

## Architecture

A **new, separate** `Stop` hook — `tools/prompt-relay/prompt-relay.mjs` — alongside
the existing non-blocking feature-logger Stop hook. Both `Stop` hooks run in parallel
(Claude collects all results); feature-logger records the turn and exits fast,
prompt-relay may block. If prompt-relay returns `decision:block`, Claude continues.

```
Claude finishes a turn → Stop → prompt-relay.mjs  (Claude WAITS for it)
  reads stdin: { session_id, cwd }, reads mode.json
  ├─ mode != "dashboard" → exit 0 (instant, normal stop)
  └─ dashboard mode:
       write  ~/.claude/feature-log/awaiting/<sid>.json  { sessionId, createdAt }
       loop every POLL_MS up to WINDOW_MS:
         if queued/<sid>.json exists:
           read { prompt }; delete queued + awaiting
           print {"decision":"block","reason":"Dashboard prompt: <prompt>"}
           exit 0                                   → Claude continues with the text
       window elapsed → delete awaiting → exit 0    → session stops (idle)
  (any error → exit 0 — normal stop, never a spurious continuation)
```

**Loop safety:** the hook only returns `decision:block` when a `queued/<sid>.json`
file exists, and it deletes that file on inject. Each block therefore corresponds to
exactly one user-written prompt; a subsequent Stop with no queued file exits 0. No
infinite loop (independent of `stop_hook_active`).

### State (under `~/.claude/feature-log/`)

| File | Writer | Reader | Shape |
|------|--------|--------|-------|
| `awaiting/<sid>.json` | prompt-relay hook | dashboard RSC | `{ sessionId, createdAt }` |
| `queued/<sid>.json` | dashboard (`POST /api/prompt`) | prompt-relay hook | `{ prompt: string }` |

Reuses `mode.json`, now shaped `{ "mode": "cli"|"dashboard", "relayWindowMs"?: number }`
(back-compat: missing `relayWindowMs` → default 600_000). `awaiting` records older than
the effective window are treated as stale by the reader (a session whose window has
lapsed no longer shows a live Send box).

### Library (`src/lib/approvals.ts` — the dashboard↔session control lib)

Add:
- `RELAY_WINDOW_DEFAULT = 600_000`, `RELAY_WINDOW_MIN = 30_000`, `RELAY_WINDOW_MAX = 600_000`.
- `readRelayWindowMs(): Promise<number>` — from `mode.json`, clamped to `[MIN, MAX]`, default `RELAY_WINDOW_DEFAULT`.
- `writeRelayWindowMs(ms: unknown): Promise<number>` — validate number, clamp to `[MIN, MAX]`, merge into `mode.json` (preserve `mode`), return the stored value.
- `writeMode` updated to merge (preserve `relayWindowMs`).
- `readAwaitingPrompts(now?: number): Promise<{ sessionId: string; createdAt: string }[]>` — fresh only (≤ effective window; use `RELAY_WINDOW_MAX` as the staleness bound so any still-valid awaiting shows).
- `writePrompt(sessionId: unknown, prompt: unknown): Promise<void>` — validate `isSafeSessionId(sessionId)` and that `prompt` is a non-empty string (≤ 10_000 chars); write `queued/<sessionId>.json` atomically. Throw on bad input.

Reuses `isSafeSessionId`, `writeAtomic`, dir helpers.

### API routes

- `POST /api/prompt` — body `{ sessionId, prompt }`. Delegates to `writePrompt`; 200
  `{ok:true}` or 400. `runtime = "nodejs"`, `@/lib/approvals`.
- `POST /api/relay-window` — body `{ ms }` (or `{ minutes }`, converted). Delegates to
  `writeRelayWindowMs`; 200 `{ok:true, ms}` or 400.

### Dashboard UI

- New `RelayWindowSelect.tsx` (client): a small 1/2/5/10-min dropdown shown next to the
  mode toggle when in Dashboard mode. On change → `POST /api/relay-window` →
  `router.refresh()`. Current value passed from `page.tsx` via `readRelayWindowMs()`.
- New `SendPrompt.tsx` (client): a `<textarea>` + **Send** button. On submit →
  `POST /api/prompt` → `router.refresh()`, clears the box.
- `page.tsx` reads `readAwaitingPrompts()` → `awaitingSessions: Set<string>`, and
  `readRelayWindowMs()` for the selector, passing both down.
- In `RecordCard`, when `awaitingSessions.has(record.sessionId)`, render `<SendPrompt
  sessionId={record.sessionId} />` beneath the card (same slot family as the approval
  card). Awaiting is only written in Dashboard mode, so its presence gates the UI.
- `attention` count in the tab badge also adds `awaitingSessions.size` (sessions ready
  for your input).

### Installer

`INSTALLS` entries gain a `timeout` field; `hookEntry(command, timeout)` uses it.
- feature-logger → `timeout: 60` (unchanged).
- approval-gate → `timeout: 600` (fixes the 60s-kill bug).
- prompt-relay → `timeout: 600`, `events: ["Stop"]`, new script under `~/.claude/prompt-relay/`.

Per-command prune already isolates each. Because the idempotency check matches by
command only, the merge step must also **refresh the timeout** on an already-present
entry (set `timeout` to `inst.timeout` if it differs) so re-running `npm run hooks`
upgrades old `60`s entries to `600`.

## Error handling & safety

- Hook exits 0 on any error → normal stop (never a spurious continuation).
- Default `cli` mode: no behavior change until opted in (feature-logger's own Stop is
  unaffected).
- `sessionId` path-traversal-guarded; `prompt` validated + length-capped; writes confined
  to `queued/`. Localhost-only.
- The injected text is the user's own; delivered as an instruction to Claude.

## Known shortcuts (ponytail)

- **Can't wake a fully-idle session** — only within the post-turn window. Fundamental.
- **liveState may read `idle` while a continuation runs** — feature-logger set it at the
  turn's Stop; there's no UserPromptSubmit for an injected continuation, so status
  refreshes at the next Stop. Cosmetic.
- **In Dashboard mode every turn-end waits up to 10 min** — the cost of remote-wake.
  Accepted; it's opt-in.

## Files

- Create: `tools/prompt-relay/prompt-relay.mjs`, `tools/prompt-relay/prompt-relay.test.mjs`
- Modify: `src/lib/approvals.ts` (+ `src/lib/approvals.test.ts`) — `readAwaitingPrompts`, `writePrompt`, `readRelayWindowMs`, `writeRelayWindowMs`, merge-`writeMode`
- Create: `src/app/api/prompt/route.ts`, `src/app/api/relay-window/route.ts`
- Create: `src/components/SendPrompt.tsx`, `src/components/RelayWindowSelect.tsx`
- Modify: `src/app/page.tsx`, `src/components/FeatureDashboard.tsx` (thread `awaitingSessions`, `relayWindowMs`, render `SendPrompt` + `RelayWindowSelect`)
- Modify: `tools/feature-logger/install.mjs` (+ `install.test.mjs`) — per-hook `timeout`, third INSTALLS entry, timeout refresh
- Modify: `README.md`, `tools/feature-logger/README.md`

## Testing

- `prompt-relay.test.mjs`: `buildContinue(prompt)` shape (`{decision:"block",reason:"Dashboard prompt: …"}`); `isStaleAwaiting`; integration — spawn with mode=dashboard + Stop event, write `queued` mid-poll, assert stdout `decision:block` + reason contains the prompt + cleanup; cli-mode no-op.
- `approvals.test.ts`: `writePrompt` rejects unsafe id / empty prompt, writes file; `readAwaitingPrompts` drops stale; `writeRelayWindowMs` clamps out-of-range + merges without dropping `mode`; `readRelayWindowMs` default + reflects a write.
- `install.test.mjs`: `INSTALLS` includes prompt-relay on `Stop` with `timeout: 600`, approval-gate `timeout: 600`, feature-logger `60`; re-merge refreshes a stale `60` timeout to `600`; prune isolates the three commands.
- Manual: Dashboard mode → set the window to 1 min via the selector → finish a turn → card shows a Send box → type + Send → Claude continues with the text; on another turn wait out the 1 min → box disappears, session idles.
