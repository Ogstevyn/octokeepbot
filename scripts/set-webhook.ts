import "./env.js";
import { Bot } from "grammy";
import { COMMANDS } from "../src/bot/telegram.js";
import { config } from "../src/config.js";

// Usage: npm run set-webhook -- https://your-app.vercel.app
const base = process.argv[2]?.replace(/\/+$/, "");
if (!base?.startsWith("https://")) {
  console.error("Usage: npm run set-webhook -- https://your-app.vercel.app");
  process.exit(1);
}
const c = config();
if (!c.TELEGRAM_WEBHOOK_SECRET) {
  console.error("Set TELEGRAM_WEBHOOK_SECRET first (openssl rand -hex 32).");
  process.exit(1);
}
const bot = new Bot(c.TELEGRAM_BOT_TOKEN);
await bot.api.setWebhook(`${base}/api/telegram`, {
  secret_token: c.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
});
await bot.api.setMyCommands(COMMANDS);
await bot.api.setMyShortDescription("Send a link. Get the summary. Get reminded until you act on it.");
await bot.api.setMyDescription(
  "OctoKeep reads what you save, remembers it in your own Walrus Memory account, and checks back until you act on it. It also turns 'remind me to do X on Thursday' into a plan sent at the right time.",
);
const info = await bot.api.getWebhookInfo();
console.log(`Webhook set to ${info.url}`);
console.log(`Pending updates: ${info.pending_update_count}${info.last_error_message ? `, last error: ${info.last_error_message}` : ""}`);
