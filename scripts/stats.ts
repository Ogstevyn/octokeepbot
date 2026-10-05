import "./env.js";
import { config } from "../src/config.js";
import { memwalFor } from "../src/memory/client.js";
import { getRepo } from "../src/runtime.js";

// Usage evidence for the hackathon submission. For every user it asks their
// Walrus Memory account how many memories it holds in OctoKeep's namespace,
// next to OctoKeep's own counts. Telegram ids are replaced by labels so the
// output can be shared.
const c = config();
const repo = getRepo();
const rows = await repo.usageStats();

console.log("user     walrus memories  octokeep count  saves  tasks  resolved");
let qualifying = 0;
for (const [i, r] of rows.entries()) {
  const u = await repo.getUser(r.userId);
  let live = "not connected";
  if (u?.creds) {
    try {
      const n = await memwalFor(u.creds, c.MEMWAL_SERVER_URL, c.MEMWAL_NAMESPACE).count();
      live = String(n);
      if (n >= 10) qualifying++;
    } catch (e) {
      live = `error: ${String((e as Error).message).slice(0, 40)}`;
    }
  }
  console.log(`user ${String(i + 1).padEnd(4)} ${live.padStart(15)}  ${String(r.memories).padStart(14)}  ${String(r.saves).padStart(5)}  ${String(r.tasks).padStart(5)}  ${String(r.resolved).padStart(8)}`);
}
console.log(`\n${rows.length} users, ${qualifying} with 10 or more memories in Walrus Memory.`);
