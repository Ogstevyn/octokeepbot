import { addDays } from "./time.js";
import type { Item } from "./types.js";

// Nudges stop after this many go unanswered; the item moves to /ignored.
export const MAX_SAVE_NUDGES = 3;
export const MAX_TASK_REMINDERS = 2;

export interface AfterNudge {
  status: "open" | "quiet";
  nextAt: Date | null;
  nudgeCount: number;
}

// Called after a nudge was sent. nudgeCount on the item is the count before
// this nudge. Saves back off exponentially from the chosen gap (2, 4, 8 days
// for the default) so an ignored item does not nag; a task gets one follow-up
// a day later, then goes quiet.
export function afterNudge(item: Pick<Item, "kind" | "gapDays" | "nudgeCount">, now: Date): AfterNudge {
  const n = item.nudgeCount + 1;
  if (item.kind === "task") {
    return n >= MAX_TASK_REMINDERS ? { status: "quiet", nextAt: null, nudgeCount: n } : { status: "open", nextAt: addDays(now, 1), nudgeCount: n };
  }
  if (n >= MAX_SAVE_NUDGES) return { status: "quiet", nextAt: null, nudgeCount: n };
  return { status: "open", nextAt: addDays(now, item.gapDays * 2 ** n), nudgeCount: n };
}

// Retry delays for memory writes that failed: 1m, 5m, 30m, 2h, then every 6h.
export function outboxDelayMs(attempts: number): number {
  const steps = [60_000, 300_000, 1_800_000, 7_200_000];
  return steps[attempts - 1] ?? 21_600_000;
}
