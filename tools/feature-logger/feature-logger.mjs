#!/usr/bin/env node
// Claude Code "feature logger" hook — standalone, zero dependencies.
//
// Registered as a global Stop + SessionEnd hook (see install.mjs). On each turn it
// cheaply records what a session did (files changed, tokens, commands, prompts) to
// ~/.claude/feature-log/<slug>/<session_id>.json. At session end it adds a
// natural-language "what we did" summary written by `claude -p` (your Claude Code
// subscription — no API key). The companion Next.js app reads these files.
//
// It never blocks your turn: every path exits 0, all work is wrapped in try/catch.

import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Parsing helpers. Pure functions are exported for unit tests; running this
// file as a hook still executes main() via the entry guard at the bottom.
// ---------------------------------------------------------------------------
const MUTATING = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const SIGNIFICANT_CMD =
  /\b(git\s+(commit|push|merge|rebase|tag)|npm\s+(install|i|ci)|npx\s+create-|prisma\s+migrate|npm\s+run\s+(build|test|lint)|yarn\s+\w|pnpm\s+(install|add))/;

const INJECTION = [
  /^Base directory for this skill/,
  /^<command-/,
  /^Caveat:/i,
  /system-reminder/i,
  /^\[Request interrupted/,
  /^Result of calling/,
  /^The user (opened|approved|rejected|selected)/,
  /^API Error/,
  /^Continue from where you left off/i,
];

const CONFIG_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "eslint.config.mjs",
  "eslint.config.js",
  ".eslintrc.json",
  "postcss.config.mjs",
  "postcss.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  ".gitignore",
  "next-env.d.ts",
  "components.json",
]);

export function classify(rel) {
  const base = rel.split("/").pop() || rel;
  if (CONFIG_FILES.has(base) || base.startsWith(".env")) return "Project setup";
  if (rel.startsWith("src/lib/") || rel.startsWith("lib/")) return "Data layer & libs";
  if (rel.startsWith("src/app/api/") || rel.startsWith("app/api/") || rel.startsWith("pages/api/"))
    return "API routes";
  if (rel.startsWith("src/components/") || rel.startsWith("components/")) return "Board UI";
  if (rel.startsWith("src/app/") || rel.startsWith("app/")) return "Board UI";
  if (base.endsWith(".md")) return "Docs";
  return "Other";
}

export function isRealPrompt(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t || t.length > 1500) return false;
  return !INJECTION.some((re) => re.test(t));
}

export function slugForCwd(cwd) {
  // Mirror Claude Code's own project-dir scheme: replace "/" with "-".
  return (cwd || "unknown").replace(/\//g, "-");
}

// Mask common credential shapes before a prompt is persisted/displayed.
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9-]{20,}/g, // OpenAI / Anthropic style keys
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
];
export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

// ---------------------------------------------------------------------------
// Live state: maps a hook event to the session's current waiting-state.
//   awaiting_approval — Claude paused, needs the user to accept a prompt
//   idle              — Claude finished its turn, waiting for the next message
//   undefined         — no live override; fall back to turn/summary status
// ---------------------------------------------------------------------------
export function liveStateForEvent(event, message, existing) {
  switch (event) {
    case "Notification":
      // Claude Code also fires Notification on ~60s input idle; only permission
      // prompts set the waiting state. Non-permission → keep whatever we had.
      return /permission/i.test(message || "") ? "awaiting_approval" : existing;
    case "Stop":
      return "idle";
    case "PostToolUse":
      // A tool only executes once its permission prompt is accepted; reaching
      // PostToolUse means Claude is working again, so clear any 'awaiting'.
      return undefined;
    case "UserPromptSubmit":
    case "SessionStart":
    case "SessionEnd":
      return undefined;
    default:
      return existing;
  }
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------
// Returns ONE base record per project (cwd) touched in the session. A session
// that works in two repos yields two records (same session_id, different
// project). Files are attributed to the repo they live under — not the active
// cwd — so a Write into repo B while cwd is repo A still lands under B.
export function parseTranscript(transcriptPath, fallbackCwd) {
  const raw = fs.readFileSync(transcriptPath, "utf8");

  // First pass: parse lines and collect the set of cwds for prefix matching.
  const parsed = [];
  const knownCwds = new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.cwd === "string" && o.cwd) knownCwds.add(o.cwd);
    parsed.push(o);
  }
  if (knownCwds.size === 0 && fallbackCwd) knownCwds.add(fallbackCwd);

  // Longest-prefix cwd a file lives under; null if it's outside every repo.
  const cwdForFile = (f) => {
    let best = null;
    for (const c of knownCwds) {
      if ((f === c || f.startsWith(c + "/")) && (!best || c.length > best.length)) best = c;
    }
    return best;
  };

  // Per-cwd accumulators.
  const byCwd = new Map();
  const acc = (cwd) => {
    let a = byCwd.get(cwd);
    if (!a) {
      a = {
        cwd,
        model: "",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        created: new Set(),
        edited: new Set(),
        commands: [],
        userPrompts: [],
        turns: 0,
        startedAt: null,
        endedAt: null,
      };
      byCwd.set(cwd, a);
    }
    return a;
  };

  let lastCwd = "";
  for (const o of parsed) {
    if (typeof o.cwd === "string" && o.cwd) lastCwd = o.cwd;
    const lineCwd = lastCwd || fallbackCwd || "";
    const a = acc(lineCwd);

    if (typeof o.timestamp === "string") {
      if (!a.startedAt || o.timestamp < a.startedAt) a.startedAt = o.timestamp;
      if (!a.endedAt || o.timestamp > a.endedAt) a.endedAt = o.timestamp;
    }

    if (o.type === "user") {
      const content = o.message?.content;
      if (isRealPrompt(content)) a.userPrompts.push(redactSecrets(content.trim().slice(0, 300)));
    } else if (o.type === "assistant") {
      a.turns++;
      const u = o.message?.usage;
      if (u) {
        a.tokens.input += u.input_tokens || 0;
        a.tokens.output += u.output_tokens || 0;
        a.tokens.cacheRead += u.cache_read_input_tokens || 0;
        a.tokens.cacheCreation += u.cache_creation_input_tokens || 0;
      }
      if (o.message?.model) a.model = o.message.model;
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || b.type !== "tool_use") continue;
          const inp = b.input || {};
          if (b.name === "Write" && typeof inp.file_path === "string") {
            acc(cwdForFile(inp.file_path) || lineCwd).created.add(inp.file_path);
          } else if (MUTATING.has(b.name)) {
            const fp = inp.file_path || inp.notebook_path;
            if (typeof fp === "string") acc(cwdForFile(fp) || lineCwd).edited.add(fp);
          } else if (b.name === "Bash" && typeof inp.command === "string") {
            a.commands.push(inp.command);
          }
        }
      }
    }
  }

  const bases = [];
  for (const a of byCwd.values()) {
    const effectiveCwd = a.cwd;
    const hasActivity =
      a.turns > 0 || a.created.size || a.edited.size || a.commands.length || a.userPrompts.length;
    if (!hasActivity) continue;

    const rel = (f) => {
      if (effectiveCwd && f.startsWith(effectiveCwd + "/")) return f.slice(effectiveCwd.length + 1);
      return effectiveCwd ? null : f; // outside project → skip when we know cwd
    };
    const filesByArea = {};
    const bucket = (f, kind) => {
      const r = rel(f);
      if (!r) return;
      const area = classify(r);
      if (!filesByArea[area]) filesByArea[area] = { created: [], edited: [] };
      filesByArea[area][kind].push(r);
    };
    a.created.forEach((f) => bucket(f, "created"));
    a.edited.forEach((f) => {
      if (!a.created.has(f)) bucket(f, "edited");
    });
    for (const area of Object.keys(filesByArea)) {
      filesByArea[area].created = [...new Set(filesByArea[area].created)].sort();
      filesByArea[area].edited = [...new Set(filesByArea[area].edited)].sort();
    }

    const sigCommands = [
      ...new Set(
        a.commands.map((c) => c.split("\n")[0].trim()).filter((c) => SIGNIFICANT_CMD.test(c)),
      ),
    ].slice(0, 10);

    bases.push({
      projectPath: effectiveCwd,
      projectName: effectiveCwd ? path.basename(effectiveCwd) : "unknown",
      model: a.model || "claude-opus-4-8",
      tokens: a.tokens,
      turns: a.turns,
      filesByArea,
      commands: sigCommands,
      userPrompts: a.userPrompts.slice(-12),
      startedAt: a.startedAt || new Date().toISOString(),
      endedAt: a.endedAt || new Date().toISOString(),
    });
  }

  // Never regress to zero records: seed one empty base for the known cwd.
  if (bases.length === 0) bases.push(emptyBase(fallbackCwd || [...knownCwds][0] || ""));
  return bases;
}

function emptyBase(cwd) {
  const ts = new Date().toISOString();
  return {
    projectPath: cwd,
    projectName: cwd ? path.basename(cwd) : "unknown",
    model: "claude-opus-4-8",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    turns: 0,
    filesByArea: {},
    commands: [],
    userPrompts: [],
    startedAt: ts,
    endedAt: ts,
  };
}

// ---------------------------------------------------------------------------
// Persistence (atomic, idempotent per session_id)
// ---------------------------------------------------------------------------
function recordPath(sessionId, projectPath) {
  const dir = path.join(os.homedir(), ".claude", "feature-log", slugForCwd(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.json`);
}

function readExisting(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Summary (SessionEnd): compact prompt → `claude -p`, heuristic fallback
// ---------------------------------------------------------------------------
function buildSummaryPrompt(rec) {
  const areaLines = Object.entries(rec.filesByArea).map(([area, f]) => {
    const c = f.created.slice(0, 12);
    const e = f.edited.slice(0, 12);
    const bits = [];
    if (c.length) bits.push(`created ${c.join(", ")}`);
    if (e.length) bits.push(`edited ${e.join(", ")}`);
    return `- ${area}: ${bits.join("; ")}`;
  });
  return [
    "Summarize a coding work session for a dashboard. Be specific and factual.",
    "",
    `Project: ${rec.projectName} (${rec.projectPath})`,
    "",
    "What the user asked for:",
    ...rec.userPrompts.slice(0, 10).map((p) => `- ${p}`),
    "",
    "Files changed, by area:",
    ...(areaLines.length ? areaLines : ["- (none)"]),
    "",
    rec.commands.length ? `Key commands: ${rec.commands.join(" ; ")}` : "",
    "",
    "Write plain text (no markdown): first line is a short headline (<= 10 words) of what was",
    "accomplished; then 2-4 sentences describing what was built and why.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function heuristicSummary(rec) {
  const areas = Object.keys(rec.filesByArea);
  let created = 0;
  let edited = 0;
  for (const a of areas) {
    created += rec.filesByArea[a].created.length;
    edited += rec.filesByArea[a].edited.length;
  }
  const headline = `Worked on ${rec.projectName}` + (areas.length ? ` (${areas.join(", ")})` : "");
  const body =
    `Created ${created} and edited ${edited} file(s)` +
    (areas.length ? ` across ${areas.join(", ")}.` : ".") +
    (rec.commands.length ? ` Key commands: ${rec.commands.slice(0, 4).join("; ")}.` : "");
  return { headline, text: `${headline}\n${body}` };
}

function summarizeWithClaude(rec) {
  const prompt = buildSummaryPrompt(rec);
  try {
    const res = spawnSync("claude", ["-p", prompt, "--output-format", "json"], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, FEATURE_LOGGER_ACTIVE: "1" },
    });
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout);
    const text = (parsed.result || "").trim();
    if (!text) return null;
    return {
      summary: text,
      summaryHeadline: text.split("\n")[0].slice(0, 120),
      summarySource: "claude",
      summaryUsage: parsed.usage || undefined,
      summaryCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  // Recursion guard: our own `claude -p` child inherits this.
  if (process.env.FEATURE_LOGGER_ACTIVE === "1") return;

  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  if (input.stop_hook_active === true) return; // avoid Stop-driven recursion

  const event = input.hook_event_name || "Stop";
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId) return;

  // At SessionStart the transcript may be empty/absent — still seed a "to do"
  // record so the dashboard shows the session as started-but-not-picked-up.
  // A session may touch several projects → one base record (and file) each.
  let bases;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    bases = parseTranscript(transcriptPath, input.cwd);
  } else if (event === "SessionStart" && input.cwd) {
    bases = [emptyBase(input.cwd)];
  } else {
    return;
  }

  for (const base of bases) {
    const file = recordPath(sessionId, base.projectPath);
    const existing = readExisting(file) || {};

    const record = {
      schemaVersion: 2,
      sessionId,
      ...base,
      // Preserve any summary already written (e.g. a late Stop after SessionEnd).
      summary: existing.summary || "",
      summaryHeadline: existing.summaryHeadline || "",
      summarySource: existing.summarySource || "",
      summaryUsage: existing.summaryUsage,
      summaryCostUsd: existing.summaryCostUsd,
      liveState: liveStateForEvent(event, input.message, existing.liveState),
      updatedAt: new Date().toISOString(),
    };

    if (event === "SessionEnd") {
      // ponytail: one claude -p per project — N calls for an N-project session.
      // Fine; multi-project sessions are rare. Batch into one call if cost bites.
      const summary = summarizeWithClaude(base) || {
        ...heuristicSummary(base),
        summarySource: "heuristic",
      };
      record.summary = summary.summary ?? summary.text;
      record.summaryHeadline = summary.summaryHeadline ?? summary.headline;
      record.summarySource = summary.summarySource;
      record.summaryUsage = summary.summaryUsage;
      record.summaryCostUsd = summary.summaryCostUsd;
    }

    writeAtomic(file, record);
  }
}

// Entry guard: run as a hook (invoked directly), stay quiet when imported by tests.
import { pathToFileURL } from "url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch {
    // never block the user's turn
  }
  process.exit(0);
}
