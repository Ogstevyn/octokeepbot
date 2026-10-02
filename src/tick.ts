import { BlockedError, sendNudge, type Deps } from "./bot/core.js";
import { outboxDelayMs } from "./schedule.js";

export interface TickResult {
  nudged: number;
  failed: number;
  memoryRetried: number;
  memoryFailed: number;
}

// A claimed item is leased for this long. If sending fails for a reason
// other than the user blocking the bot, it is retried after the lease.
const LEASE_MS = 10 * 60_000;
const MAX_OUTBOX_ATTEMPTS = 12;

export async function runTick(d: Deps, opts: { now?: Date; userId?: number; limit?: number } = {}): Promise<TickResult> {
  const now = opts.now ?? d.now();
  const result: TickResult = { nudged: 0, failed: 0, memoryRetried: 0, memoryFailed: 0 };

  const due = await d.repo.claimDue(now, LEASE_MS, opts.limit ?? 50, opts.userId);
  for (const item of due) {
    const user = await d.repo.getUser(item.userId);
    if (!user) continue;
    try {
      await sendNudge(d, user, item, now);
      result.nudged++;
    } catch (e) {
      result.failed++;
      if (e instanceof BlockedError) {
        // The user blocked the bot or deleted the chat: stop trying.
        await d.repo.updateItem(item.id, item.userId, { status: "quiet", nextAt: null });
      } else {
        d.log(`nudge failed for item ${item.id}`, String((e as Error).message ?? e));
      }
    }
  }

  // Retry memory writes that failed earlier.
  const pending = opts.userId ? [] : await d.repo.claimOutbox(now, 20);
  for (const entry of pending) {
    const user = await d.repo.getUser(entry.userId);
    if (!user?.creds || entry.attempts > MAX_OUTBOX_ATTEMPTS) {
      await d.repo.deleteOutbox(entry.id);
      if (entry.attempts > MAX_OUTBOX_ATTEMPTS) d.log(`gave up on memory write ${entry.id} after ${entry.attempts} attempts`);
      continue;
    }
    try {
      await d.memoryFor(user.creds).remember(entry.text);
      await d.repo.deleteOutbox(entry.id);
      result.memoryRetried++;
    } catch (e) {
      result.memoryFailed++;
      await d.repo.failOutbox(entry.id, String((e as Error).message ?? e), new Date(now.getTime() + outboxDelayMs(entry.attempts)));
    }
  }

  if (!opts.userId) await d.repo.pruneSeenUpdates(new Date(now.getTime() - 3 * 86_400_000));
  return result;
}
