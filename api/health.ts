import { config } from "../src/config.js";

export function GET(): Response {
  try {
    const c = config();
    return Response.json({ ok: true, llm: { provider: c.llm.provider, model: c.llm.model }, memoryRelayer: c.MEMWAL_SERVER_URL, namespace: c.MEMWAL_NAMESPACE });
  } catch (e) {
    // Names the missing variable without echoing any value.
    return Response.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
