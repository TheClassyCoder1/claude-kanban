import { writeRelayWindowMs } from "@/lib/approvals";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { ms } = await request.json();
    const stored = await writeRelayWindowMs(ms);
    return Response.json({ ok: true, ms: stored });
  } catch {
    return Response.json({ ok: false, error: "invalid ms" }, { status: 400 });
  }
}
