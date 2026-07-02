#!/usr/bin/env node
// Claude Code PreToolUse hook — routes gated-tool permission prompts to the
// dashboard when in "dashboard" mode. Separate from feature-logger because this
// one BLOCKS (polls) by design. Every path still exits 0; on timeout or any error
// it emits no decision, so Claude falls back to the normal terminal prompt.

import fs from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { redactSecrets } from "../feature-logger/feature-logger.mjs";

export const GATED_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

const BASE = path.join(os.homedir(), ".claude", "feature-log");
const MODE_FILE = path.join(BASE, "mode.json");
const PENDING_DIR = path.join(BASE, "pending");
const DECISIONS_DIR = path.join(BASE, "decisions");
const WINDOW_MIN = 30_000;
const WINDOW_MAX = 600_000;
const POLL_MS = Number(process.env.APPROVAL_POLL_MS) || 1000;

// Shared with prompt-relay: the wait window is the UI-configured relayWindowMs
// in mode.json, so one dropdown governs both approvals and prompt relay.
export function clampWindow(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return WINDOW_MAX;
  return Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, n));
}

export function shouldGate(mode, tool) {
  return mode === "dashboard" && GATED_TOOLS.has(tool);
}

export function summarizeInput(tool, toolInput) {
  const raw =
    tool === "Bash" ? toolInput?.command : toolInput?.file_path || toolInput?.notebook_path;
  if (typeof raw !== "string") return "";
  return redactSecrets(raw).slice(0, 300);
}

export function decisionOutput(decision) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: "Decided in dashboard",
    },
  };
}

export function isStalePending(createdAt, now, windowMs) {
  const t = Date.parse(createdAt);
  return Number.isNaN(t) || now - t > windowMs;
}

// ---------------------------------------------------------------------------
// Runtime (hook entry only)
// ---------------------------------------------------------------------------
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.env.FEATURE_LOGGER_ACTIVE === "1") return; // don't gate our own summarizer
  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }
  const sid = input.session_id;
  const tool = input.tool_name;
  const { mode, relayWindowMs } = readControl();
  if (!sid || !shouldGate(mode, tool)) return;

  const pendingFile = path.join(PENDING_DIR, `${sid}.json`);
  const decisionFile = path.join(DECISIONS_DIR, `${sid}.json`);
  writeAtomic(pendingFile, {
    sessionId: sid,
    tool,
    input: summarizeInput(tool, input.tool_input),
    cwd: input.cwd || "",
    createdAt: new Date().toISOString(),
  });

  const deadline = Date.now() + clampWindow(relayWindowMs ?? WINDOW_MAX);
  try {
    while (Date.now() < deadline) {
      let decision;
      try {
        decision = JSON.parse(fs.readFileSync(decisionFile, "utf8")).decision;
      } catch {
        decision = null;
      }
      if (decision === "allow" || decision === "deny") {
        rm(decisionFile);
        process.stdout.write(JSON.stringify(decisionOutput(decision)));
        return;
      }
      await sleep(POLL_MS);
    }
  } finally {
    rm(pendingFile); // window elapsed or decided → no dangling pending
  }
  // no decision within the window → no output → terminal prompt appears
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
