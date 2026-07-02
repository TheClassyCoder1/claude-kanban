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
