#!/usr/bin/env node
// Installs the feature-logger as a global Claude Code Stop + SessionEnd hook.
//
// Safe & idempotent:
//   - copies feature-logger.mjs to ~/.claude/feature-logger/
//   - merges hook entries into ~/.claude/settings.json (creating it if absent)
//   - NEVER touches ~/.claude/launcher-settings.json (managed/cloud config)
//   - backs up settings.json before writing; appends only if not already present
//
// Run from the repo: node tools/feature-logger/install.mjs

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const claudeDir = path.join(os.homedir(), ".claude");
const destDir = path.join(claudeDir, "feature-logger");
const destScript = path.join(destDir, "feature-logger.mjs");
const settingsPath = path.join(claudeDir, "settings.json");
// The command Claude Code will run. ~ is expanded by Claude Code.
const HOOK_COMMAND = "~/.claude/feature-logger/feature-logger.mjs";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function hookEntry() {
  return {
    matcher: "",
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }],
  };
}

function hasOurHook(arr) {
  return (
    Array.isArray(arr) &&
    arr.some(
      (e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command === HOOK_COMMAND),
    )
  );
}

function main() {
  // 1. Copy the script.
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(path.join(here, "feature-logger.mjs"), destScript);
  try {
    fs.chmodSync(destScript, 0o755);
  } catch {
    /* best effort */
  }
  log(`✓ Installed script → ${destScript}`);

  // 2. Load existing settings.json (NOT launcher-settings.json).
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      log(`! ${settingsPath} is not valid JSON — aborting so it isn't clobbered.`);
      log("  Fix or remove it, or add the hooks manually (see README).");
      return;
    }
    // Back up before modifying.
    const backup = `${settingsPath}.bak-${Date.now()}`;
    fs.copyFileSync(settingsPath, backup);
    log(`✓ Backed up existing settings → ${backup}`);
  } else {
    log(`• No existing settings.json; creating ${settingsPath}`);
  }

  // 3. Merge hook entries idempotently.
  settings.hooks = settings.hooks || {};
  let changed = false;
  for (const event of HOOK_EVENTS) {
    settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    if (hasOurHook(settings.hooks[event])) {
      log(`• ${event}: feature-logger hook already present — skipping`);
    } else {
      settings.hooks[event].push(hookEntry());
      changed = true;
      log(`✓ ${event}: added feature-logger hook`);
    }
  }

  // 4. Write atomically.
  if (changed) {
    try {
      const tmp = `${settingsPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(tmp, settingsPath);
      log(`✓ Wrote ${settingsPath}`);
      log("\nDone. Start a NEW Claude Code session for the hooks to take effect.");
    } catch (err) {
      log(`! Could not write ${settingsPath}: ${err?.message || err}`);
      log("  This can happen in a managed/cloud container where settings are read-only.");
      log("  Add the hooks manually — see tools/feature-logger/README.md.");
    }
  } else {
    log("\nNothing to change — hooks already installed.");
  }
}

import { pathToFileURL } from "url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
