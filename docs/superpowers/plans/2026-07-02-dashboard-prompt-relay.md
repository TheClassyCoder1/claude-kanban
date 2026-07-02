# Dashboard Prompt Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Dashboard mode, let the dashboard send a follow-up prompt to a session that just finished a turn, via a blocking Stop hook, with a UI-configurable wait window.

**Architecture:** A new `Stop` hook (`prompt-relay.mjs`) that, in Dashboard mode, writes an `awaiting` marker and polls for a queued prompt, returning `{"decision":"block","reason":...}` so Claude continues with the text. The window is read from `mode.json` (UI-settable). Mirrors the approval-gate pattern on the other end of a turn.

**Tech Stack:** Node.js (zero-dep hook, `node:test`), Next.js 16 route handlers, TypeScript, Zod, Tailwind.

## Global Constraints

- Route Handlers: `export async function POST(request: Request)` in `src/app/api/<name>/route.ts`, `return Response.json(...)`, `export const runtime = "nodejs"`. Use `@/lib/approvals` (source imports use the `@/` alias, no `.ts` extension; `node --test` files import with the `.ts` extension).
- Hook scripts exit 0 on every path; prompt-relay may block (poll) but any error still exits 0 (normal stop — never a spurious continuation).
- Pure functions exported from the hook for unit tests; `main()` runs only via the entry guard.
- Reuse before writing (niro `find_reusable_code`): `isSafeSessionId`, `writeAtomic`, dir helpers in `src/lib/approvals.ts`; the approval-gate hook is the structural template.
- Tests: `npm test` → `node --test "src/**/*.test.ts" "tools/**/*.test.mjs"`.
- `mode.json` shape: `{ "mode": "cli"|"dashboard", "relayWindowMs"?: number }`. Missing `relayWindowMs` → `600000`.
- Window clamp: `[30_000, 600_000]`; `600_000` is Claude's Stop-hook `timeout` ceiling.
- State under `~/.claude/feature-log/`: `awaiting/<sid>.json` = `{sessionId,createdAt}` (hook writes); `queued/<sid>.json` = `{prompt}` (dashboard writes).
- Continuation JSON: `{"decision":"block","reason":"Dashboard prompt: <text>"}`.
- Blocking hooks register `timeout: 600`; feature-logger stays `60`.

---

### Task 1: prompt-relay Stop hook

**Files:**
- Create: `tools/prompt-relay/prompt-relay.mjs`
- Test: `tools/prompt-relay/prompt-relay.test.mjs`

**Interfaces:**
- Produces: `buildContinue(prompt): object`; `isStaleAwaiting(createdAt, now, windowMs): boolean`; `clampWindow(ms): number`. A runnable Stop hook: in dashboard mode writes `awaiting/<sid>.json`, polls `queued/<sid>.json` up to the configured window, prints `buildContinue(prompt)` and cleans up, else exits silently.

- [ ] **Step 1: Write the failing test**

Create `tools/prompt-relay/prompt-relay.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildContinue, isStaleAwaiting, clampWindow } from "./prompt-relay.mjs";

test("buildContinue: Stop-hook block payload carrying the prompt", () => {
  assert.deepEqual(buildContinue("run the tests"), {
    decision: "block",
    reason: "Dashboard prompt: run the tests",
  });
});

test("clampWindow: clamps to [30s, 600s], defaults on garbage", () => {
  assert.equal(clampWindow(1000), 30_000);
  assert.equal(clampWindow(9_000_000), 600_000);
  assert.equal(clampWindow(120_000), 120_000);
  assert.equal(clampWindow("x"), 600_000);
});

test("isStaleAwaiting: true once older than window", () => {
  const now = 1_000_000;
  assert.equal(isStaleAwaiting(new Date(now - 10_000).toISOString(), now, 300_000), false);
  assert.equal(isStaleAwaiting(new Date(now - 400_000).toISOString(), now, 300_000), true);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "prompt-relay.mjs");

function runHook(home, event, env = {}) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, HOME: home, RELAY_POLL_MS: "50", ...env },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(JSON.stringify(event));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

test("main: dashboard mode blocks, injects queued prompt as continuation, cleans up", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  const base = path.join(home, ".claude", "feature-log");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "mode.json"), JSON.stringify({ mode: "dashboard", relayWindowMs: 30_000 }));
  const sid = "sess-1";

  const p = runHook(home, { session_id: sid, cwd: "/repo" });

  await new Promise((r) => setTimeout(r, 150));
  const awaitingFile = path.join(base, "awaiting", `${sid}.json`);
  assert.ok(fs.existsSync(awaitingFile), "awaiting written");
  fs.mkdirSync(path.join(base, "queued"), { recursive: true });
  fs.writeFileSync(path.join(base, "queued", `${sid}.json`), JSON.stringify({ prompt: "fix the bug" }));

  const { code, out } = await p;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { decision: "block", reason: "Dashboard prompt: fix the bug" });
  assert.equal(fs.existsSync(awaitingFile), false, "awaiting cleaned up");
  assert.equal(fs.existsSync(path.join(base, "queued", `${sid}.json`)), false, "queued cleaned up");
});

test("main: cli mode is an instant no-op", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  fs.mkdirSync(path.join(home, ".claude", "feature-log"), { recursive: true });
  const { code, out } = await runHook(home, { session_id: "s2", cwd: "/repo" });
  assert.equal(code, 0);
  assert.equal(out.trim(), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/prompt-relay/prompt-relay.test.mjs`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement the hook**

Create `tools/prompt-relay/prompt-relay.mjs`:

```js
#!/usr/bin/env node
// Claude Code Stop hook — in Dashboard mode, blocks when a session finishes a turn
// and polls for a prompt the dashboard queued, returning it as a continuation so
// Claude keeps going. Separate from feature-logger's (non-blocking) Stop hook.
// Any error / timeout exits 0 with no decision → the session stops normally.

import fs from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";

const BASE = path.join(os.homedir(), ".claude", "feature-log");
const MODE_FILE = path.join(BASE, "mode.json");
const AWAITING_DIR = path.join(BASE, "awaiting");
const QUEUED_DIR = path.join(BASE, "queued");
const WINDOW_MIN = 30_000;
const WINDOW_MAX = 600_000;
const POLL_MS = Number(process.env.RELAY_POLL_MS) || 1000;

export function clampWindow(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return WINDOW_MAX;
  return Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, n));
}

export function buildContinue(prompt) {
  return { decision: "block", reason: `Dashboard prompt: ${prompt}` };
}

export function isStaleAwaiting(createdAt, now, windowMs) {
  const t = Date.parse(createdAt);
  return Number.isNaN(t) || now - t > windowMs;
}

function readControl() {
  try {
    const c = JSON.parse(fs.readFileSync(MODE_FILE, "utf8"));
    return { mode: c.mode || "cli", relayWindowMs: c.relayWindowMs };
  } catch {
    return { mode: "cli", relayWindowMs: undefined };
  }
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function rm(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.env.FEATURE_LOGGER_ACTIVE === "1") return;
  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }
  const sid = input.session_id;
  if (!sid) return;
  const { mode, relayWindowMs } = readControl();
  if (mode !== "dashboard") return;

  const windowMs = clampWindow(relayWindowMs ?? WINDOW_MAX);
  const awaitingFile = path.join(AWAITING_DIR, `${sid}.json`);
  const queuedFile = path.join(QUEUED_DIR, `${sid}.json`);
  writeAtomic(awaitingFile, { sessionId: sid, createdAt: new Date().toISOString() });

  const deadline = Date.now() + windowMs;
  try {
    while (Date.now() < deadline) {
      let prompt;
      try {
        prompt = JSON.parse(fs.readFileSync(queuedFile, "utf8")).prompt;
      } catch {
        prompt = null;
      }
      if (typeof prompt === "string" && prompt.length > 0) {
        rm(queuedFile);
        process.stdout.write(JSON.stringify(buildContinue(prompt)));
        return;
      }
      await sleep(POLL_MS);
    }
  } finally {
    rm(awaitingFile);
  }
  // window elapsed → no decision → session stops
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/prompt-relay/prompt-relay.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/prompt-relay/
git commit -m "feat: prompt-relay Stop hook injects dashboard prompts as continuations"
```

---

### Task 2: approvals.ts — relay window + awaiting + queued prompt

**Files:**
- Modify: `src/lib/approvals.ts`
- Test: `src/lib/approvals.test.ts`

**Interfaces:**
- Consumes: existing `isSafeSessionId`, `writeAtomic`, dir helpers.
- Produces:
  - `readRelayWindowMs(): Promise<number>` (default 600000, clamped `[30000,600000]`)
  - `writeRelayWindowMs(ms: unknown): Promise<number>` (clamp + merge into mode.json preserving `mode`; return stored)
  - `readAwaitingPrompts(now?: number): Promise<{ sessionId: string; createdAt: string }[]>` (drop > 600000ms old)
  - `writePrompt(sessionId: unknown, prompt: unknown): Promise<void>` (validate id + non-empty string ≤10000; write `queued/<id>.json`)
  - `writeMode` now merges (preserves `relayWindowMs`)

- [ ] **Step 1: Write the failing test**

Add to `src/lib/approvals.test.ts` (imports at top gain the new names):

```ts
import {
  isSafeSessionId,
  readMode,
  writeMode,
  writeDecision,
  readPendingApprovals,
  readRelayWindowMs,
  writeRelayWindowMs,
  readAwaitingPrompts,
  writePrompt,
} from "./approvals.ts";
```

Append these tests:

```ts
test("relay window: default 600000, clamps, merges without dropping mode", async () => {
  await tmpHome();
  assert.equal(await readRelayWindowMs(), 600_000);
  await writeMode("dashboard");
  assert.equal(await writeRelayWindowMs(120_000), 120_000);
  assert.equal(await readRelayWindowMs(), 120_000);
  assert.equal(await readMode(), "dashboard"); // preserved
  assert.equal(await writeRelayWindowMs(5), 30_000); // clamped up
  assert.equal(await writeRelayWindowMs(9_999_999), 600_000); // clamped down
});

test("writeMode preserves an existing relay window", async () => {
  await tmpHome();
  await writeRelayWindowMs(120_000);
  await writeMode("dashboard");
  assert.equal(await readRelayWindowMs(), 120_000);
});

test("writePrompt validates and writes queued prompt", async () => {
  const home = await tmpHome();
  await writePrompt("sess-1", "do the thing");
  const f = path.join(home, ".claude", "feature-log", "queued", "sess-1.json");
  assert.equal(JSON.parse(await fs.readFile(f, "utf8")).prompt, "do the thing");
  await assert.rejects(() => writePrompt("../x", "hi"));
  await assert.rejects(() => writePrompt("sess-1", ""));
  await assert.rejects(() => writePrompt("sess-1", 42));
});

test("readAwaitingPrompts returns fresh, drops stale", async () => {
  const home = await tmpHome();
  const dir = path.join(home, ".claude", "feature-log", "awaiting");
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  await fs.writeFile(path.join(dir, "fresh.json"), JSON.stringify({ sessionId: "fresh", createdAt: new Date(now).toISOString() }));
  await fs.writeFile(path.join(dir, "stale.json"), JSON.stringify({ sessionId: "stale", createdAt: new Date(now - 700_000).toISOString() }));
  const a = await readAwaitingPrompts(now);
  assert.deepEqual(a.map((x) => x.sessionId), ["fresh"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/approvals.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement in `src/lib/approvals.ts`**

Add constants near the top (after `SAFE_ID`):

```ts
const RELAY_WINDOW_DEFAULT = 600_000;
const RELAY_WINDOW_MIN = 30_000;
const RELAY_WINDOW_MAX = 600_000;

function clampWindow(ms: number): number {
  return Math.max(RELAY_WINDOW_MIN, Math.min(RELAY_WINDOW_MAX, ms));
}
```

Add dir helpers alongside the existing ones:

```ts
const awaitingDir = () => path.join(base(), "awaiting");
const queuedDir = () => path.join(base(), "queued");
```

Add a control reader and rewrite `readMode`/`writeMode` to go through it:

```ts
type Control = { mode: Mode; relayWindowMs?: number };

async function readControl(): Promise<Control> {
  try {
    const c = JSON.parse(await fs.readFile(modeFile(), "utf8"));
    return { mode: c.mode === "dashboard" ? "dashboard" : "cli", relayWindowMs: c.relayWindowMs };
  } catch {
    return { mode: "cli" };
  }
}

export async function readMode(): Promise<Mode> {
  return (await readControl()).mode;
}

export async function writeMode(mode: unknown): Promise<Mode> {
  const parsed = z.enum(["cli", "dashboard"]).parse(mode);
  const cur = await readControl();
  await writeAtomic(modeFile(), { ...cur, mode: parsed });
  return parsed;
}

export async function readRelayWindowMs(): Promise<number> {
  const ms = (await readControl()).relayWindowMs;
  return typeof ms === "number" && Number.isFinite(ms) ? clampWindow(ms) : RELAY_WINDOW_DEFAULT;
}

export async function writeRelayWindowMs(ms: unknown): Promise<number> {
  const n = z.number().parse(ms);
  const clamped = clampWindow(n);
  const cur = await readControl();
  await writeAtomic(modeFile(), { ...cur, relayWindowMs: clamped });
  return clamped;
}
```

Replace the existing `readMode`/`writeMode` definitions with the versions above (remove the old ones). Add awaiting + prompt helpers:

```ts
const awaitingSchema = z.object({ sessionId: z.string(), createdAt: z.string() });

export async function readAwaitingPrompts(
  now: number = Date.now(),
): Promise<{ sessionId: string; createdAt: string }[]> {
  let files: string[];
  try {
    files = await fs.readdir(awaitingDir());
  } catch {
    return [];
  }
  const out: { sessionId: string; createdAt: string }[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const a = awaitingSchema.parse(JSON.parse(await fs.readFile(path.join(awaitingDir(), f), "utf8")));
      if (now - Date.parse(a.createdAt) <= RELAY_WINDOW_MAX) out.push(a);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export async function writePrompt(sessionId: unknown, prompt: unknown): Promise<void> {
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId)) {
    throw new Error("invalid sessionId");
  }
  const p = z.string().min(1).max(10_000).parse(prompt);
  await writeAtomic(path.join(queuedDir(), `${sessionId}.json`), { prompt: p });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/approvals.test.ts`
Expected: PASS (all — existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/approvals.ts src/lib/approvals.test.ts
git commit -m "feat: approvals lib gains relay window + queued-prompt helpers"
```

---

### Task 3: API routes `/api/prompt` and `/api/relay-window`

**Files:**
- Create: `src/app/api/prompt/route.ts`
- Create: `src/app/api/relay-window/route.ts`

**Interfaces:**
- Consumes: `writePrompt`, `writeRelayWindowMs`.
- Produces: `POST /api/prompt` ({sessionId, prompt}); `POST /api/relay-window` ({ms}).

- [ ] **Step 1: Create `src/app/api/prompt/route.ts`**

```ts
import { writePrompt } from "@/lib/approvals";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { sessionId, prompt } = await request.json();
    await writePrompt(sessionId, prompt);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: "invalid request" }, { status: 400 });
  }
}
```

- [ ] **Step 2: Create `src/app/api/relay-window/route.ts`**

```ts
import { writeRelayWindowMs } from "@/lib/approvals";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { ms } = await request.json();
    const stored = await writeRelayWindowMs(ms);
    return Response.json({ ok: true, ms: stored });
  } catch {
    return Response.json({ ok: false, error: "invalid ms" }, { status: 400 });
  }
}
```

- [ ] **Step 3: Build to verify the routes typecheck**

Run: `npm run build`
Expected: compiles (routes covered by build; logic unit-tested in Task 2).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/prompt/route.ts src/app/api/relay-window/route.ts
git commit -m "feat: /api/prompt and /api/relay-window route handlers"
```

---

### Task 4: Dashboard UI — Send box + window selector

**Files:**
- Create: `src/components/SendPrompt.tsx`
- Create: `src/components/RelayWindowSelect.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/components/FeatureDashboard.tsx`

**Interfaces:**
- Consumes: `readAwaitingPrompts`, `readRelayWindowMs`, `readMode`; `POST /api/prompt`, `POST /api/relay-window`.
- Produces: Send box on awaiting sessions; window dropdown next to the toggle in Dashboard mode.

- [ ] **Step 1: Create `RelayWindowSelect.tsx`**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const OPTIONS = [
  { ms: 60_000, label: "1 min" },
  { ms: 120_000, label: "2 min" },
  { ms: 300_000, label: "5 min" },
  { ms: 600_000, label: "10 min" },
];

export default function RelayWindowSelect({ ms }: { ms: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <label className="flex items-center gap-1 text-[10px] text-slate-500">
      wait
      <select
        disabled={busy}
        value={ms}
        onChange={async (e) => {
          setBusy(true);
          await fetch("/api/relay-window", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ms: Number(e.target.value) }),
          });
          router.refresh();
          setBusy(false);
        }}
        className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] disabled:opacity-60"
      >
        {OPTIONS.map((o) => (
          <option key={o.ms} value={o.ms}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
```

- [ ] **Step 2: Create `SendPrompt.tsx`**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SendPrompt({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, prompt: text }),
    });
    setText("");
    router.refresh();
    setBusy(false);
  };
  return (
    <div className="mt-2 rounded-lg border border-cyan-300 bg-cyan-50 p-3">
      <p className="text-xs font-semibold text-cyan-800">Send a follow-up prompt</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="Type an instruction to continue this session…"
        className="mt-1 w-full rounded border border-cyan-200 bg-white p-2 text-xs text-slate-700 focus:border-cyan-400 focus:outline-none"
      />
      <button
        disabled={busy || !text.trim()}
        onClick={send}
        className="mt-2 rounded bg-cyan-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        Send
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Thread awaiting + render `SendPrompt` in `FeatureDashboard.tsx`**

Add to imports:

```tsx
import SendPrompt from "./SendPrompt";
```

Extend `RecordCard` to also take `awaiting` and render the send box:

```tsx
function RecordCard({
  record,
  pending,
  awaiting,
}: {
  record: FeatureRecord;
  pending?: PendingApproval;
  awaiting?: boolean;
}) {
  return (
    <div>
      <FeatureItem record={record} />
      {pending && <PendingApprovalCard pending={pending} />}
      {awaiting && !pending && <SendPrompt sessionId={record.sessionId} />}
    </div>
  );
}
```

Add `awaitingSessions: Set<string>` to `StatusSections`, `GroupedView`, and
`FeatureDashboard` props (default `new Set()`), threading it exactly like
`pendingBySession`. At both `RecordCard` render sites pass
`awaiting={awaitingSessions.has(r.sessionId)}`. The `FeatureDashboard` signature
becomes:

```tsx
export default function FeatureDashboard({
  records,
  pendingBySession = {},
  awaitingSessions = new Set<string>(),
}: {
  records: FeatureRecord[];
  pendingBySession?: Record<string, PendingApproval>;
  awaitingSessions?: Set<string>;
}) {
```

and pass `awaitingSessions={awaitingSessions}` to both `<StatusSections>` and
`<GroupedView>`.

- [ ] **Step 4: Wire `page.tsx`**

Update imports and data loading:

```tsx
import RelayWindowSelect from "@/components/RelayWindowSelect";
import { readMode, readPendingApprovals, readAwaitingPrompts, readRelayWindowMs } from "@/lib/approvals";
```

```tsx
  const [records, mode, pending, awaiting, relayWindowMs] = await Promise.all([
    readFeatureRecords(),
    readMode(),
    readPendingApprovals(),
    readAwaitingPrompts(),
    readRelayWindowMs(),
  ]);
  const pendingBySession = Object.fromEntries(pending.map((p) => [p.sessionId, p]));
  const awaitingSessions = new Set(awaiting.map((a) => a.sessionId));
  const attention = pending.length + awaiting.length +
    records.filter((r) => {
      const s = deriveStatus(r);
      return s === "awaiting_approval" || s === "idle";
    }).length;
```

Header: put the selector beside the toggle, only in Dashboard mode:

```tsx
          <div className="flex items-center gap-3">
            {mode === "dashboard" && <RelayWindowSelect ms={relayWindowMs} />}
            <ModeToggle mode={mode} />
          </div>
```

Pass to the dashboard:

```tsx
        <FeatureDashboard
          records={records}
          pendingBySession={pendingBySession}
          awaitingSessions={awaitingSessions}
        />
```

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: compiles, type-checks, lints clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/SendPrompt.tsx src/components/RelayWindowSelect.tsx src/components/FeatureDashboard.tsx src/app/page.tsx
git commit -m "feat: send-prompt box + relay window selector in the dashboard"
```

---

### Task 5: Installer — per-hook timeout + prompt-relay entry

**Files:**
- Modify: `tools/feature-logger/install.mjs`
- Modify: `tools/feature-logger/install.test.mjs`

**Interfaces:**
- Produces: `INSTALLS` entries with a `timeout` field (feature-logger 60, approval-gate 600, prompt-relay 600 on `Stop`); merge refreshes a stale timeout on an existing entry.

- [ ] **Step 1: Write the failing test**

Add to `tools/feature-logger/install.test.mjs`:

```js
test("INSTALLS: prompt-relay on Stop, blocking hooks at timeout 600", () => {
  const fl = INSTALLS.find((i) => i.command.includes("feature-logger"));
  const ag = INSTALLS.find((i) => i.command.includes("approval-gate"));
  const pr = INSTALLS.find((i) => i.command.includes("prompt-relay"));
  assert.equal(fl.timeout, 60);
  assert.equal(ag.timeout, 600);
  assert.deepEqual(pr.events, ["Stop"]);
  assert.equal(pr.timeout, 600);
});

test("refreshTimeout upgrades a stale 60s entry to 600s", () => {
  const AG = "~/.claude/approval-gate/approval-gate.mjs";
  const arr = [{ matcher: "", hooks: [{ type: "command", command: AG, timeout: 60 }] }];
  const changed = refreshTimeout(arr, AG, 600);
  assert.equal(changed, true);
  assert.equal(arr[0].hooks[0].timeout, 600);
  assert.equal(refreshTimeout(arr, AG, 600), false); // already correct → no change
});
```

Add `refreshTimeout` to the import from `./install.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/feature-logger/install.test.mjs`
Expected: FAIL — `INSTALLS` lacks `timeout`; `refreshTimeout` not exported.

- [ ] **Step 3: Update `install.mjs`**

Add the prompt-relay command constant and give every `INSTALLS` entry a `timeout`:

```js
const PR_COMMAND = "~/.claude/prompt-relay/prompt-relay.mjs";

export const INSTALLS = [
  { command: HOOK_COMMAND, events: HOOK_EVENTS, timeout: 60, src: "feature-logger/feature-logger.mjs", dest: path.join(claudeDir, "feature-logger", "feature-logger.mjs") },
  { command: AG_COMMAND, events: ["PreToolUse"], timeout: 600, src: "approval-gate/approval-gate.mjs", dest: path.join(claudeDir, "approval-gate", "approval-gate.mjs") },
  { command: PR_COMMAND, events: ["Stop"], timeout: 600, src: "prompt-relay/prompt-relay.mjs", dest: path.join(claudeDir, "prompt-relay", "prompt-relay.mjs") },
];
```

Update `hookEntry` to take a timeout:

```js
function hookEntry(command, timeout) {
  return { matcher: "", hooks: [{ type: "command", command, timeout }] };
}
```

Add `refreshTimeout` (export it):

```js
// Bring an already-present entry's timeout up to date. Returns true if it changed.
export function refreshTimeout(arr, command, timeout) {
  let changed = false;
  if (!Array.isArray(arr)) return false;
  for (const e of arr) {
    if (!Array.isArray(e?.hooks)) continue;
    for (const h of e.hooks) {
      if (h?.command === command && h.timeout !== timeout) {
        h.timeout = timeout;
        changed = true;
      }
    }
  }
  return changed;
}
```

Update the merge loop to use per-entry timeout and refresh existing ones:

```js
  for (const inst of INSTALLS) {
    for (const event of inst.events) {
      settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      if (hasOurHook(settings.hooks[event], inst.command)) {
        if (refreshTimeout(settings.hooks[event], inst.command, inst.timeout)) {
          changed = true;
          log(`✓ ${event}: updated ${inst.command} timeout → ${inst.timeout}s`);
        } else {
          log(`• ${event}: ${inst.command} already present — skipping`);
        }
      } else {
        settings.hooks[event].push(hookEntry(inst.command, inst.timeout));
        changed = true;
        log(`✓ ${event}: added ${inst.command}`);
      }
    }
    for (const event of pruneStaleHooks(settings.hooks, inst.command, inst.events)) {
      changed = true;
      log(`✓ ${event}: removed stale ${inst.command}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/feature-logger/install.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/feature-logger/install.mjs tools/feature-logger/install.test.mjs
git commit -m "feat: register prompt-relay hook; fix blocking-hook timeouts to 600s"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `tools/feature-logger/README.md`

- [ ] **Step 1: Root README — extend the approvals section**

After the "Approving permissions from the dashboard" section, add:

```markdown
### Sending a prompt from the dashboard

In **Dashboard mode**, when a session finishes a turn its card shows a **Send a
follow-up prompt** box. Type an instruction and **Send** — the session continues with
it. A **wait** dropdown (next to the mode toggle) sets how long a finished session
waits for a prompt before going idle (1–10 min; 10 is Claude's hook ceiling). You can
only send within that window — once a session is fully idle nothing can wake it.

Powered by a third hook, `tools/prompt-relay/prompt-relay.mjs` (a `Stop` hook),
installed by `npm run hooks`.
```

Add to the project-layout block, under `tools/`:

```
tools/prompt-relay/
  prompt-relay.mjs     # Stop hook — sends dashboard prompts into a session
```

And under `src/`:

```
  app/api/prompt/route.ts        # POST: queue a follow-up prompt for a session
  app/api/relay-window/route.ts  # POST: set the prompt wait window
  components/
    SendPrompt.tsx        # follow-up prompt box (client)
    RelayWindowSelect.tsx # wait-window dropdown (client)
```

- [ ] **Step 2: feature-logger README — note the third hook**

Add a line: the installer also registers `tools/prompt-relay/prompt-relay.mjs` on
`Stop` (`timeout 600`), active only in Dashboard mode; it blocks a finished turn up to
the configured window (`relayWindowMs` in `mode.json`) waiting for a dashboard prompt,
returning it as a continuation. Note that blocking hooks (approval-gate, prompt-relay)
register `timeout: 600`; feature-logger stays `60`.

- [ ] **Step 3: Commit**

```bash
git add README.md tools/feature-logger/README.md
git commit -m "docs: document prompt relay + configurable wait window"
```

---

### Task 7: Reinstall + manual end-to-end verification

**Files:** none (operational).

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 2: Reinstall all three hooks**

Run: `npm run hooks`
Expected: logs show `prompt-relay.mjs` added on `Stop`, and timeout upgrades for
approval-gate/prompt-relay to 600s (approval-gate line reads "updated … timeout → 600s").

- [ ] **Step 3: Manual e2e in a NEW Claude Code session**

- Start the dashboard: `npm run dev`; toggle to **Dashboard mode**; set **wait** to 1 min.
- In a new Claude Code session, let a turn finish. The session card shows a **Send a
  follow-up prompt** box within ~3s.
- Type an instruction + **Send** → the session continues and acts on it.
- Finish another turn, wait past 1 min without sending → the box disappears (idle).
- Toggle to **CLI mode** → finishing a turn shows no send box; the session stops immediately.

Expected: matches. If the box sticks, check `~/.claude/feature-log/awaiting/<sid>.json`
and `mode.json`.
