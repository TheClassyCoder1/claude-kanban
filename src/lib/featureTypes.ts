// Client-safe types + pure helpers (no Node imports), so client components can
// use them without dragging the fs-based reader into the browser bundle.

import type { TokenCounts } from "./pricing";

export type FileBucket = { created: string[]; edited: string[] };

export type FeatureRecord = {
  schemaVersion: number;
  sessionId: string;
  projectPath: string;
  projectName: string;
  model: string;
  tokens: TokenCounts;
  turns: number;
  filesByArea: Record<string, FileBucket>;
  commands: string[];
  userPrompts: string[];
  summary: string;
  summaryHeadline: string;
  summarySource: string;
  summaryUsage?: unknown;
  summaryCostUsd?: number;
  startedAt: string;
  endedAt: string;
  updatedAt: string;
  liveState?: "awaiting_approval" | "idle";
  // Derived in the reader:
  estimatedCostUsd: number;
  totalTokens: number;
};

export type Aggregates = {
  features: number;
  projects: number;
  totalTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
};

export type Status = "todo" | "in_progress" | "awaiting_approval" | "idle" | "done";

export function countChanges(r: FeatureRecord): number {
  return Object.values(r.filesByArea).reduce(
    (s, b) => s + b.created.length + b.edited.length,
    0,
  );
}

/** Lifecycle status derived from the captured record. */
export function deriveStatus(r: FeatureRecord): Status {
  if (r.summary && r.summarySource) return "done";
  if (r.liveState === "awaiting_approval") return "awaiting_approval";
  if (r.liveState === "idle") return "idle";
  if (r.turns > 0 || countChanges(r) > 0) return "in_progress";
  return "todo";
}

export const STATUS_META: Record<
  Status,
  { label: string; description: string; badge: string; dot: string; order: number }
> = {
  awaiting_approval: {
    label: "Waiting for you",
    description: "Claude is paused — needs you to accept a prompt.",
    badge: "bg-amber-100 text-amber-700",
    dot: "bg-amber-500",
    order: 0,
  },
  in_progress: {
    label: "In progress",
    description: "Being worked on — no end-of-session summary yet.",
    badge: "bg-blue-100 text-blue-700",
    dot: "bg-blue-500",
    order: 1,
  },
  idle: {
    label: "Finished — waiting for input",
    description: "Claude finished its turn — waiting for your next message.",
    badge: "bg-cyan-100 text-cyan-700",
    dot: "bg-cyan-500",
    order: 2,
  },
  todo: {
    label: "To do",
    description: "Session started but not picked up yet.",
    badge: "bg-slate-200 text-slate-600",
    dot: "bg-slate-400",
    order: 3,
  },
  done: {
    label: "Done",
    description: "Completed — summarized at session end.",
    badge: "bg-emerald-100 text-emerald-700",
    dot: "bg-emerald-500",
    order: 4,
  },
};

export type ViewBy = "feature" | "session" | "project";

export type RecordGroup = {
  key: string;
  title: string;
  subtitle: string;
  records: FeatureRecord[]; // newest first
  totalOutputTokens: number;
  totalCostUsd: number;
};

/** Group flat records by session or project for the dashboard's grouped views.
 *  Each (session × project) record stays one card; this only buckets them. */
export function groupRecords(records: FeatureRecord[], by: "session" | "project"): RecordGroup[] {
  const map = new Map<string, FeatureRecord[]>();
  for (const r of records) {
    const key = by === "session" ? r.sessionId : r.projectPath;
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return [...map.values()]
    .map((recs) => {
      const sorted = [...recs].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
      const head = sorted[0];
      const n = recs.length;
      return {
        key: by === "session" ? head.sessionId : head.projectPath,
        title:
          by === "project"
            ? head.projectName
            : head.summaryHeadline?.trim() || head.userPrompts[0] || head.sessionId.slice(0, 8),
        subtitle:
          by === "project"
            ? `${n} feature${n === 1 ? "" : "s"}`
            : [...new Set(recs.map((r) => r.projectName))].join(", "),
        records: sorted,
        totalOutputTokens: recs.reduce((s, r) => s + r.tokens.output, 0),
        totalCostUsd: recs.reduce((s, r) => s + r.estimatedCostUsd, 0),
      };
    })
    .sort((a, b) => (a.records[0].endedAt < b.records[0].endedAt ? 1 : -1));
}

export function aggregate(records: FeatureRecord[]): Aggregates {
  return {
    features: records.length,
    projects: new Set(records.map((r) => r.projectPath)).size,
    totalTokens: records.reduce((s, r) => s + r.totalTokens, 0),
    totalOutputTokens: records.reduce((s, r) => s + r.tokens.output, 0),
    totalCostUsd: records.reduce((s, r) => s + r.estimatedCostUsd, 0),
  };
}
