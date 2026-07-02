"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const OPTIONS = [
  { ms: 60_000, label: "1 min" },
  { ms: 120_000, label: "2 min" },
  { ms: 300_000, label: "5 min" },
  { ms: 600_000, label: "10 min" },
];

export default function RelayWindowSelect({ ms }: { ms: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <label className="flex items-center gap-1 text-[10px] text-slate-500">
      wait
      <select
        disabled={busy}
        value={ms}
        onChange={async (e) => {
          setBusy(true);
          await fetch("/api/relay-window", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ms: Number(e.target.value) }),
          });
          router.refresh();
          setBusy(false);
        }}
        className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] disabled:opacity-60"
      >
        {OPTIONS.map((o) => (
          <option key={o.ms} value={o.ms}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
