import { waitUntil } from "@vercel/functions";
import type { Update } from "grammy/types";
import { config } from "../src/config.js";
import { getBot, getRepo } from "../src/runtime.js";

// Telegram webhook. Replies 200 at once and processes the update in the
// background, so slow work (fetching a page, the model, a Walrus write) never
// makes Telegram time out and resend the update.
export async function POST(request: Request): Promise<Response> {
  const secret = config().TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return new Response("TELEGRAM_WEBHOOK_SECRET is not set", { status: 500 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (typeof update?.update_id !== "number") return new Response("bad request", { status: 400 });

  waitUntil(processUpdate(update));
  return new Response("ok");
}

async function processUpdate(update: Update) {
  try {
    if (!(await getRepo().markUpdateSeen(update.update_id))) return;
    const { bot } = getBot();
    if (!bot.isInited()) await bot.init();
    await bot.handleUpdate(update);
  } catch (e) {
    console.error("[octokeep] webhook update failed", e);
  }
}
