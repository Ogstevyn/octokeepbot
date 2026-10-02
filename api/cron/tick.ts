import { config } from "../../src/config.js";
import { getBot } from "../../src/runtime.js";
import { runTick } from "../../src/tick.js";

// Called every 15 minutes by an external scheduler (cron-job.org) or Vercel
// Cron. Accepts the secret as "Authorization: Bearer <CRON_SECRET>" (what
// Vercel Cron sends) or as ?secret=<CRON_SECRET>.
// Optional for demos: ?now=<ISO time> runs the scheduler as of that time, and
// ?user=<telegram id> limits it to one user.
async function handle(request: Request): Promise<Response> {
  const secret = config().CRON_SECRET;
  if (!secret) return new Response("CRON_SECRET is not set", { status: 500 });
  const url = new URL(request.url);
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}` && url.searchParams.get("secret") !== secret) return new Response("forbidden", { status: 403 });

  const nowParam = url.searchParams.get("now");
  const now = nowParam ? new Date(nowParam) : new Date();
  if (Number.isNaN(now.getTime())) return Response.json({ error: "now must be an ISO date" }, { status: 400 });
  const userParam = url.searchParams.get("user");
  const userId = userParam ? Number(userParam) : undefined;
  if (userParam && !Number.isSafeInteger(userId)) return Response.json({ error: "user must be a Telegram id" }, { status: 400 });

  const { deps } = getBot();
  const result = await runTick(deps, { now, userId });
  return Response.json({ ok: true, at: now.toISOString(), ...result });
}

export const GET = handle;
export const POST = handle;
