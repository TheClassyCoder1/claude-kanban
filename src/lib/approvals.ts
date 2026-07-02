import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { z } from "zod";

export type Mode = "cli" | "dashboard";
export type PendingApproval = {
  sessionId: string;
  tool: string;
  input: string;
  cwd: string;
  createdAt: string;
};

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const RELAY_WINDOW_DEFAULT = 600_000;
const RELAY_WINDOW_MIN = 30_000;
const RELAY_WINDOW_MAX = 600_000;

function clampWindow(ms: number): number {
  return Math.max(RELAY_WINDOW_MIN, Math.min(RELAY_WINDOW_MAX, ms));
}

// Recomputed per call so tests can repoint HOME between cases.
const base = () => path.join(os.homedir(), ".claude", "feature-log");
const modeFile = () => path.join(base(), "mode.json");
const decisionsDir = () => path.join(base(), "decisions");
const pendingDir = () => path.join(base(), "pending");
const awaitingDir = () => path.join(base(), "awaiting");
const queuedDir = () => path.join(base(), "queued");

export function isSafeSessionId(s: string): boolean {
  return typeof s === "string" && s.length > 0 && SAFE_ID.test(s);
}

async function writeAtomic(file: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}

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

export async function writeDecision(sessionId: unknown, decision: unknown): Promise<void> {
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId)) {
    throw new Error("invalid sessionId");
  }
  const d = z.enum(["allow", "deny"]).parse(decision);
  await writeAtomic(path.join(decisionsDir(), `${sessionId}.json`), { decision: d });
}

const pendingSchema = z.object({
  sessionId: z.string(),
  tool: z.string(),
  input: z.string(),
  cwd: z.string(),
  createdAt: z.string(),
});

export async function readPendingApprovals(now: number = Date.now()): Promise<PendingApproval[]> {
  let files: string[];
  try {
    files = await fs.readdir(pendingDir());
  } catch {
    return [];
  }
  const out: PendingApproval[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = pendingSchema.parse(
        JSON.parse(await fs.readFile(path.join(pendingDir(), f), "utf8")),
      );
      if (now - Date.parse(p.createdAt) <= RELAY_WINDOW_MAX) out.push(p);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

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
      const a = awaitingSchema.parse(
        JSON.parse(await fs.readFile(path.join(awaitingDir(), f), "utf8")),
      );
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
