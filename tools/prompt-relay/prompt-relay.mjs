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
