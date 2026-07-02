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
const toolsDir = path.resolve(here, ".."); // repo tools/ dir
const claudeDir = path.join(os.homedir(), ".claude");
const settingsPath = path.join(claudeDir, "settings.json");
// The commands Claude Code will run. ~ is expanded by Claude Code.
const HOOK_COMMAND = "~/.claude/feature-logger/feature-logger.mjs";
const AG_COMMAND = "~/.claude/approval-gate/approval-gate.mjs";
const PR_COMMAND = "~/.claude/prompt-relay/prompt-relay.mjs";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

// Each hook script: which repo file to copy, where to, its command, and the
// events it registers. Prune runs per-command against its own event set, so the
// two scripts never step on each other.
export const INSTALLS = [
  {
    command: HOOK_COMMAND,
    events: HOOK_EVENTS,
    timeout: 60,
    src: "feature-logger/feature-logger.mjs",
    dest: path.join(claudeDir, "feature-logger", "feature-logger.mjs"),
  },
  {
    command: AG_COMMAND,
    events: ["PreToolUse"],
    timeout: 600,
    src: "approval-gate/approval-gate.mjs",
    dest: path.join(claudeDir, "approval-gate", "approval-gate.mjs"),
  },
  {
    command: PR_COMMAND,
    events: ["Stop"],
    timeout: 600,
    src: "prompt-relay/prompt-relay.mjs",
    dest: path.join(claudeDir, "prompt-relay", "prompt-relay.mjs"),
  },
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function hookEntry(command, timeout) {
  return {
    matcher: "",
    hooks: [{ type: "command", command, timeout }],
  };
}

function hasOurHook(arr, command) {
  return (
    Array.isArray(arr) &&
    arr.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command === command))
  );
}

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

// Remove our command from any event we no longer register (renames/removals),
// leaving other tools' hooks intact. Mutates `hooks`; returns pruned event names.
export function pruneStaleHooks(hooks, command, keepEvents) {
  const pruned = [];
  for (const event of Object.keys(hooks)) {
    if (keepEvents.includes(event) || !Array.isArray(hooks[event])) continue;
    const before = hooks[event].length;
    hooks[event] = hooks[event].filter(
      (e) => !(Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command === command)),
    );
    if (hooks[event].length === before) continue;
    pruned.push(event);
    if (hooks[event].length === 0) delete hooks[event]; // we emptied it → drop
  }
  return pruned;
}

function main() {
  // 1. Copy each script.
  for (const inst of INSTALLS) {
    fs.mkdirSync(path.dirname(inst.dest), { recursive: true });
    fs.copyFileSync(path.join(toolsDir, inst.src), inst.dest);
    try {
      fs.chmodSync(inst.dest, 0o755);
    } catch {
      /* best effort */
    }
    log(`✓ Installed script → ${inst.dest}`);
  }

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

  // 3. Merge + prune each command against its own event set.
  settings.hooks = settings.hooks || {};
  let changed = false;
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
    log("\nScript updated to latest; hook registrations already in sync.");
  }
}

import { pathToFileURL } from "url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
