import "./env.js";
import { COMMANDS } from "../src/bot/telegram.js";
import { getBot } from "../src/runtime.js";
import { runTick } from "../src/tick.js";

// Local development: long polling instead of a webhook, and the scheduler
// every minute instead of an external cron. Stops any webhook first, because
// Telegram delivers to one or the other, never both.
const { bot, deps } = getBot();
await bot.api.deleteWebhook();
await bot.api.setMyCommands(COMMANDS);

const timer = setInterval(async () => {
  try {
    const r = await runTick(deps);
    if (r.nudged || r.failed || r.memoryRetried || r.memoryFailed) console.log("[tick]", r);
  } catch (e) {
    console.error("[tick] failed", e);
  }
}, 60_000);

const stop = () => {
  clearInterval(timer);
  void bot.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await bot.start({
  allowed_updates: ["message", "callback_query"],
  onStart: (me) => console.log(`OctoKeep is running as @${me.username} (polling). Press Ctrl+C to stop.`),
});
