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

let running = true;
const stop = () => {
  running = false;
  clearInterval(timer);
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Long polling that handles updates concurrently, the way the webhook does in
// production. grammY's bot.start() handles one update at a time, which would
// keep the photos of an album from being combined into one summary.
await bot.init();
console.log(`OctoKeep is running as @${bot.botInfo.username} (polling). Press Ctrl+C to stop.`);
let offset = 0;
while (running) {
  let updates;
  try {
    updates = await bot.api.getUpdates({ offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
  } catch (e) {
    console.error("[poll] getUpdates failed, retrying", String(e));
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  for (const update of updates) {
    offset = update.update_id + 1;
    bot.handleUpdate(update).catch((e) => console.error("[poll] update failed", e));
  }
}
