import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStatus, countChanges, aggregate, STATUS_META, type FeatureRecord } from "./featureTypes.ts";

function rec(over: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    sessionId: "s",
    projectPath: "/p",
    projectName: "p",
    model: "claude-opus-4-8",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    turns: 0,
    filesByArea: {},
    commands: [],
    userPrompts: [],
    summary: "",
    summaryHeadline: "",
    summarySource: "",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    estimatedCostUsd: 0,
    totalTokens: 0,
    ...over,
  };
}

test("deriveStatus: no activity → todo", () => {
  assert.equal(deriveStatus(rec()), "todo");
});

test("deriveStatus: turns or changes but no summary → in_progress", () => {
  assert.equal(deriveStatus(rec({ turns: 3 })), "in_progress");
  assert.equal(
    deriveStatus(rec({ filesByArea: { "Board UI": { created: ["a.tsx"], edited: [] } } })),
    "in_progress",
  );
});

test("deriveStatus: summary + source → done", () => {
  assert.equal(deriveStatus(rec({ summary: "did x", summarySource: "claude" })), "done");
});

test("deriveStatus: liveState awaiting_approval → awaiting_approval", () => {
  assert.equal(deriveStatus(rec({ turns: 2, liveState: "awaiting_approval" })), "awaiting_approval");
});

test("deriveStatus: liveState idle → idle", () => {
  assert.equal(deriveStatus(rec({ turns: 2, liveState: "idle" })), "idle");
});

test("deriveStatus: summary beats any liveState", () => {
  assert.equal(
    deriveStatus(rec({ summary: "did x", summarySource: "claude", liveState: "awaiting_approval" })),
    "done",
  );
});

test("deriveStatus: undefined liveState falls through to in_progress", () => {
  assert.equal(deriveStatus(rec({ turns: 2, liveState: undefined })), "in_progress");
});

test("STATUS_META has an entry for every Status", () => {
  for (const s of ["todo", "in_progress", "awaiting_approval", "idle", "done"] as const) {
    assert.ok(STATUS_META[s], `missing STATUS_META for ${s}`);
  }
});

test("countChanges sums created and edited across areas", () => {
  const r = rec({
    filesByArea: {
      "Board UI": { created: ["a.tsx"], edited: ["b.tsx"] },
      "Data layer & libs": { created: [], edited: ["c.ts"] },
    },
  });
  assert.equal(countChanges(r), 3);
});

test("aggregate rolls up counts, distinct projects, tokens and cost", () => {
  const a = aggregate([
    rec({ projectPath: "/a", totalTokens: 100, tokens: { input: 0, output: 40, cacheRead: 0, cacheCreation: 0 }, estimatedCostUsd: 1 }),
    rec({ projectPath: "/a", totalTokens: 50, tokens: { input: 0, output: 10, cacheRead: 0, cacheCreation: 0 }, estimatedCostUsd: 0.5 }),
    rec({ projectPath: "/b", totalTokens: 10, tokens: { input: 0, output: 5, cacheRead: 0, cacheCreation: 0 }, estimatedCostUsd: 0.25 }),
  ]);
  assert.deepEqual(a, {
    features: 3,
    projects: 2,
    totalTokens: 160,
    totalOutputTokens: 55,
    totalCostUsd: 1.75,
  });
});
