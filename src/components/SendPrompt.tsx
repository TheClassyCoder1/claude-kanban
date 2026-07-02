"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SendPrompt({
  sessionId,
  label,
}: {
  sessionId: string;
  label: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, prompt: text }),
    });
    setText("");
    setSent(true);
    router.refresh();
    setBusy(false);
  };

  return (
    <div className="ml-4 mt-1 rounded-r-lg border-l-4 border-cyan-400 bg-cyan-50 p-3">
      <p className="truncate text-xs font-semibold text-cyan-900" title={label}>
        ↳ Follow-up for “{label}”
      </p>
      <p className="text-[10px] text-cyan-600">continues this session</p>
      <textarea
        value={text}
        disabled={busy}
        onChange={(e) => {
          setText(e.target.value);
          setSent(false);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
        }}
        rows={2}
        placeholder="Type an instruction to continue this session… (⌘↵ to send)"
        className="mt-1 w-full resize-y rounded border border-cyan-200 bg-white p-2 text-xs text-slate-700 transition-colors focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-200 disabled:opacity-60"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={busy || !text.trim()}
          onClick={send}
          className="inline-flex items-center gap-1.5 rounded bg-cyan-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-cyan-700 disabled:opacity-50"
        >
          {busy && (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {busy ? "Sending…" : "Send"}
        </button>
        {sent && !busy && (
          <span className="text-[10px] font-medium text-cyan-700">Sent — session resuming…</span>
        )}
      </div>
    </div>
  );
}
