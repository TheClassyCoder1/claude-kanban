"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// The dashboard is server-rendered (force-dynamic). New/finished sessions only
// appear on reload, so poll the server component on an interval. router.refresh()
// re-runs the RSC and reconciles — no full page reload, no websocket.
export default function AutoRefresh({ intervalMs = 3_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
