"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PendingApproval } from "@/lib/approvals";

export default function PendingApprovalCard({
  pending,
  label,
}: {
  pending: PendingApproval;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "allow" | "deny">(null);
  const [done, setDone] = useState<null | "allow" | "deny">(null);

  const decide = async (decision: "allow" | "deny") => {
    if (busy) return;
    setBusy(decision);
    await fetch("/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: pending.sessionId, decision }),
    });
    setDone(decision);
    router.refresh();
    setBusy(null);
  };

  if (done) {
    return (
      <div
        className={`ml-4 mt-1 rounded-r-lg border-l-4 p-3 text-xs font-semibold ${
          done === "allow"
            ? "border-emerald-400 bg-emerald-50 text-emerald-700"
            : "border-rose-400 bg-rose-50 text-rose-700"
        }`}
      >
        {done === "allow" ? "✓ Approved" : "✕ Denied"} {pending.tool} — “{label}”
      </div>
    );
  }

  const Spinner = () => (
    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
  );

  return (
    <div className="ml-4 mt-1 rounded-r-lg border-l-4 border-amber-400 bg-amber-50 p-3">
      <p className="truncate text-xs font-semibold text-amber-900" title={label}>
        ↳ Approval for “{label}”
      </p>
      <p className="text-[10px] text-amber-600">needs {pending.tool} permission</p>
      <pre className="mt-1 overflow-x-auto rounded bg-white/70 p-2 text-xs text-slate-700">
        {pending.input}
      </pre>
      <div className="mt-2 flex gap-2">
        <button
          disabled={!!busy}
          onClick={() => decide("allow")}
          className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy === "allow" && <Spinner />}
          {busy === "allow" ? "Approving…" : "Approve"}
        </button>
        <button
          disabled={!!busy}
          onClick={() => decide("deny")}
          className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
        >
          {busy === "deny" && <Spinner />}
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
    </div>
  );
}
