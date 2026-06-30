import FeatureDashboard from "@/components/FeatureDashboard";
import AutoRefresh from "@/components/AutoRefresh";
import TabBadge from "@/components/TabBadge";
import { readFeatureRecords } from "@/lib/featureLog";
import { deriveStatus } from "@/lib/featureTypes";
import type { FeatureRecord } from "@/lib/featureTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home() {
  let records: FeatureRecord[];
  let loadError: string | null = null;
  try {
    records = await readFeatureRecords();
  } catch (err) {
    console.error("[feature-log] failed to load records:", err);
    records = [];
    loadError =
      err instanceof Error ? err.message : "An unexpected error occurred while reading feature logs.";
  }

  const attention = records.filter((r) => {
    const s = deriveStatus(r);
    return s === "awaiting_approval" || s === "idle";
  }).length;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Claude Session Dashboard</h1>
          <p className="text-sm text-slate-500">
            What you built with Claude Code — per session, with token usage and cost.
          </p>
        </header>
        {loadError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p className="font-medium">Failed to load feature records</p>
            <p className="mt-1 text-xs text-red-600">{loadError}</p>
          </div>
        )}
        <FeatureDashboard records={records} />
      </div>
      <AutoRefresh />
      <TabBadge count={attention} />
    </main>
  );
}
