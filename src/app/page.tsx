import FeatureDashboard from "@/components/FeatureDashboard";
import AutoRefresh from "@/components/AutoRefresh";
import TabBadge from "@/components/TabBadge";
import ModeToggle from "@/components/ModeToggle";
import RelayWindowSelect from "@/components/RelayWindowSelect";
import { readFeatureRecords } from "@/lib/featureLog";
import { deriveStatus } from "@/lib/featureTypes";
import { readMode, readPendingApprovals, readAwaitingPrompts, readRelayWindowMs } from "@/lib/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home() {
  const [records, mode, pending, awaiting, relayWindowMs] = await Promise.all([
    readFeatureRecords(),
    readMode(),
    readPendingApprovals(),
    readAwaitingPrompts(),
    readRelayWindowMs(),
  ]);
  const pendingBySession = Object.fromEntries(pending.map((p) => [p.sessionId, p]));
  const awaitingSessions = new Set(awaiting.map((a) => a.sessionId));
  const attention =
    pending.length +
    awaiting.length +
    records.filter((r) => {
      const s = deriveStatus(r);
      return s === "awaiting_approval" || s === "idle";
    }).length;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Claude Session Dashboard</h1>
            <p className="text-sm text-slate-500">
              What you built with Claude Code — per session, with token usage and cost.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            {mode === "dashboard" && <RelayWindowSelect ms={relayWindowMs} />}
            <ModeToggle mode={mode} />
          </div>
        </header>
        <FeatureDashboard
          records={records}
          pendingBySession={pendingBySession}
          awaitingSessions={awaitingSessions}
        />
      </div>
      <AutoRefresh />
      <TabBadge count={attention} />
    </main>
  );
}
