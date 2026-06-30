#!/usr/bin/env node
// Removes the feature-logger global hook installed by install.mjs.
//
// Safe & idempotent:
//   - strips our hook entries from ~/.claude/settings.json (backs up first)
//   - NEVER touches ~/.claude/launcher-settings.json (managed/cloud config)
//   - deletes the copied script dir ~/.claude/feature-logger/
//   - leaves your captured records in ~/.claude/feature-log/ untouched
//
// Run from the repo: node tools/feature-logger/uninstall.mjs

import fs from "fs";
import path from "path";
import os from "os";
import { HOOK_EVENTS } from "./install.mjs";

const claudeDir = path.join(os.homedir(), ".claude");
const destDir = path.join(claudeDir, "feature-logger");
const settingsPath = path.join(claudeDir, "settings.json");
const HOOK_COMMAND = "~/.claude/feature-logger/feature-logger.mjs";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// Drop hook groups that reference our command; keep everything else.
export function stripOurHooks(arr) {
  if (!Array.isArray(arr)) return { next: arr, removed: 0 };
  let removed = 0;
  const next = arr
    .map((e) => {
      if (!Array.isArray(e?.hooks)) return e;
      const hooks = e.hooks.filter((h) => h?.command !== HOOK_COMMAND);
      removed += e.hooks.length - hooks.length;
      return { ...e, hooks };
    })
    // Drop now-empty groups (a group we fully cleared).
    .filter((e) => !Array.isArray(e?.hooks) || e.hooks.length > 0);
  return { next, removed };
}

function main() {
  // 1. Edit settings.json (NOT launcher-settings.json).
  if (fs.existsSync(settingsPath)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      log(`! ${settingsPath} is not valid JSON — aborting so it isn't clobbered.`);
      return;
    }
    let changed = false;
    if (settings.hooks && typeof settings.hooks === "object") {
      for (const event of HOOK_EVENTS) {
        const { next, removed } = stripOurHooks(settings.hooks[event]);
        if (removed > 0) {
          settings.hooks[event] = next;
          if (Array.isArray(next) && next.length === 0) delete settings.hooks[event];
          changed = true;
          log(`✓ ${event}: removed feature-logger hook`);
        }
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    if (changed) {
      const backup = `${settingsPath}.bak-${Date.now()}`;
      fs.copyFileSync(settingsPath, backup);
      log(`✓ Backed up settings → ${backup}`);
      try {
        const tmp = `${settingsPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
        fs.renameSync(tmp, settingsPath);
        log(`✓ Wrote ${settingsPath}`);
      } catch (err) {
        log(`! Could not write ${settingsPath}: ${err?.message || err}`);
        log("  The backup was already saved — remove the hooks manually if needed.");
      }
    } else {
      log("• No feature-logger hooks found in settings.json — nothing to remove.");
    }
  } else {
    log("• No settings.json found — nothing to remove.");
  }

  // 2. Delete the copied script dir.
  if (fs.existsSync(destDir)) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      log(`✓ Removed ${destDir}`);
    } catch (err) {
      log(`! Could not remove ${destDir}: ${err?.message || err}`);
      log("  Remove it manually if you like.");
    }
  }

  log("\nDone. Captured records remain in ~/.claude/feature-log/ (delete manually if you want).");
  log("Start a NEW Claude Code session for the change to take effect.");
}

// Entry guard: only mutate ~/.claude when run directly, never on test import.
import { pathToFileURL } from "url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
