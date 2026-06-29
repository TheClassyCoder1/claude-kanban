import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classify,
  isRealPrompt,
  slugForCwd,
  redactSecrets,
  parseTranscript,
  liveStateForEvent,
} from "./feature-logger.mjs";

test("liveStateForEvent: permission notification → awaiting_approval", () => {
  assert.equal(
    liveStateForEvent("Notification", "Claude needs your permission to use Bash", undefined),
    "awaiting_approval",
  );
});

test("liveStateForEvent: non-permission notification preserves existing state", () => {
  assert.equal(
    liveStateForEvent("Notification", "Claude is waiting for your input", "awaiting_approval"),
    "awaiting_approval",
  );
  assert.equal(liveStateForEvent("Notification", "", undefined), undefined);
  assert.equal(liveStateForEvent("Notification", undefined, "idle"), "idle");
});

test("liveStateForEvent: Stop → idle", () => {
  assert.equal(liveStateForEvent("Stop", undefined, "awaiting_approval"), "idle");
});

test("liveStateForEvent: UserPromptSubmit / SessionStart / SessionEnd → cleared", () => {
  assert.equal(liveStateForEvent("UserPromptSubmit", undefined, "idle"), undefined);
  assert.equal(liveStateForEvent("SessionStart", undefined, "idle"), undefined);
  assert.equal(liveStateForEvent("SessionEnd", undefined, "awaiting_approval"), undefined);
});

test("liveStateForEvent: PostToolUse clears a stale awaiting_approval (user accepted)", () => {
  // A tool only runs after its permission prompt is accepted, so PostToolUse
  // means Claude is working again — clear the 'Waiting for you' state.
  assert.equal(liveStateForEvent("PostToolUse", undefined, "awaiting_approval"), undefined);
});

test("classify buckets files by area", () => {
  assert.equal(classify("src/lib/featureLog.ts"), "Data layer & libs");
  assert.equal(classify("src/app/api/foo/route.ts"), "API routes");
  assert.equal(classify("src/components/Foo.tsx"), "Board UI");
  assert.equal(classify("package.json"), "Project setup");
  assert.equal(classify(".env.local"), "Project setup");
  assert.equal(classify("README.md"), "Docs");
  assert.equal(classify("scripts/weird.py"), "Other");
});

test("isRealPrompt rejects empty, oversized, and injected text", () => {
  assert.equal(isRealPrompt("build a kanban board"), true);
  assert.equal(isRealPrompt("   "), false);
  assert.equal(isRealPrompt("x".repeat(1501)), false);
  assert.equal(isRealPrompt("<command-name>foo</command-name>"), false);
  assert.equal(isRealPrompt("system-reminder: do thing"), false);
  assert.equal(isRealPrompt(42), false);
});

test("slugForCwd mirrors Claude Code's slash-to-dash scheme", () => {
  assert.equal(slugForCwd("/Users/x/dev/proj"), "-Users-x-dev-proj");
  assert.equal(slugForCwd(""), "unknown");
});

test("redactSecrets masks common credential shapes", () => {
  assert.match(redactSecrets("my key is sk-ant-abc123XYZ456def789ghi"), /\[redacted\]/);
  assert.match(redactSecrets("token ghp_0123456789abcdef0123456789abcdef0123"), /\[redacted\]/);
  assert.match(redactSecrets("aws AKIAIOSFODNN7EXAMPLE here"), /\[redacted\]/);
  assert.match(redactSecrets("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb"), /\[redacted\]/);
});

test("redactSecrets leaves ordinary prompt text untouched", () => {
  const clean = "refactor the dashboard to group by project";
  assert.equal(redactSecrets(clean), clean);
});

test("parseTranscript splits one session into per-project records", () => {
  const A = "/repo/alpha";
  const B = "/repo/beta";
  const lines = [
    { type: "user", cwd: A, timestamp: "2026-06-25T10:00:00Z", message: { content: "work on alpha" } },
    {
      type: "assistant",
      cwd: A,
      timestamp: "2026-06-25T10:01:00Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: "tool_use", name: "Write", input: { file_path: `${A}/src/lib/a.ts` } },
          // Cross-repo write while cwd is alpha → must land under beta.
          { type: "tool_use", name: "Write", input: { file_path: `${B}/src/lib/fromA.ts` } },
          { type: "tool_use", name: "Bash", input: { command: "git commit -m x" } },
        ],
      },
    },
    { type: "user", cwd: B, timestamp: "2026-06-25T10:02:00Z", message: { content: "now beta" } },
    {
      type: "assistant",
      cwd: B,
      timestamp: "2026-06-25T10:03:00Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 20, output_tokens: 7 },
        content: [{ type: "tool_use", name: "Edit", input: { file_path: `${B}/src/components/Y.tsx` } }],
      },
    },
  ];
  const file = path.join(os.tmpdir(), `ft-transcript-${process.pid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));

  const bases = parseTranscript(file, A);
  fs.unlinkSync(file);

  assert.equal(bases.length, 2);
  const alpha = bases.find((b) => b.projectPath === A);
  const beta = bases.find((b) => b.projectPath === B);
  assert.ok(alpha && beta);

  // Alpha keeps only its own file + the commit; tokens from its one turn.
  assert.deepEqual(alpha.filesByArea["Data layer & libs"].created, ["src/lib/a.ts"]);
  assert.equal(alpha.tokens.output, 5);
  assert.deepEqual(alpha.commands, ["git commit -m x"]);

  // Beta gets the cross-repo write (prefix-attributed) AND its own edit.
  assert.deepEqual(beta.filesByArea["Data layer & libs"].created, ["src/lib/fromA.ts"]);
  assert.deepEqual(beta.filesByArea["Board UI"].edited, ["src/components/Y.tsx"]);
  assert.equal(beta.tokens.output, 7);
});
