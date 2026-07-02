import { writePrompt } from "@/lib/approvals";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { sessionId, prompt } = await request.json();
    await writePrompt(sessionId, prompt);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: "invalid request" }, { status: 400 });
  }
}
