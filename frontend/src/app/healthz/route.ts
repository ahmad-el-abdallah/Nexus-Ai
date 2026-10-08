import { connection } from "next/server";

/** Liveness of the Next.js server itself (independent of the backend). */
export async function GET() {
  await connection(); // evaluate per request, never prerender
  return Response.json({ status: "ok", service: "nexus-ai-frontend" });
}
