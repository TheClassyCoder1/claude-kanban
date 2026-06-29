import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { z } from "zod";
import { estimateCostUsd } from "./pricing";
import type { FeatureRecord } from "./featureTypes";

export type { FeatureRecord, Aggregates } from "./featureTypes";
export { aggregate } from "./featureTypes";

// Reads the per-session records written by the feature-logger hook
// (~/.claude/feature-log/<project-slug>/<session_id>.json) for the dashboard.

const tokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheCreation: z.number(),
});

const recordSchema = z.object({
  schemaVersion: z.number(),
  sessionId: z.string(),
  projectPath: z.string(),
  projectName: z.string(),
  model: z.string(),
  tokens: tokensSchema,
  turns: z.number(),
  filesByArea: z.record(
    z.string(),
    z.object({ created: z.array(z.string()), edited: z.array(z.string()) }),
  ),
  commands: z.array(z.string()),
  userPrompts: z.array(z.string()),
  summary: z.string(),
  summaryHeadline: z.string(),
  summarySource: z.string(),
  summaryUsage: z.unknown().optional(),
  summaryCostUsd: z.number().optional(),
  startedAt: z.string(),
  endedAt: z.string(),
  updatedAt: z.string(),
  liveState: z.enum(["awaiting_approval", "idle"]).optional(),
});

const FEATURE_LOG_DIR = path.join(os.homedir(), ".claude", "feature-log");

/** Parse + validate one record file's contents, deriving cost/totals. Returns
 *  null for anything malformed or schema-invalid. Pure — safe to unit test. */
export function recordFromJson(text: string): FeatureRecord | null {
  let parsed;
  try {
    parsed = recordSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const r = parsed.data;
  const totalTokens =
    r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheCreation;
  return { ...r, estimatedCostUsd: estimateCostUsd(r.model, r.tokens), totalTokens };
}

/** All feature records on this machine, newest first. */
export async function readFeatureRecords(): Promise<FeatureRecord[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(FEATURE_LOG_DIR);
  } catch {
    return []; // hook not installed / nothing captured yet
  }

  // Collect every record-file path across all project dirs, then read them
  // concurrently (one slow disk read no longer blocks the rest).
  const filePaths: string[] = [];
  await Promise.all(
    projectDirs.map(async (proj) => {
      const dir = path.join(FEATURE_LOG_DIR, proj);
      try {
        if (!(await fs.stat(dir)).isDirectory()) return;
        for (const f of await fs.readdir(dir)) {
          if (f.endsWith(".json")) filePaths.push(path.join(dir, f));
        }
      } catch {
        // skip unreadable project dir
      }
    }),
  );

  const parsed = await Promise.all(
    filePaths.map(async (file) => {
      try {
        return recordFromJson(await fs.readFile(file, "utf8"));
      } catch {
        return null; // unreadable file
      }
    }),
  );

  return parsed
    .filter((r): r is FeatureRecord => r !== null)
    .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}
