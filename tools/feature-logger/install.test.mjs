import { test } from "node:test";
import assert from "node:assert/strict";
import { HOOK_EVENTS } from "./install.mjs";

test("HOOK_EVENTS covers lifecycle + the live-state events", () => {
  assert.deepEqual(
    [...HOOK_EVENTS].sort(),
    ["Notification", "PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"],
  );
});
