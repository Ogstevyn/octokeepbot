import { randomBytes } from "node:crypto";
import type { Repo } from "../db/repo.js";
import type { Llm } from "../llm/llm.js";
import { LlmError } from "../llm/llm.js";
import {
  answerPrompt,
  chatPrompt,
  OutcomeSchema,
  outcomePrompt,
  PlanSchema,
  planPrompt,
  QuestionsSchema,
  questionsPrompt,
  nudgeLinePrompt,
  PathSchema,
  pathPrompt,
  RouteSchema,
  routePrompt,
  SummarySchema,
  summaryPrompt,
  TopicsSchema,
  topicsPrompt,
  WhenSchema,
  whenPrompt,
} from "../llm/prompts.js";
import { memoryLine, MemoryAuthError, type Memory, type Recalled } from "../memory/client.js";
import { afterNudge } from "../schedule.js";
import type { FetchResult } from "../sources/index.js";
import type { MediaPart } from "../db/repo.js";
import { hasSpeech, hasText, type Media } from "../media/media.js";
import { findUrl } from "../sources/index.js";
import {
  addDays,
  addHours,
  atLocalHour,
  calendarContext,
  DAY_MS,
  formatDate,
  formatIn,
  formatDay,
  formatWhen,
  isIsoDate,
  isValidZone,
  localHour,
  localNow,
  localTime,
  parseCheckBack,
  parseGap,
  parseTimeOfDay,
  resolveZone,
  toInstant,
  tomorrowAt,
} from "../time.js";
import type { Button, Content, Item, MemwalCreds, Pending, SavePayload, TaskDraft, TaskPayload, User } from "../types.js";
import {
  clip,
  CONNECT_STEPS,
  defaultGapButtons,
  effortLabel,
  esc,
  gapButtons,
  HELP,
  intentButtons,
  nudgeButtons,
  taskButtons,
  timeButtons,
  TZ_BUTTONS,
} from "./ui.js";

export interface Out {
  send(chatId: number, html: string, buttons?: Button[][]): Promise<number>;
  removeButtons(chatId: number, messageId: number): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  typing(chatId: number): Promise<void>;
}

export class BlockedError extends Error {}

export interface Deps {
  repo: Repo;
  out: Out;
  llm: Llm;
  memoryFor(creds: MemwalCreds): Memory;
  fetchContent(url: string): Promise<FetchResult>;
  now(): Date;
  adminIds: Set<number>;
  // For buddy invite links.
  botUsername: string;
  envCreds: MemwalCreds | null;
  media: Media;
  sleep(ms: number): Promise<void>;
  log(message: string, extra?: unknown): void;
}

export interface Incoming {
  userId: number;
  chatId: number;
  messageId: number;
  firstName: string;
  text: string;
}

// A photo, video or voice message. `download` fetches the file from Telegram.
export interface IncomingMedia {
  userId: number;
  chatId: number;
  messageId: number;
  firstName: string;
  // image: a screenshot to read. recording: a video or audio clip to save.
  // voice: a spoken message, handled as if it were typed.
  kind: "image" | "recording" | "voice";
  mime: string;
  caption: string;
  groupId?: string;
  fileSize?: number;
  download(): Promise<Uint8Array>;
}

export interface Callback {
  userId: number;
  chatId: number;
  messageId: number;
  firstName: string;
  data: string;
}

const ACCOUNT_RE = /\b0x[0-9a-fA-F]{64}\b/;
const HEX_KEY_RE = /\b(?:0x)?[0-9a-fA-F]{64}\b/;
const SUI_KEY_RE = /\bsuiprivkey1[0-9a-z]{20,}\b/;

type PromptPair = { system: string; prompt: string };
const ask = <T>(d: Deps, task: string, schema: import("zod").ZodType<T>, p: PromptPair) => d.llm.json(task, schema, p.system, p.prompt);
const say = (d: Deps, task: string, p: PromptPair) => d.llm.text(task, p.system, p.prompt);

const zoneOf = (u: User) => u.timezone ?? "UTC";
const isSave = (i: Item): i is Item & { payload: SavePayload } => i.kind === "save";
const isTask = (i: Item): i is Item & { payload: TaskPayload } => i.kind === "task";
// A check-back of minutes or hours is for the first reminder only. Later
// follow-ups (partly done, not yet, reopened) wait at least a day.
const followUpDays = (i: Item) => Math.max(i.gapDays, 1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setPending(d: Deps, u: User, pending: Pending | null) {
  u.pending = pending;
  await d.repo.updateUser(u.id, { pending });
}

// Stores a memory line. The line is queued first so a failed write is retried
// by the scheduler instead of being lost.
export async function remember(d: Deps, u: User, text: string) {
  if (!u.creds) return;
  const id = await d.repo.enqueueMemory(u.id, text);
  try {
    await d.memoryFor(u.creds).remember(text);
    await d.repo.deleteOutbox(id);
    await d.repo.addMemoryCount(u.id, 1);
  } catch (e) {
    d.log("memory write failed, queued for retry", String((e as Error).message ?? e));
    await d.repo.failOutbox(id, String((e as Error).message ?? e), new Date(d.now().getTime() + 60_000));
  }
}

async function recall(d: Deps, u: User, query: string, limit = 6): Promise<Recalled[]> {
  if (!u.creds) return [];
  try {
    return await d.memoryFor(u.creds).recall(query.slice(0, 500), limit);
  } catch (e) {
    if (e instanceof MemoryAuthError) {
      await d.out.send(u.chatId, "I could not read your memory with the saved key. If you removed it in your Walrus Memory dashboard, run /connect again.");
    } else {
      d.log("recall failed", String((e as Error).message ?? e));
    }
    return [];
  }
}

// Onboarding gate: timezone first (reminders need it), then memory.
async function ready(d: Deps, u: User): Promise<boolean> {
  if (!u.timezone) {
    await askTimezone(d, u, "First, which timezone are you in? Tap one or type your city.");
    return false;
  }
  if (!u.creds) {
    await d.out.send(u.chatId, "Connect your Walrus Memory first so I can remember things for you. Send /connect to start.");
    return false;
  }
  return true;
}

async function askTimezone(d: Deps, u: User, text: string) {
  await setPending(d, u, { kind: "timezone" });
  await d.out.send(u.chatId, text, TZ_BUTTONS);
}

const describeItem = (i: Item, zone: string, now: Date) => {
  const title = esc(i.payload.title);
  if (i.status === "quiet") return `#${i.id} ${title}`;
  if (isTask(i)) return `#${i.id} ${title}, ${i.dueAt ? formatWhen(i.dueAt, zone, now) : "no time set"}`;
  return `#${i.id} ${title}${i.nextAt ? `, next check ${formatWhen(i.nextAt, zone, now)}` : ""}`;
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function handleMessage(d: Deps, m: Incoming) {
  const u = await d.repo.ensureUser(m.userId, m.chatId, m.firstName);
  const text = m.text.trim();
  if (!text) return;

  if (text.startsWith("/")) {
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd!.slice(1).split("@")[0]!.toLowerCase();
    // A command always ends whatever question was pending.
    if (u.pending && cmd !== "connect") await setPending(d, u, null);
    return command(d, u, m, cmd, rest.join(" ").trim());
  }

  // A private key pasted at the wrong moment is still removed from the chat.
  const connecting = u.pending?.kind === "connect_key" || u.pending?.kind === "connect_account";
  const looksSecret = SUI_KEY_RE.test(text) || (HEX_KEY_RE.test(text) && !ACCOUNT_RE.test(text));
  if (looksSecret && !connecting) {
    await d.out.deleteMessage(m.chatId, m.messageId);
    await d.out.send(u.chatId, "That looked like a private key, so I deleted it from the chat. Only send it when /connect asks for it.");
    return;
  }

  if (u.pending) {
    const handled = await pending(d, u, m, text);
    if (handled) return;
  }

  const url = findUrl(text);
  if (url) {
    if (!(await ready(d, u))) return;
    const rest = text.replace(url, "").trim();
    return startSave(d, u, url, rest.length > 200 ? rest : undefined);
  }

  if (!(await ready(d, u))) return;
  return routeText(d, u, text);
}

export async function handleCallback(d: Deps, c: Callback) {
  const u = await d.repo.ensureUser(c.userId, c.chatId, c.firstName);
  const [kind, a, b] = c.data.split(":");
  const removeButtons = () => d.out.removeButtons(c.chatId, c.messageId);

  if (kind === "tz") {
    const zone = c.data.slice(3);
    if (!isValidZone(zone)) return;
    await removeButtons();
    return setTimezone(d, u, zone);
  }
  if (kind === "dg") {
    const n = Number(a);
    if (![1, 2, 3, 7].includes(n)) return;
    await removeButtons();
    await d.repo.updateUser(u.id, { defaultGapDays: n });
    return void (await d.out.send(u.chatId, `Default check-back time set to ${n === 7 ? "1 week" : `${n} day${n > 1 ? "s" : ""}`}.`));
  }
  if (kind === "tt") {
    if (u.pending?.kind !== "task_time") return void (await removeButtons());
    await removeButtons();
    const draft = { ...u.pending.draft, time: c.data.slice(3) };
    return afterWhen(d, u, draft);
  }

  if (kind === "pa" && a === "go") {
    await removeButtons();
    if (u.pending?.kind !== "path") return;
    return startPath(d, u, u.pending.title, u.pending.steps);
  }
  if (kind === "bd" && a === "rm") {
    await removeButtons();
    await d.repo.updateUser(u.id, { buddyId: null });
    return void (await d.out.send(u.chatId, "Buddy removed. Send /buddy to invite someone else."));
  }

  const id = Number(a);
  if (!Number.isSafeInteger(id)) return;
  const item = await d.repo.getItem(id, u.id);
  if (!item) return void (await removeButtons());

  if (kind === "sb") {
    await removeButtons();
    return shareWithBuddy(d, u, item);
  }

  if (kind === "i") {
    if (item.status !== "draft" || !isSave(item)) return void (await removeButtons());
    await removeButtons();
    return saveIntent(d, u, item, b === "y" ? "yes" : b === "m" ? "maybe" : "no");
  }
  if (kind === "g") {
    if (item.status !== "draft" || !isSave(item)) return void (await removeButtons());
    if (b === "o") {
      await removeButtons();
      await setPending(d, u, { kind: "save_gap", itemId: item.id });
      return void (await d.out.send(u.chatId, "When should I check back? Send a time like 5 min, 2 hours, 3 days, 1 week, 6pm or tomorrow 9am."));
    }
    const days = Number(b);
    if (![1, 2, 3, 7].includes(days)) return;
    await removeButtons();
    return finishSave(d, u, item, addDays(d.now(), days), true);
  }
  if (kind === "n" || kind === "t") {
    if (item.status === "done" || item.status === "dropped") {
      await removeButtons();
      return void (await d.out.send(u.chatId, "That one is already closed."));
    }
    await removeButtons();
    if (b === "rs" && isTask(item)) return startReschedule(d, u, item);
    const action = b === "done" ? "done" : b === "part" ? "partial" : b === "drop" ? "drop" : b === "s3" ? "snooze3" : b === "h1" ? "hour" : b === "tm" ? "tomorrow" : null;
    if (!action) return;
    return applyOutcome(d, u, item, action);
  }
  if (kind === "r") {
    if (item.status !== "quiet") return void (await removeButtons());
    await removeButtons();
    const next = isTask(item) ? addDays(d.now(), 1) : addDays(d.now(), followUpDays(item));
    await d.repo.updateItem(item.id, u.id, { status: "open", nextAt: next, nudgeCount: 0 });
    return void (await d.out.send(u.chatId, `Back on the list. I will check in on ${formatWhen(next, zoneOf(u), d.now())}.`));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function command(d: Deps, u: User, m: Incoming, cmd: string, arg: string) {
  const zone = zoneOf(u);
  const now = d.now();
  switch (cmd) {
    case "start": {
      if (arg.startsWith("buddy_")) return acceptBuddy(d, u, arg.slice(6));
      const hi = u.firstName ? `Hi ${esc(u.firstName)}. ` : "";
      await d.out.send(u.chatId, `${hi}I am OctoKeep. Send me a link and I will summarise it, remember it, and check back until you act on it. Tell me something you want to do and when, and I will remind you with a plan.`);
      if (!u.timezone) return askTimezone(d, u, "First, which timezone are you in? Tap one or type your city.");
      if (!u.creds) return startConnect(d, u);
      return void (await d.out.send(u.chatId, "You are all set. Send a link or a task. /help lists everything."));
    }
    case "help":
      return void (await d.out.send(u.chatId, HELP));
    case "buddy":
      return buddyCommand(d, u);
    case "path":
      if (!(await ready(d, u))) return;
      return learningPath(d, u, arg);
    case "topics":
      if (!(await ready(d, u))) return;
      return topics(d, u);
    case "cancel":
      return void (await d.out.send(u.chatId, "Okay, stopped."));
    case "timezone":
      return askTimezone(d, u, `Your timezone is ${esc(u.timezone ?? "not set")}. Tap one or type your city to change it.`);
    case "connect": {
      if (arg === "env" && d.adminIds.has(u.id) && d.envCreds) {
        await setPending(d, u, null);
        return verifyAndSave(d, u, d.envCreds);
      }
      if (arg) {
        // Credentials typed after the command: delete them from the chat.
        await d.out.deleteMessage(m.chatId, m.messageId);
        return connectInput(d, u, arg);
      }
      return startConnect(d, u);
    }
    case "disconnect":
      if (!u.creds) return void (await d.out.send(u.chatId, "No memory account is connected."));
      await d.repo.updateUser(u.id, { creds: null });
      return void (await d.out.send(u.chatId, "Removed the saved key. Your memories stay in your Walrus Memory account. You can also delete the OctoKeep key in your dashboard."));
    case "gap": {
      if (!arg) return void (await d.out.send(u.chatId, `I check back after ${u.defaultGapDays} day${u.defaultGapDays > 1 ? "s" : ""} by default. Pick a new default or send /gap 5.`, defaultGapButtons));
      const n = parseGap(arg);
      if (!n) return void (await d.out.send(u.chatId, "Send a number of days from 1 to 60, like /gap 3 or /gap 2w."));
      await d.repo.updateUser(u.id, { defaultGapDays: n });
      return void (await d.out.send(u.chatId, `Default check-back time set to ${n} day${n > 1 ? "s" : ""}.`));
    }
    case "list": {
      const items = await d.repo.listItems(u.id, ["open"]);
      if (!items.length) return void (await d.out.send(u.chatId, "Nothing open. Send a link or a task."));
      const saves = items.filter(isSave).map((i) => describeItem(i, zone, now));
      const tasks = items.filter(isTask).map((i) => describeItem(i, zone, now));
      const parts = [saves.length ? `<b>Saved posts</b>\n${saves.join("\n")}` : "", tasks.length ? `<b>Tasks</b>\n${tasks.join("\n")}` : ""].filter(Boolean);
      return void (await d.out.send(u.chatId, clip(`${parts.join("\n\n")}\n\nMark one done with /done and its number.`)));
    }
    case "memory": {
      const [local, open, quiet] = await Promise.all([d.repo.memoryCount(u.id), d.repo.listItems(u.id, ["open"]), d.repo.listItems(u.id, ["quiet"])]);
      // Ask Walrus Memory itself; fall back to OctoKeep's own count.
      let count = local;
      if (u.creds) {
        try {
          count = await d.memoryFor(u.creds).count();
        } catch (e) {
          d.log("memory count failed", String((e as Error).message ?? e));
        }
      }
      const lines = [
        `<b>Your memory</b>`,
        `${count} memor${count === 1 ? "y" : "ies"} stored in your Walrus Memory account (namespace octokeep).`,
        `${open.length} open item${open.length === 1 ? "" : "s"}, ${quiet.length} gone quiet.`,
        u.creds ? `Account ${esc(u.creds.accountId.slice(0, 10))}…${esc(u.creds.accountId.slice(-4))}` : "No account connected. Send /connect.",
        "",
        'Ask me anything about it, like "what did I save about Rust?"',
      ];
      return void (await d.out.send(u.chatId, lines.join("\n")));
    }
    case "tasks": {
      const tasks = await d.repo.listItems(u.id, ["open"], "task");
      if (!tasks.length) return void (await d.out.send(u.chatId, "No upcoming tasks. Tell me something you want to do and when."));
      return void (await d.out.send(u.chatId, clip(`<b>Upcoming tasks</b>\n${tasks.map((i) => describeItem(i, zone, now)).join("\n")}`)));
    }
    case "ignored": {
      const quiet = await d.repo.listItems(u.id, ["quiet"]);
      if (!quiet.length) return void (await d.out.send(u.chatId, "Nothing ignored. Good."));
      await d.out.send(u.chatId, `<b>Things you have not acted on</b>\nI stopped asking about these. Bring one back to get reminders again.`);
      for (const i of quiet.slice(0, 10)) await d.out.send(u.chatId, describeItem(i, zone, now), [[{ text: "Bring back", data: `r:${i.id}:x` }, { text: "Done", data: `n:${i.id}:done` }, { text: "Drop", data: `n:${i.id}:drop` }]]);
      return;
    }
    case "done": {
      const id = Number(arg.replace(/^#/, ""));
      if (!Number.isSafeInteger(id) || id <= 0) return void (await d.out.send(u.chatId, "Send the item number, like /done 12. /list shows the numbers."));
      const item = await d.repo.getItem(id, u.id);
      if (!item || item.status === "done" || item.status === "dropped" || item.status === "draft") return void (await d.out.send(u.chatId, `I could not find an open item #${id}.`));
      return applyOutcome(d, u, item, "done");
    }
    case "jump": {
      // Demo helper: runs the scheduler as if time had moved forward.
      if (!d.adminIds.has(u.id)) return void (await d.out.send(u.chatId, "Unknown command. /help lists what I can do."));
      // "/jump 2d", "/jump 3", "/jump 10m", "/jump 2h"
      const at = parseCheckBack(arg || "2", now, zone) ?? addDays(now, 2);
      const { runTick } = await import("../tick.js");
      const r = await runTick(d, { now: at, userId: u.id });
      return void (await d.out.send(u.chatId, `Ran the scheduler ${formatIn(at.getTime() - now.getTime())} ahead: ${r.nudged} reminder${r.nudged === 1 ? "" : "s"} sent.`));
    }
    default:
      return void (await d.out.send(u.chatId, "Unknown command. /help lists what I can do."));
  }
}

// ---------------------------------------------------------------------------
// Pending answers
// ---------------------------------------------------------------------------

// Returns false when the message is not an answer to the pending question,
// so it is handled as a new message.
async function pending(d: Deps, u: User, m: Incoming, text: string): Promise<boolean> {
  const p = u.pending!;
  const url = findUrl(text);

  switch (p.kind) {
    case "timezone": {
      const zone = resolveZone(text);
      if (!zone) {
        await d.out.send(u.chatId, "I did not recognise that. Try a city like Lagos or London, or an offset like UTC+1.");
        return true;
      }
      await setTimezone(d, u, zone);
      return true;
    }
    case "connect_account":
    case "connect_key":
      return connectInput(d, u, text, m).then(() => true);
    case "save_intent": {
      if (url) break;
      const item = await d.repo.getItem(p.itemId, u.id);
      if (!item || item.status !== "draft" || !isSave(item)) break;
      const t = text.toLowerCase();
      const choice = /^(no|nope|nah|not really)\b/.test(t) ? "no" : /^(maybe|later|not now)\b/.test(t) ? "maybe" : "yes";
      await saveIntent(d, u, item, choice, choice === "yes" && !/^(yes|yeah|yep|sure|ok|okay)\.?$/i.test(text) ? text : undefined);
      return true;
    }
    case "save_gap": {
      if (url) break;
      const item = await d.repo.getItem(p.itemId, u.id);
      if (!item || item.status !== "draft" || !isSave(item)) break;
      const at = parseCheckBack(text, d.now(), zoneOf(u));
      if (!at) {
        await d.out.send(u.chatId, "I could not read that. Send a time like 5 min, 2 hours, 3 days, 1 week or 6pm (up to 60 days), or tap a button.", gapButtons(item.id));
        return true;
      }
      await finishSave(d, u, item, at);
      return true;
    }
    case "paste_for": {
      if (url) break;
      if (text.length < 20) {
        await d.out.send(u.chatId, "That is a bit short to summarise. Paste the caption or the post text, or /cancel.");
        return true;
      }
      await setPending(d, u, null);
      await startSave(d, u, p.url, text);
      return true;
    }
    case "task_when": {
      if (url) break;
      const draft = { ...p.draft };
      const tz = zoneOf(u);
      const timeOnly = parseTimeOfDay(text);
      if (timeOnly && draft.date) return afterWhen(d, u, { ...draft, time: timeOnly }).then(() => true);
      try {
        const w = await ask(d, "when", WhenSchema, whenPrompt(text, localNow(d.now(), tz), calendarContext(d.now(), tz)));
        if (isIsoDate(w.date)) draft.date = w.date;
        const t = w.time ? parseTimeOfDay(w.time) : null;
        if (t) draft.time = t;
      } catch (e) {
        d.log("when parse failed", String(e));
      }
      if (!draft.date) {
        await d.out.send(u.chatId, "I could not tell the day. Try something like Thursday 9am, tomorrow evening or 12 Oct.");
        return true;
      }
      if (!draft.time) {
        await setPending(d, u, { kind: "task_time", draft });
        await d.out.send(u.chatId, `${formatDay(draft.date, tz)}. What time?`, timeButtons);
        return true;
      }
      await afterWhen(d, u, draft);
      return true;
    }
    case "task_time": {
      if (url) break;
      const t = parseTimeOfDay(text);
      if (t) {
        await afterWhen(d, u, { ...p.draft, time: t });
        return true;
      }
      // Maybe they changed the day too ("Friday 10am").
      await setPending(d, u, { kind: "task_when", draft: { ...p.draft, date: undefined, time: undefined } });
      return pending(d, u, m, text);
    }
    case "task_question": {
      if (url) break;
      const draft = { ...p.draft, details: [...p.draft.details] };
      if (/^(skip|no|none|nothing|n\/a)\.?$/i.test(text)) return finishTask(d, u, draft).then(() => true);
      draft.details.push({ question: draft.questions[p.index]!, answer: text.slice(0, 500) });
      const next = p.index + 1;
      if (next < draft.questions.length) {
        await setPending(d, u, { kind: "task_question", draft, index: next });
        await d.out.send(u.chatId, esc(draft.questions[next]!));
        return true;
      }
      await finishTask(d, u, draft);
      return true;
    }
    case "nudge_reply": {
      if (url) break;
      const item = await d.repo.getItem(p.itemId, u.id);
      if (!item || item.status === "done" || item.status === "dropped") break;
      try {
        const intent = isSave(item) ? item.payload.intent : undefined;
        const o = await ask(d, "outcome", OutcomeSchema, outcomePrompt(item.payload.title, intent, text));
        if (o.result === "unclear") break;
        const action = o.result === "done" ? "done" : o.result === "partial" ? "partial" : o.result === "drop" ? "drop" : "snooze";
        await applyOutcome(d, u, item, action, { note: o.note ?? undefined, snoozeDays: o.snoozeDays ?? (o.result === "not_yet" ? followUpDays(item) : 3) });
        return true;
      } catch (e) {
        d.log("outcome parse failed", String(e));
        break;
      }
    }
    case "gap_custom":
      break;
  }
  // Not an answer: drop the question and treat the message as new.
  await setPending(d, u, null);
  return false;
}

// ---------------------------------------------------------------------------
// Timezone and connect
// ---------------------------------------------------------------------------

async function setTimezone(d: Deps, u: User, zone: string) {
  const first = !u.timezone;
  u.timezone = zone;
  await d.repo.updateUser(u.id, { timezone: zone, pending: null });
  u.pending = null;
  await d.out.send(u.chatId, `Timezone set to ${esc(zone)}. It is ${formatWhen(d.now(), zone)} there now.`);
  if (first && !u.creds) await startConnect(d, u);
}

async function startConnect(d: Deps, u: User) {
  await setPending(d, u, { kind: "connect_account" });
  await d.out.send(u.chatId, CONNECT_STEPS);
}

async function connectInput(d: Deps, u: User, text: string, m?: Incoming) {
  const account = text.match(ACCOUNT_RE)?.[0];
  const p = u.pending;
  const withoutAccount = account ? text.replace(account, " ") : text;
  const key = withoutAccount.match(SUI_KEY_RE)?.[0] ?? withoutAccount.match(HEX_KEY_RE)?.[0];

  // Anything that may contain a key is removed from the chat.
  if (m && (key || p?.kind === "connect_key")) await d.out.deleteMessage(m.chatId, m.messageId);

  if (account && key) return verifyAndSave(d, u, { accountId: account, key });

  if (p?.kind === "connect_key") {
    const k = account ?? key;
    if (!k) {
      await d.out.send(u.chatId, "That is not a delegate private key. It is 64 hex characters, or starts with suiprivkey. Send it again, or /cancel.");
      return;
    }
    return verifyAndSave(d, u, { accountId: p.accountId, key: k });
  }

  if (account) {
    await setPending(d, u, { kind: "connect_key", accountId: account });
    await d.out.send(
      u.chatId,
      "Got the Account ID. Now send the delegate private key for the OctoKeep key (SDK credentials, Delegate private key). I delete your message as soon as I read it and store the key encrypted. You can revoke it any time in your dashboard.",
    );
    return;
  }
  if (key) {
    await d.out.send(u.chatId, "That looks like the private key. I deleted it. Send the Account ID first; it starts with 0x and is 66 characters long.");
    return;
  }
  await d.out.send(u.chatId, "I need the Account ID from SDK credentials. It starts with 0x. Send it, or /cancel.");
}

async function verifyAndSave(d: Deps, u: User, creds: MemwalCreds) {
  await d.out.typing(u.chatId);
  try {
    await d.memoryFor(creds).verify();
  } catch (e) {
    if (e instanceof MemoryAuthError) {
      await setPending(d, u, { kind: "connect_account" });
      await d.out.send(u.chatId, "Walrus Memory did not accept that key for this account. Check that the key belongs to the same account and has not been removed, then send the Account ID again.");
    } else {
      d.log("verify failed", String((e as Error).message ?? e));
      await d.out.send(u.chatId, "I could not reach Walrus Memory just now. Try /connect again in a minute.");
      await setPending(d, u, null);
    }
    return;
  }
  u.creds = creds;
  await d.repo.updateUser(u.id, { creds, pending: null });
  u.pending = null;
  await d.out.send(u.chatId, "Connected. Your memories live in your own Walrus Memory account.\n\nSend me a link, or tell me something you want to do and when.");
}

// ---------------------------------------------------------------------------
// Saved posts
// ---------------------------------------------------------------------------

// What to send when a link cannot be read, depending on what this bot can take.
function sendInstead(d: Deps): string {
  const options = [
    d.media.readImage ? 'a screenshot of the post (tap "more" first so the whole caption shows)' : "",
    d.media.transcribe ? "a screen recording if it is a video" : "",
    "the caption pasted as text",
  ].filter(Boolean);
  const list = options.length > 1 ? `${options.slice(0, -1).join(", ")}, or ${options.at(-1)}` : options[0];
  return `Send me ${list}, and I will summarise it.`;
}

async function startSave(d: Deps, u: User, url: string | undefined, pastedText?: string, label = "Pasted text") {
  await d.out.typing(u.chatId);
  let content: Content;
  if (pastedText) {
    let source = label;
    if (url) {
      try {
        source = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        // Keep the generic label.
      }
    }
    content = { title: label, text: pastedText, source, url };
  } else {
    const r = await d.fetchContent(url!);
    if (!r.ok) {
      await setPending(d, u, { kind: "paste_for", url: url! });
      const msg =
        r.reason === "paste"
          ? `I cannot read ${esc(r.source)} posts directly${r.title ? ` ("${esc(r.title)}")` : ""}. ${sendInstead(d)}`
          : `I could not open that link. ${sendInstead(d)}`;
      await d.out.send(u.chatId, msg);
      return;
    }
    content = r.content;
  }

  const memories = await recall(d, u, `${content.title}. ${content.text.slice(0, 300)}`, 5);
  let s;
  try {
    s = await ask(d, "summary", SummarySchema, summaryPrompt(content, memories));
  } catch (e) {
    d.log("summary failed", String(e));
    await d.out.send(u.chatId, "I could not summarise that right now. Try again in a minute.");
    return;
  }

  const earlier = await earlierSave(d, u, content.url, memories);
  const payload: SavePayload = { title: s.title, url: content.url, source: content.source, summary: s.summary, actions: s.actions };
  const item = await d.repo.createItem({ userId: u.id, kind: "save", status: "draft", payload, gapDays: u.defaultGapDays });

  const actions = s.actions.map((a, i) => `${i + 1}. ${esc(a.text)} ${effortLabel(a)}`).join("\n");
  const msg = [
    `<b>${esc(s.title)}</b>`,
    `<i>${esc(content.source)}</i>`,
    "",
    esc(s.summary),
    "",
    "<b>Actions</b>",
    actions,
    earlier ? `\n<b>You have been here before</b>\n${esc(earlier)}` : s.connection ? `\n${esc(s.connection)}` : "",
    "",
    "Do you want to act on this?",
  ].join("\n");
  await setPending(d, u, { kind: "save_intent", itemId: item.id });
  await d.out.send(u.chatId, clip(msg.replace(/\n{3,}/g, "\n\n")), intentButtons(item.id));
}

async function saveIntent(d: Deps, u: User, item: Item & { payload: SavePayload }, choice: "yes" | "maybe" | "no", words?: string) {
  if (choice === "no") {
    const payload = { ...item.payload, intent: "not planning to act on it" };
    await d.repo.updateItem(item.id, u.id, { status: "dropped", payload, nextAt: null });
    await setPending(d, u, null);
    await d.out.send(u.chatId, "Kept the summary in your memory. No reminder.");
    await remember(d, u, memoryLine.save({ ...payload, actions: payload.actions.map((a) => a.text), intent: payload.intent, when: "no reminder" }));
    return;
  }
  if (choice === "maybe") {
    const payload = { ...item.payload, intent: "maybe later" };
    await d.repo.updateItem(item.id, u.id, { payload });
    return finishSave(d, u, { ...item, payload }, addDays(d.now(), u.defaultGapDays), true);
  }
  const payload = { ...item.payload, intent: words ? words.slice(0, 300) : "plans to act on it" };
  await d.repo.updateItem(item.id, u.id, { payload });
  await setPending(d, u, { kind: "save_gap", itemId: item.id });
  await d.out.send(u.chatId, `When should I check back? Your default is ${u.defaultGapDays} day${u.defaultGapDays > 1 ? "s" : ""}.`, gapButtons(item.id));
}

// `adapt` moves a whole-day check-back to the hour the user usually replies.
async function finishSave(d: Deps, u: User, item: Item & { payload: SavePayload }, chosen: Date, adapt = false) {
  const now = d.now();
  const adapted = adapt ? usualHour(u, chosen, now) : null;
  const next = adapted ?? chosen;
  const days = (next.getTime() - now.getTime()) / DAY_MS;
  const fresh = (await d.repo.getItem(item.id, u.id)) ?? item;
  const payload = { ...(fresh.payload as SavePayload), intent: (fresh.payload as SavePayload).intent ?? "plans to act on it" };
  await d.repo.updateItem(item.id, u.id, { status: "open", gapDays: days, nextAt: next, nudgeCount: 0, payload });
  await setPending(d, u, null);
  const soon = days < 1 ? ` (in ${formatIn(next.getTime() - now.getTime())})` : adapted ? " (around when you usually reply)" : "";
  await d.out.send(u.chatId, `Saved. I will check in on ${formatWhen(next, zoneOf(u), now)}${soon}.`, confirmButtons(u, item.id));
  await remember(
    d,
    u,
    memoryLine.save({ title: payload.title, url: payload.url, summary: payload.summary, actions: payload.actions.map((a) => a.text), intent: payload.intent!, when: formatDate(next, zoneOf(u)) }),
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function routeText(d: Deps, u: User, text: string) {
  const tz = zoneOf(u);
  let route;
  try {
    route = await ask(d, "route", RouteSchema, routePrompt(text, localNow(d.now(), tz), calendarContext(d.now(), tz)));
  } catch (e) {
    d.log("route failed", String(e));
    await d.out.send(u.chatId, "I did not catch that. Send a link, or tell me something you want to do and when.");
    return;
  }

  if (route.type === "task") {
    const draft: TaskDraft = {
      title: (route.title ?? text).slice(0, 140),
      raw: text.slice(0, 1000),
      date: isIsoDate(route.date) ? route.date : undefined,
      time: route.time ? parseTimeOfDay(route.time) ?? undefined : undefined,
      questions: [],
      details: [],
    };
    await startTask(d, u, draft);
  } else if (route.type === "question") {
    await answerQuestion(d, u, text);
  } else if (route.type === "content" && text.length >= 200) {
    await startSave(d, u, undefined, text);
  } else {
    let reply = "Send me a link to summarise, or tell me something you want to do and when.";
    try {
      reply = await say(d, "chat", chatPrompt(text));
    } catch (e) {
      d.log("chat failed", String(e));
    }
    await d.out.send(u.chatId, clip(esc(reply)));
  }

  // Lasting facts ("I'm learning Rust") are handed to the relayer's own
  // extractor, which stores each fact as its own memory.
  if (route.hasPersonalFacts && u.creds) {
    try {
      const facts = await d.memoryFor(u.creds).learn(text, d.now());
      if (facts > 0) await d.repo.addMemoryCount(u.id, facts);
    } catch (e) {
      d.log("learn failed", String((e as Error).message ?? e));
    }
  }
}

async function startTask(d: Deps, u: User, draft: TaskDraft) {
  const tz = zoneOf(u);
  if (!draft.date) {
    await setPending(d, u, { kind: "task_when", draft });
    await d.out.send(u.chatId, `${esc(draft.title)}. When should I remind you? For example Thursday 9am, tomorrow evening or 12 Oct.`);
    return;
  }
  if (!draft.time) {
    await setPending(d, u, { kind: "task_time", draft });
    await d.out.send(u.chatId, `${formatDay(draft.date, tz)}. What time?`, timeButtons);
    return;
  }
  return afterWhen(d, u, draft);
}

async function afterWhen(d: Deps, u: User, draft: TaskDraft) {
  const tz = zoneOf(u);
  const now = d.now();
  const at = draft.date && draft.time ? toInstant(draft.date, draft.time, tz) : null;
  if (!at || at.getTime() < now.getTime() + 60_000) {
    await setPending(d, u, { kind: "task_when", draft: { ...draft, date: undefined, time: undefined } });
    await d.out.send(u.chatId, at ? `${formatWhen(at, tz, now)} has already passed. When should I remind you?` : "When should I remind you?");
    return;
  }

  if (draft.rescheduleItemId) {
    await d.repo.updateItem(draft.rescheduleItemId, u.id, { status: "open", dueAt: at, nextAt: at, nudgeCount: 0 });
    await setPending(d, u, null);
    await d.out.send(u.chatId, `Moved to ${formatWhen(at, tz, now)}.`);
    return;
  }

  let questions: string[] = [];
  try {
    questions = (await ask(d, "questions", QuestionsSchema, questionsPrompt(draft.title, draft.raw))).questions.slice(0, 3);
  } catch (e) {
    d.log("questions failed", String(e));
  }
  const next = { ...draft, questions };
  if (!questions.length) return finishTask(d, u, next);
  await setPending(d, u, { kind: "task_question", draft: next, index: 0 });
  await d.out.send(u.chatId, `${formatWhen(at, tz, now)}. A few quick questions so the reminder is useful. Reply skip to stop.\n\n${esc(questions[0]!)}`);
}

async function finishTask(d: Deps, u: User, draft: TaskDraft) {
  const tz = zoneOf(u);
  const now = d.now();
  const at = toInstant(draft.date!, draft.time!, tz)!;
  await d.out.typing(u.chatId);
  const memories = await recall(d, u, `${draft.title}. ${draft.details.map((x) => x.answer).join(". ")}`, 5);
  let plan: string[] = [];
  try {
    plan = (await ask(d, "plan", PlanSchema, planPrompt(draft.title, draft.details, memories))).plan;
  } catch (e) {
    d.log("plan failed", String(e));
  }
  const payload: TaskPayload = { title: draft.title, raw: draft.raw, details: draft.details, plan };
  const created = await d.repo.createItem({ userId: u.id, kind: "task", status: "open", payload, gapDays: 1, dueAt: at, nextAt: at });
  await setPending(d, u, null);
  await d.out.send(u.chatId, `Got it. ${formatWhen(at, tz, now)}. I will send your plan then.`, confirmButtons(u, created.id));
  await remember(
    d,
    u,
    memoryLine.task({ title: draft.title, when: formatWhen(at, tz), details: draft.details.map((x) => `${x.question} ${x.answer}`), plan }),
  );
}

async function startReschedule(d: Deps, u: User, item: Item & { payload: TaskPayload }) {
  const draft: TaskDraft = { title: item.payload.title, raw: item.payload.raw, questions: [], details: item.payload.details, rescheduleItemId: item.id };
  await setPending(d, u, { kind: "task_when", draft });
  await d.out.send(u.chatId, `When should I move "${esc(item.payload.title)}" to?`);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

type OutcomeAction = "done" | "partial" | "drop" | "snooze" | "snooze3" | "hour" | "tomorrow";

async function applyOutcome(d: Deps, u: User, item: Item, action: OutcomeAction, extra: { note?: string; snoozeDays?: number } = {}) {
  const now = d.now();
  const tz = zoneOf(u);
  if (u.pending?.kind === "nudge_reply" && u.pending.itemId === item.id) await setPending(d, u, null);
  await noteReplyHour(d, u, now);
  const record = (result: string) =>
    remember(d, u, memoryLine.outcome({ title: item.payload.title, kind: item.kind === "task" ? "task" : "saved post", result, note: extra.note, date: formatDate(now, tz) }));

  switch (action) {
    case "done":
      await d.repo.updateItem(item.id, u.id, { status: "done", nextAt: null });
      await d.out.send(u.chatId, `Marked "${esc(item.payload.title)}" done. Nice work.`);
      if (item.payload.shared) await tellBuddy(d, u, `${esc(nameOf(u))} finished <b>${esc(item.payload.title)}</b>.`);
      return record("done");
    case "partial": {
      const next = usualHour(u, addDays(now, followUpDays(item)), now) ?? addDays(now, followUpDays(item));
      await d.repo.updateItem(item.id, u.id, { status: "open", nextAt: next, nudgeCount: 0 });
      await d.out.send(u.chatId, `Good progress. I will check on the rest on ${formatWhen(next, tz, now)}.`);
      return record("partly done");
    }
    case "drop":
      await d.repo.updateItem(item.id, u.id, { status: "dropped", nextAt: null });
      await d.out.send(u.chatId, "Dropped. It stays in your memory in case you want it later.");
      return record("dropped, no longer planning to do it");
    case "snooze":
    case "snooze3": {
      const days = action === "snooze3" ? 3 : Math.min(Math.max(extra.snoozeDays ?? 3, 1), 60);
      const next = usualHour(u, addDays(now, days), now) ?? addDays(now, days);
      await d.repo.updateItem(item.id, u.id, { status: "open", nextAt: next, nudgeCount: 0 });
      await d.out.send(u.chatId, `Okay. Back on ${formatWhen(next, tz, now)}.`);
      if (extra.note) await record(`not yet, snoozed ${days} days`);
      return;
    }
    case "hour": {
      const next = addHours(now, 1);
      await d.repo.updateItem(item.id, u.id, { status: "open", nextAt: next, nudgeCount: 0 });
      return void (await d.out.send(u.chatId, `Okay. I will remind you at ${formatWhen(next, tz, now)}.`));
    }
    case "tomorrow": {
      const time = item.dueAt ? localTime(item.dueAt, tz) : "09:00";
      const next = tomorrowAt(now, tz, time);
      await d.repo.updateItem(item.id, u.id, { status: "open", nextAt: next, dueAt: next, nudgeCount: 0 });
      return void (await d.out.send(u.chatId, `Moved to ${formatWhen(next, tz, now)}.`));
    }
  }
}

// ---------------------------------------------------------------------------
// Memory questions
// ---------------------------------------------------------------------------

async function answerQuestion(d: Deps, u: User, question: string) {
  await d.out.typing(u.chatId);
  const tz = zoneOf(u);
  const now = d.now();
  const memories = await recall(d, u, question, 8);
  const items = await d.repo.listItems(u.id, ["open", "quiet"]);
  const lines = items.slice(0, 25).map((i) => `${i.status === "quiet" ? "IGNORED" : "OPEN"} ${i.kind}: ${i.payload.title}${isTask(i) && i.dueAt ? ` (due ${formatWhen(i.dueAt, tz, now)})` : ""}`);
  let reply: string;
  try {
    reply = await say(d, "answer", answerPrompt(question, memories, lines, localNow(now, tz)));
  } catch (e) {
    d.log("answer failed", String(e));
    reply = memories.length ? `Here is what I found:\n${memories.slice(0, 5).map((m) => `- ${m.text}`).join("\n")}` : "I could not find anything about that in your memory.";
  }
  await d.out.send(u.chatId, clip(esc(reply)));
}

// ---------------------------------------------------------------------------
// Nudges, called by the scheduler
// ---------------------------------------------------------------------------

const daysAgo = (from: Date, now: Date) => {
  const days = Math.round((now.getTime() - from.getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

export async function sendNudge(d: Deps, u: User, item: Item, now: Date): Promise<void> {
  const tz = zoneOf(u);
  if (isSave(item)) {
    const p = item.payload;
    let line = "";
    const memories = await recall(d, u, `What happened with things like: ${p.title}. Outcomes, goals, what I skipped.`, 5);
    const useful = memories.filter((m) => !m.text.includes(p.title));
    if (useful.length) {
      try {
        const t = await say(d, "nudge", nudgeLinePrompt(p.title, p.intent, useful));
        if (t && !/^none\b/i.test(t)) line = t.split("\n")[0]!.slice(0, 200);
      } catch (e) {
        d.log("nudge line failed", String(e));
      }
    }
    const first = p.actions[0];
    const msg = [
      `You saved <b>${esc(p.title)}</b> ${daysAgo(item.createdAt, now)}.`,
      p.intent && p.intent !== "plans to act on it" ? `You said: ${esc(p.intent)}` : "",
      first ? `First step: ${esc(first.text)}` : "",
      line ? `\n${esc(line)}` : "",
      "\nDid you do it?",
    ]
      .filter(Boolean)
      .join("\n");
    await d.out.send(u.chatId, clip(msg), nudgeButtons(item.id));
  } else if (isTask(item)) {
    const p = item.payload;
    if (item.nudgeCount === 0) {
      const memories = await recall(d, u, `${p.title}. ${p.details.map((x) => x.answer).join(". ")}`, 6);
      const related = memories.filter((m) => m.text.startsWith("[SAVE]")).slice(0, 2).map((m) => `- ${esc(m.text.replace(/^\[SAVE\]\s*/, "").split(" | ")[0]!)}`);
      const msg = [
        `<b>Today: ${esc(p.title)}</b>`,
        p.details.length ? `\n<b>Details</b>\n${p.details.map((x) => `- ${esc(x.answer)}`).join("\n")}` : "",
        p.plan.length ? `\n<b>Plan</b>\n${p.plan.map((s, i) => `${i + 1}. ${esc(s)}`).join("\n")}` : "",
        related.length ? `\n<b>From your saves</b>\n${related.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await d.out.send(u.chatId, clip(msg), taskButtons(item.id));
    } else {
      await d.out.send(u.chatId, `Yesterday's task: <b>${esc(p.title)}</b>. Did you get to it?`, taskButtons(item.id));
    }
  }
  const next = afterNudge(item, now);
  if (isSave(item) && next.nextAt) next.nextAt = usualHour(u, next.nextAt, now) ?? next.nextAt;
  await d.repo.updateItem(item.id, u.id, { status: next.status, nextAt: next.nextAt, nudgeCount: next.nudgeCount, lastNudgedAt: now });
  // A reminder went unanswered: a shared goal gets one message to the buddy.
  const shared = item.payload;
  if (shared.shared && !shared.buddyNotified && item.nudgeCount >= 1) {
    const told = await tellBuddy(d, u, `${esc(nameOf(u))} planned to do <b>${esc(shared.title)}</b> and has not answered my last reminder. A quick nudge from you might help.`);
    if (told) await d.repo.updateItem(item.id, u.id, { payload: { ...shared, buddyNotified: true } });
  }
  if (!u.pending) await setPending(d, u, { kind: "nudge_reply", itemId: item.id });
  if (next.status === "quiet") {
    await remember(d, u, memoryLine.outcome({ title: item.payload.title, kind: item.kind === "task" ? "task" : "saved post", result: "reminded several times without a reply, moved to ignored", date: formatDate(now, tz) }));
  }
}

// ---------------------------------------------------------------------------
// Earlier saves
// ---------------------------------------------------------------------------

// Recall distance under which a saved post counts as "the same kind of thing".
export const SIMILAR_DISTANCE = 0.45;

const statusLine = (i: Item, zone: string, now: Date) => {
  if (i.status === "done") return "You finished that one.";
  if (i.status === "dropped") return "You decided not to act on it.";
  if (i.status === "quiet") return "You did not answer my reminders for it.";
  return i.nextAt ? `It is still open. I check in on ${formatWhen(i.nextAt, zone, now)}.` : "It is still open.";
};

// The same link saved before, or a similar save found in Walrus Memory, with
// what happened to it. Null when there is nothing worth mentioning.
async function earlierSave(d: Deps, u: User, url: string | undefined, memories: Recalled[]): Promise<string | null> {
  const zone = zoneOf(u);
  const now = d.now();
  const saves = await d.repo.listItems(u.id, ["open", "quiet", "done", "dropped"], "save");
  const same = url ? saves.find((i) => (i.payload as SavePayload).url === url) : undefined;
  if (same) return `You already saved this on ${formatDate(same.createdAt, zone)} as "${same.payload.title}". ${statusLine(same, zone, now)}`;

  const close = memories.filter((m) => m.text.startsWith("[SAVE]") && m.distance <= SIMILAR_DISTANCE).sort((a, b) => a.distance - b.distance)[0];
  if (!close) return null;
  const title = close.text.replace(/^\[SAVE\]\s*/, "").split(" | ")[0]!.trim();
  if (!title) return null;
  const match = saves.find((i) => i.payload.title.trim().toLowerCase() === title.toLowerCase());
  const when = match ? match.createdAt : close.createdAt ? new Date(close.createdAt) : null;
  const on = when && !Number.isNaN(when.getTime()) ? ` on ${formatDate(when, zone)}` : "";
  return `You saved something similar${on}: "${title}". ${match ? statusLine(match, zone, now) : ""}`.trim();
}

// ---------------------------------------------------------------------------
// Reminders at the hour the user usually replies
// ---------------------------------------------------------------------------

// Replies needed before reminders move to the user's usual hour.
export const MIN_REPLIES_FOR_HABIT = 3;

async function noteReplyHour(d: Deps, u: User, now: Date) {
  const hours = u.activeHours?.length === 24 ? [...u.activeHours] : Array<number>(24).fill(0);
  hours[localHour(now, zoneOf(u))]! += 1;
  u.activeHours = hours;
  await d.repo.updateUser(u.id, { activeHours: hours });
}

// The hour the user answers reminders most often, once there is enough data.
export function preferredHour(hours: number[] | null): number | null {
  if (!hours || hours.length !== 24) return null;
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < MIN_REPLIES_FOR_HABIT) return null;
  let best = 0;
  for (let h = 1; h < 24; h++) if (hours[h]! > hours[best]!) best = h;
  return best;
}

// `when` moved to the user's usual hour on the same local day (or the next
// day if that hour has already passed). Null when there is no habit yet or
// nothing changes.
function usualHour(u: User, when: Date, now: Date): Date | null {
  const h = preferredHour(u.activeHours);
  if (h === null) return null;
  let at = atLocalHour(when, zoneOf(u), h);
  if (at.getTime() < now.getTime() + 30 * 60_000) at = addDays(at, 1);
  return Math.abs(at.getTime() - when.getTime()) < 60_000 ? null : at;
}

// ---------------------------------------------------------------------------
// Learning paths and topics
// ---------------------------------------------------------------------------

const saveTitle = (line: string) => line.replace(/^\[SAVE\]\s*/, "").split(" | ")[0]!.trim();

async function learningPath(d: Deps, u: User, topic: string) {
  if (!topic) return void (await d.out.send(u.chatId, "Send /path and a topic, like /path video editing."));
  await d.out.typing(u.chatId);
  const memories = await recall(d, u, `Saved posts about ${topic}`, 15);
  const saves = [...new Set(memories.filter((m) => m.text.startsWith("[SAVE]")).map((m) => saveTitle(m.text)).filter(Boolean))];
  if (saves.length < 2) {
    await d.out.send(u.chatId, `I found ${saves.length ? "one saved post" : "no saved posts"} about ${esc(topic)}. Save at least two, then try again.`);
    return;
  }
  let p;
  try {
    p = await ask(d, "path", PathSchema, pathPrompt(topic, saves));
  } catch (e) {
    d.log("path failed", String(e));
    await d.out.send(u.chatId, "I could not build the path right now. Try again in a minute.");
    return;
  }
  const steps = p.steps.map((s) => s.text);
  const lines = p.steps.map((s, i) => `${i + 1}. ${esc(s.text)}${s.from && saves.includes(s.from) ? `\n   <i>from "${esc(s.from)}"</i>` : ""}`);
  await setPending(d, u, { kind: "path", title: p.title, steps });
  await d.out.send(
    u.chatId,
    clip([`<b>${esc(p.title)}</b>`, `Built from ${saves.length} of your saves.`, "", ...lines].join("\n")),
    [[{ text: "Start tomorrow at 09:00", data: "pa:go" }]],
  );
}

async function startPath(d: Deps, u: User, title: string, steps: string[]) {
  const tz = zoneOf(u);
  const now = d.now();
  const at = tomorrowAt(now, tz, "09:00");
  const payload: TaskPayload = { title, raw: `/path ${title}`, details: [], plan: steps };
  const created = await d.repo.createItem({ userId: u.id, kind: "task", status: "open", payload, gapDays: 1, dueAt: at, nextAt: at });
  await setPending(d, u, null);
  await d.out.send(u.chatId, `Got it. ${formatWhen(at, tz, now)}. I will send the path then, starting with step 1.`, confirmButtons(u, created.id));
  await remember(d, u, memoryLine.task({ title, when: formatWhen(at, tz), details: ["learning path built from saved posts"], plan: steps }));
}

async function topics(d: Deps, u: User) {
  const items = (await d.repo.listItems(u.id, ["open", "quiet", "done", "dropped"], "save")).slice(-80);
  if (items.length < 3) return void (await d.out.send(u.chatId, "Save a few more posts first. I group them once you have at least three."));
  await d.out.typing(u.chatId);
  let t;
  try {
    t = await ask(d, "topics", TopicsSchema, topicsPrompt(items.map((i) => ({ id: i.id, title: i.payload.title }))));
  } catch (e) {
    d.log("topics failed", String(e));
    await d.out.send(u.chatId, "I could not group your saves right now. Try again in a minute.");
    return;
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const used = new Set<number>();
  const blocks: string[] = [];
  for (const topic of t.topics) {
    const group = topic.ids.map((id) => byId.get(id)).filter((i): i is Item => !!i && !used.has(i.id));
    if (!group.length) continue;
    group.forEach((i) => used.add(i.id));
    const done = group.filter((i) => i.status === "done").length;
    const open = group.filter((i) => i.status === "open" || i.status === "quiet");
    const next = open[0] ? `\nNext up: ${esc(open[0].payload.title)}` : "";
    blocks.push(`<b>${esc(topic.name)}</b>: ${group.length} saved, ${done} done${next}`);
  }
  const rest = items.filter((i) => !used.has(i.id)).length;
  if (rest) blocks.push(`<b>Other</b>: ${rest} saved`);
  await d.out.send(u.chatId, clip([`<b>Your saves by topic</b>`, "", blocks.join("\n\n"), "", "Send /path and a topic to turn one into a plan."].join("\n")));
}

// ---------------------------------------------------------------------------
// Accountability buddy
// ---------------------------------------------------------------------------

const nameOf = (u: User) => u.firstName || "Your friend";

const confirmButtons = (u: User, itemId: number): Button[][] | undefined => (u.buddyId ? [[{ text: "Share with buddy", data: `sb:${itemId}` }]] : undefined);

// Messages the user's buddy. False when there is no buddy or they blocked the bot.
async function tellBuddy(d: Deps, u: User, html: string): Promise<boolean> {
  if (!u.buddyId) return false;
  const b = await d.repo.getUser(u.buddyId);
  if (!b) return false;
  try {
    await d.out.send(b.chatId, html);
    return true;
  } catch (e) {
    d.log("buddy message failed", String((e as Error).message ?? e));
    return false;
  }
}

async function buddyCommand(d: Deps, u: User) {
  if (u.buddyId) {
    const b = await d.repo.getUser(u.buddyId);
    await d.out.send(
      u.chatId,
      `Your accountability buddy is ${esc(b?.firstName || "a friend")}. They only hear about goals you share with them: when you miss a reminder, and when you finish.`,
      [[{ text: "Remove buddy", data: "bd:rm" }]],
    );
    return;
  }
  const token = u.buddyInvite ?? randomBytes(9).toString("base64url");
  if (!u.buddyInvite) await d.repo.updateUser(u.id, { buddyInvite: token });
  await d.out.send(
    u.chatId,
    [
      "Send this link to a friend:",
      `https://t.me/${d.botUsername}?start=buddy_${token}`,
      "",
      'When they open it and tap Start, they become your accountability buddy. Then tap "Share with buddy" when you save a goal. They only hear about goals you share: when you miss a reminder, and when you finish.',
    ].join("\n"),
  );
}

async function acceptBuddy(d: Deps, u: User, token: string) {
  const owner = /^[A-Za-z0-9_-]{6,64}$/.test(token) ? await d.repo.findUserByBuddyInvite(token) : null;
  if (!owner) {
    await d.out.send(u.chatId, "That buddy link is no longer valid. Ask your friend to send /buddy for a new one.");
    return;
  }
  if (owner.id === u.id) {
    await d.out.send(u.chatId, "That is your own buddy link. Send it to a friend.");
    return;
  }
  await d.repo.updateUser(owner.id, { buddyId: u.id, buddyInvite: null });
  await d.out.send(
    u.chatId,
    `You are now ${esc(owner.firstName || "your friend")}'s accountability buddy. I will only message you about goals they share with you: when they miss a reminder, and when they finish one.\n\nWant to use OctoKeep yourself? Send /start.`,
  );
  try {
    await d.out.send(owner.chatId, `${esc(nameOf(u))} is now your accountability buddy. When you save a goal or set a task, tap "Share with buddy" to let them follow it.`);
  } catch (e) {
    d.log("buddy confirm failed", String((e as Error).message ?? e));
  }
}

async function shareWithBuddy(d: Deps, u: User, item: Item) {
  if (!u.buddyId || item.status === "done" || item.status === "dropped" || item.payload.shared) return;
  await d.repo.updateItem(item.id, u.id, { payload: { ...item.payload, shared: true } });
  const b = await d.repo.getUser(u.buddyId);
  const when = item.nextAt ? formatWhen(item.nextAt, b?.timezone ?? zoneOf(u), d.now()) : null;
  const told = await tellBuddy(
    d,
    u,
    `${esc(nameOf(u))} shared a goal with you: <b>${esc(item.payload.title)}</b>${when ? `, next check-in ${when}` : ""}. I will tell you if they miss a reminder, and when they finish.`,
  );
  await d.out.send(u.chatId, told ? `Shared with ${esc(b?.firstName || "your buddy")}.` : "I could not reach your buddy. They may have blocked the bot. Send /buddy to check.");
}

export { LlmError };

// ---------------------------------------------------------------------------
// Screenshots, screen recordings and voice messages
// ---------------------------------------------------------------------------

// Telegram lets bots download files up to 20 MB.
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// An album arrives as one update per photo, within a second or two.
export const ALBUM_QUIET_MS = 2500;

export async function handleMedia(d: Deps, m: IncomingMedia) {
  const u = await d.repo.ensureUser(m.userId, m.chatId, m.firstName);
  if (!(await ready(d, u))) return;

  if (m.fileSize && m.fileSize > MAX_DOWNLOAD_BYTES) {
    await d.out.send(u.chatId, "That file is over 20 MB, the most Telegram lets me download. Send a shorter clip (under about 2 minutes) or a smaller file.");
    return;
  }
  if (m.kind === "image") return readScreenshot(d, u, m);
  return listen(d, u, m);
}

async function readScreenshot(d: Deps, u: User, m: IncomingMedia) {
  if (!d.media.readImage) {
    await d.out.send(u.chatId, "Reading screenshots is not set up on this bot. Paste the text instead.");
    return;
  }
  if (m.fileSize && m.fileSize > MAX_IMAGE_BYTES) {
    await d.out.send(u.chatId, "That image is too large to read. Send it as a photo rather than a file.");
    return;
  }

  if (m.groupId) await d.repo.addMediaPart(u.id, m.groupId, m.messageId, d.now());
  else await d.out.typing(u.chatId);

  let text = "";
  try {
    text = await d.media.readImage(await m.download(), m.mime);
  } catch (e) {
    d.log("reading image failed", String((e as Error).message ?? e));
    if (!m.groupId) {
      await d.out.send(u.chatId, "I could not read that image right now. Try again in a minute, or paste the text.");
      return;
    }
  }
  const part: MediaPart = { caption: m.caption, text };
  if (!m.groupId) return saveScreenshots(d, u, [part]);

  // Every photo of the album waits; the last one to finish reading claims the
  // whole album and makes one summary.
  await d.repo.finishMediaPart(u.id, m.groupId, m.messageId, part, d.now());
  await d.sleep(ALBUM_QUIET_MS);
  const parts = await d.repo.claimMediaGroup(u.id, m.groupId, new Date(d.now().getTime() - (ALBUM_QUIET_MS - 300)));
  if (!parts) return;
  const fresh = (await d.repo.getUser(u.id)) ?? u;
  return saveScreenshots(d, fresh, parts);
}

async function saveScreenshots(d: Deps, u: User, parts: MediaPart[]) {
  const captions = parts.map((p) => p.caption.trim()).filter(Boolean).join("\n");
  const pendingUrl = u.pending?.kind === "paste_for" ? u.pending.url : undefined;
  const url = findUrl(captions) ?? pendingUrl;
  const note = (url ? captions.replace(url, "") : captions).trim();
  const readable = parts.filter((p) => hasText(p.text));

  if (!readable.length && note.length < 20) {
    const seen = parts.map((p) => p.text.match(/^\s*image:\s*(.+)$/im)?.[1]).find(Boolean);
    await d.out.send(
      u.chatId,
      [
        seen ? `I only see a picture (${esc(clip(seen, 200))}), with no text to summarise.` : "I could not find any text in that image.",
        'If the caption is cut off at "more", tap it first and screenshot again. If it is a video, send a screen recording instead. You can also add a caption saying what you want to remember.',
      ].join(" "),
    );
    return;
  }

  const body = [
    note ? `Note from the user: ${note}` : "",
    ...parts.map((p, i) => (p.text ? `${parts.length > 1 ? `Screenshot ${i + 1}` : "Screenshot"}:\n${p.text}` : "")),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (pendingUrl) await setPending(d, u, null);
  return startSave(d, u, url, body, parts.length > 1 ? `${parts.length} screenshots` : "Screenshot");
}

const FILE_NAMES: Record<string, string> = {
  "audio/ogg": "voice.ogg",
  "audio/mpeg": "audio.mp3",
  "audio/mp3": "audio.mp3",
  "audio/mp4": "audio.m4a",
  "audio/x-m4a": "audio.m4a",
  "audio/m4a": "audio.m4a",
  "audio/wav": "audio.wav",
  "audio/x-wav": "audio.wav",
  "audio/flac": "audio.flac",
  "audio/webm": "audio.webm",
  "video/webm": "video.webm",
  "video/mpeg": "video.mpeg",
};
// Telegram sends most videos as MP4; iPhone recordings sent as files are
// QuickTime, which the same decoder reads, so they go up as .mp4 too.
export const fileNameFor = (mime: string) => FILE_NAMES[mime.toLowerCase()] ?? (mime.startsWith("audio/") ? "audio.ogg" : "video.mp4");

async function listen(d: Deps, u: User, m: IncomingMedia) {
  if (!d.media.transcribe) {
    await d.out.send(u.chatId, m.kind === "voice" ? "I cannot listen to voice messages on this setup. Type it instead." : "Transcribing videos is not set up on this bot. Paste the caption or key points instead.");
    return;
  }
  await d.out.typing(u.chatId);
  let transcript: string;
  try {
    transcript = await d.media.transcribe(await m.download(), fileNameFor(m.mime), m.mime);
  } catch (e) {
    d.log("transcription failed", String((e as Error).message ?? e));
    await d.out.send(u.chatId, "I could not process that recording right now. Try again in a minute.");
    return;
  }

  if (m.kind === "voice") {
    if (!transcript) {
      await d.out.send(u.chatId, "I could not hear anything in that voice message.");
      return;
    }
    await d.out.send(u.chatId, `<i>Heard:</i> ${esc(clip(transcript, 600))}`);
    return handleMessage(d, { userId: m.userId, chatId: m.chatId, messageId: m.messageId, firstName: m.firstName, text: transcript });
  }

  const pendingUrl = u.pending?.kind === "paste_for" ? u.pending.url : undefined;
  const url = findUrl(m.caption) ?? pendingUrl;
  const note = (url ? m.caption.replace(url, "") : m.caption).trim();
  const spoken = hasSpeech(transcript);
  if (!spoken && note.length < 20) {
    await d.out.send(
      u.chatId,
      "I could not hear any speech in that video. If it is mostly text on screen or music, send a screenshot of the caption instead, or paste the key points.",
    );
    return;
  }
  const body = [note ? `Note from the user: ${note}` : "", spoken ? `Transcript of the video:\n${transcript}` : ""].filter(Boolean).join("\n\n");
  if (pendingUrl) await setPending(d, u, null);
  return startSave(d, u, url, body, "Screen recording");
}
