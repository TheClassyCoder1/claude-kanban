import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  shouldGate,
  summarizeInput,
  decisionOutput,
  isStalePending,
} from "./approval-gate.mjs";

test("shouldGate: only in dashboard mode and for gated tools", () => {
  assert.equal(shouldGate("dashboard", "Bash"), true);
  assert.equal(shouldGate("dashboard", "Write"), true);
  assert.equal(shouldGate("dashboard", "Read"), false);
  assert.equal(shouldGate("cli", "Bash"), false);
  assert.equal(shouldGate(undefined, "Bash"), false);
});

test("summarizeInput: command for Bash, file_path for editors, redacted + truncated", () => {
  assert.equal(summarizeInput("Bash", { command: "npm test" }), "npm test");
  assert.equal(summarizeInput("Write", { file_path: "/repo/a.ts" }), "/repo/a.ts");
  assert.equal(summarizeInput("NotebookEdit", { notebook_path: "/n.ipynb" }), "/n.ipynb");
  assert.match(summarizeInput("Bash", { command: "echo sk-ant-abc123XYZ456def789ghi" }), /\[redacted\]/);
  assert.equal(summarizeInput("Bash", { command: "x".repeat(500) }).length, 300);
  assert.equal(summarizeInput("Bash", {}), "");
});

test("decisionOutput: builds the PreToolUse hookSpecificOutput payload", () => {
  assert.deepEqual(decisionOutput("allow"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Decided in dashboard",
    },
  });
  assert.equal(decisionOutput("deny").hookSpecificOutput.permissionDecision, "deny");
});

test("isStalePending: true once older than the window", () => {
  const now = 1_000_000;
  assert.equal(isStalePending(new Date(now - 10_000).toISOString(), now, 300_000), false);
  assert.equal(isStalePending(new Date(now - 400_000).toISOString(), now, 300_000), true);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "approval-gate.mjs");

function runHook(home, event, env = {}) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, HOME: home, APPROVAL_POLL_MS: "50", ...env },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(JSON.stringify(event));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

test("main: dashboard mode + gated tool waits for a decision, emits allow, cleans up", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appgate-"));
  const base = path.join(home, ".claude", "feature-log");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "mode.json"), JSON.stringify({ mode: "dashboard", relayWindowMs: 30_000 }));
  const sid = "sess-1";

  const p = runHook(home, {
    session_id: sid,
    tool_name: "Bash",
    tool_input: { command: "rm -rf build" },
    cwd: "/repo",
  });

  await new Promise((r) => setTimeout(r, 150));
  const pendingFile = path.join(base, "pending", `${sid}.json`);
  assert.ok(fs.existsSync(pendingFile), "pending written");
  const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  assert.equal(pending.tool, "Bash");
  assert.equal(pending.input, "rm -rf build");
  fs.mkdirSync(path.join(base, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(base, "decisions", `${sid}.json`), JSON.stringify({ decision: "allow" }));

  const { code, out } = await p;
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(fs.existsSync(pendingFile), false, "pending cleaned up");
  assert.equal(fs.existsSync(path.join(base, "decisions", `${sid}.json`)), false, "decision cleaned up");
});

test("main: cli mode is an instant no-op (no pending, no output)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appgate-"));
  fs.mkdirSync(path.join(home, ".claude", "feature-log"), { recursive: true });
  const { code, out } = await runHook(home, {
    session_id: "s2",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    cwd: "/repo",
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), "");
});
