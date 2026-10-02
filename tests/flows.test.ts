import { describe, expect, it } from "vitest";
import { runTick } from "../src/tick.js";
import { BAD_KEY, GOOD_ACCOUNT, GOOD_KEY, onboard, setup, summaryFake } from "./helpers.js";

const DAY = 86_400_000;
const later = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const START = new Date("2026-10-02T10:00:00Z"); // Friday 11:00 in Lagos

describe("onboarding", () => {
  it("asks for a timezone, then walks through connect and deletes the key", async () => {
    const t = setup();
    await t.say("/start");
    expect(t.out.last().html).toContain("which timezone");
    expect(t.out.last().buttons?.[0]?.[0]?.data).toBe("tz:Africa/Lagos");

    await t.tap("tz:Africa/Lagos");
    expect(t.out.texts().some((x) => x.includes("Timezone set to Africa/Lagos"))).toBe(true);
    expect(t.out.last().html).toContain("Send me the Account ID");

    await t.say(GOOD_ACCOUNT);
    expect(t.out.last().html).toContain("delegate private key");
    const keyMsg = await t.say(GOOD_KEY);
    expect(t.out.deleted).toContain(keyMsg);
    expect(t.out.last().html).toContain("Connected");

    const u = await t.repo.getUser(1);
    expect(u?.creds).toEqual({ accountId: GOOD_ACCOUNT, key: GOOD_KEY });
    expect(u?.timezone).toBe("Africa/Lagos");
    expect(u?.pending).toBeNull();
  });

  it("rejects a key the account does not accept and starts over", async () => {
    const t = setup();
    await t.say("/start");
    await t.say("Lagos");
    await t.say(GOOD_ACCOUNT);
    const keyMsg = await t.say(BAD_KEY);
    expect(t.out.deleted).toContain(keyMsg);
    expect(t.out.last().html).toContain("did not accept that key");
    expect((await t.repo.getUser(1))?.creds).toBeNull();
    expect((await t.repo.getUser(1))?.pending).toEqual({ kind: "connect_account" });
  });

  it("deletes a private key pasted outside /connect", async () => {
    const t = setup();
    await onboard(t);
    const id = await t.say(`here is my key ${"d".repeat(64)}`);
    expect(t.out.deleted).toContain(id);
    expect(t.out.last().html).toContain("deleted it");
  });

  it("asks unconnected users to connect before saving", async () => {
    const t = setup();
    await t.say("/start");
    await t.say("Lagos");
    await t.say("/cancel");
    await t.say("https://example.com/post");
    expect(t.out.last().html).toContain("/connect");
    expect(t.repo.items.size).toBe(0);
  });

  it("lets an admin connect with the server's own credentials", async () => {
    const t = setup();
    await t.say("/start");
    await t.say("Lagos");
    await t.say("/connect env");
    expect(t.out.last().html).toContain("Connected");
  });
});

describe("saved posts", () => {
  it("summarises, asks intent and gap, saves to memory, nudges, and records the outcome", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake, nudge: () => "NONE" } });
    await onboard(t);

    await t.say("https://www.youtube.com/watch?v=abc123DEF45");
    const summary = t.out.last();
    expect(summary.html).toContain("<b>Pass your first cloud certification</b>");
    expect(summary.html).toContain("1. Book the exam for four weeks from now (small)");
    expect(summary.html).toContain("Do you want to act on this?");
    expect(summary.buttons?.[0]?.map((b) => b.text)).toEqual(["Yes", "Maybe later", "No"]);

    await t.tap("i:1:y");
    expect(t.out.buttonsRemoved).toContain(summary.id);
    expect(t.out.last().html).toContain("When should I check back?");
    await t.tap("g:1:2");
    expect(t.out.last().html).toBe("Saved. I will check in on Sunday 4 Oct, 11:00.");

    const item = (await t.repo.getItem(1, 1))!;
    expect(item.status).toBe("open");
    expect(item.nextAt).toEqual(later(START, 2));
    expect((await t.mem.all()).some((m) => m.startsWith("[SAVE] Pass your first cloud certification"))).toBe(true);

    // Nothing is due before the gap.
    expect((await runTick(t.deps, { now: later(START, 1) })).nudged).toBe(0);

    // Two days later the nudge arrives.
    const r = await runTick(t.deps, { now: later(START, 2) });
    expect(r.nudged).toBe(1);
    const nudge = t.out.last();
    expect(nudge.html).toContain("You saved <b>Pass your first cloud certification</b> 2 days ago.");
    expect(nudge.html).toContain("First step: Book the exam");
    expect(nudge.buttons?.flat().map((b) => b.text)).toEqual(["Done", "Partly", "Snooze 3 days", "Drop it"]);
    const after = (await t.repo.getItem(1, 1))!;
    expect(after.nudgeCount).toBe(1);
    expect(after.nextAt).toEqual(later(later(START, 2), 4));

    t.setNow(later(START, 2));
    await t.tap("n:1:done");
    expect((await t.repo.getItem(1, 1))!.status).toBe("done");
    expect(t.out.last().html).toContain("done. Nice work.");
    expect((await t.mem.all()).some((m) => m.startsWith('[OUTCOME] saved post "Pass your first cloud certification" | done'))).toBe(true);

    // Closed items never nudge again.
    expect((await runTick(t.deps, { now: later(START, 30) })).nudged).toBe(0);
  });

  it("accepts a typed intent and a typed gap", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.say("https://example.com/article");
    await t.say("I will book the exam this weekend");
    await t.say("5 days");
    const item = (await t.repo.getItem(1, 1))!;
    expect(item.gapDays).toBe(5);
    expect((item.payload as { intent?: string }).intent).toBe("I will book the exam this weekend");
    expect(item.nextAt).toEqual(later(START, 5));
  });

  it("uses the default gap for maybe later, and keeps a no without a reminder", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.say("/gap 3");
    await t.say("https://example.com/a");
    await t.tap("i:1:m");
    expect((await t.repo.getItem(1, 1))!.nextAt).toEqual(later(START, 3));
    await t.say("https://example.com/b");
    await t.tap("i:2:n");
    const dropped = (await t.repo.getItem(2, 1))!;
    expect(dropped.status).toBe("dropped");
    expect(dropped.nextAt).toBeNull();
    expect((await t.mem.all()).filter((m) => m.startsWith("[SAVE]"))).toHaveLength(2);
  });

  it("asks for the text when a platform cannot be read, then summarises the paste", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake }, fetch: async () => ({ ok: false, reason: "paste", source: "Instagram" }) });
    await onboard(t);
    await t.say("https://www.instagram.com/p/xyz/");
    expect(t.out.last().html).toContain("cannot read Instagram posts directly");
    await t.say("5 things to do before your first tech interview: research the company, practise out loud, prepare questions.");
    expect(t.out.last().html).toContain("Do you want to act on this?");
    expect((await t.repo.getItem(1, 1))!.payload.title).toBe("Pass your first cloud certification");
  });

  it("goes quiet after three unanswered nudges and lists the item under /ignored", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake, nudge: () => "NONE" } });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    let now = later(START, 2);
    for (let i = 0; i < 3; i++) {
      const r = await runTick(t.deps, { now });
      expect(r.nudged).toBe(1);
      now = (await t.repo.getItem(1, 1))!.nextAt ?? now;
    }
    expect((await t.repo.getItem(1, 1))!.status).toBe("quiet");
    expect((await runTick(t.deps, { now: later(START, 100) })).nudged).toBe(0);
    await t.say("/ignored");
    expect(t.out.last().buttons?.[0]?.[0]?.text).toBe("Bring back");
    await t.tap("r:1:x");
    expect((await t.repo.getItem(1, 1))!.status).toBe("open");
  });

  it("understands a typed reply to a nudge", async () => {
    const t = setup({
      now: START,
      llm: { summary: summaryFake, nudge: () => "NONE", outcome: () => ({ result: "snooze", snoozeDays: 7, note: "busy this week" }) },
    });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    await runTick(t.deps, { now: later(START, 2) });
    t.setNow(later(START, 2));
    await t.say("not this week, remind me next week");
    expect((await t.repo.getItem(1, 1))!.nextAt).toEqual(later(START, 9));
    expect(t.out.last().html).toContain("Back on");
  });
});

describe("scheduler safety", () => {
  it("never sends the same nudge twice when two ticks overlap", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake, nudge: () => "NONE" } });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    const [a, b] = await Promise.all([runTick(t.deps, { now: later(START, 2) }), runTick(t.deps, { now: later(START, 2) })]);
    expect(a.nudged + b.nudged).toBe(1);
  });

  it("stops nudging a user who blocked the bot", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake, nudge: () => "NONE" } });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    t.out.blocked.add(1);
    const r = await runTick(t.deps, { now: later(START, 2) });
    expect(r.failed).toBe(1);
    expect((await t.repo.getItem(1, 1))!.status).toBe("quiet");
  });

  it("queues a failed memory write and retries it on the next tick", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    t.mem.failWrites = true;
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    expect(t.out.last().html).toContain("Saved.");
    expect(t.repo.outbox.size).toBe(1);
    t.mem.failWrites = false;
    const r = await runTick(t.deps, { now: later(START, 0.01) });
    expect(r.memoryRetried).toBe(1);
    expect(t.repo.outbox.size).toBe(0);
    expect((await t.mem.all()).some((m) => m.startsWith("[SAVE]"))).toBe(true);
  });

  it("ignores a stale button", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    const count = t.out.sent.length;
    await t.tap("g:1:7");
    expect(t.out.sent.length).toBe(count);
    expect((await t.repo.getItem(1, 1))!.gapDays).toBe(2);
  });
});

describe("tasks", () => {
  const taskLlm = {
    route: () => ({ type: "task", title: "Build the budget tracker app", date: "2026-10-08", time: null, hasPersonalFacts: false }),
    questions: () => ({ questions: ["What is the app?", "Which stack?", "What is the first step?"] }),
    plan: () => ({ plan: ["Create the Next.js project", "Set up Supabase", "Build the add-expense form"] }),
  };

  it("asks the time, asks questions, stops on skip, and sends the plan at the right moment", async () => {
    const t = setup({ now: START, llm: taskLlm });
    await onboard(t);
    await t.say("I want to build an app on Thursday, remind me");
    expect(t.out.last().html).toBe("Thursday 8 Oct. What time?");
    await t.say("9am");
    expect(t.out.last().html).toContain("Thursday 8 Oct, 09:00. A few quick questions");
    expect(t.out.last().html).toContain("What is the app?");
    await t.say("A budget tracker for me and my flatmates");
    expect(t.out.last().html).toBe("Which stack?");
    await t.say("Next.js and Supabase");
    await t.say("skip");
    expect(t.out.last().html).toBe("Got it. Thursday 8 Oct, 09:00. I will send your plan then.");

    const task = (await t.repo.getItem(1, 1))!;
    expect(task.kind).toBe("task");
    // 09:00 in Lagos is 08:00 UTC.
    expect(task.dueAt?.toISOString()).toBe("2026-10-08T08:00:00.000Z");
    expect((await t.mem.all()).some((m) => m.startsWith("[TASK] Build the budget tracker app | due: Thursday 8 Oct, 09:00"))).toBe(true);

    expect((await runTick(t.deps, { now: new Date("2026-10-08T07:59:00Z") })).nudged).toBe(0);
    await runTick(t.deps, { now: new Date("2026-10-08T08:00:00Z") });
    const reminder = t.out.last();
    expect(reminder.html).toContain("<b>Today: Build the budget tracker app</b>");
    expect(reminder.html).toContain("- A budget tracker for me and my flatmates");
    expect(reminder.html).toContain("1. Create the Next.js project");
    expect(reminder.buttons?.flat().map((b) => b.text)).toEqual(["Done", "Snooze 1h", "Tomorrow", "Reschedule"]);

    t.setNow(new Date("2026-10-08T08:00:00Z"));
    await t.tap("t:1:h1");
    expect((await t.repo.getItem(1, 1))!.nextAt?.toISOString()).toBe("2026-10-08T09:00:00.000Z");
  });

  it("asks for a day when none was given and refuses a time that has passed", async () => {
    const t = setup({
      now: START,
      llm: {
        ...taskLlm,
        route: () => ({ type: "task", title: "Call the bank", date: null, time: null, hasPersonalFacts: false }),
        when: (prompt: string) => (prompt.includes("this morning") ? { date: "2026-10-02", time: "08:00" } : { date: "2026-10-05", time: "10:00" }),
        questions: () => ({ questions: [] }),
      },
    });
    await onboard(t);
    await t.say("call the bank");
    expect(t.out.last().html).toContain("When should I remind you?");
    await t.say("this morning at 8");
    expect(t.out.last().html).toContain("has already passed");
    await t.say("Monday 10am");
    expect(t.out.last().html).toBe("Got it. Monday 5 Oct, 10:00. I will send your plan then.");
  });

  it("reschedules from the reminder", async () => {
    const t = setup({
      now: START,
      llm: { ...taskLlm, route: () => ({ type: "task", title: "Build the app", date: "2026-10-08", time: "09:00", hasPersonalFacts: false }), questions: () => ({ questions: [] }), when: () => ({ date: "2026-10-09", time: "18:00" }) },
    });
    await onboard(t);
    await t.say("build the app thursday 9am");
    await runTick(t.deps, { now: new Date("2026-10-08T08:00:00Z") });
    t.setNow(new Date("2026-10-08T08:05:00Z"));
    await t.tap("t:1:rs");
    expect(t.out.last().html).toContain("When should I move");
    await t.say("friday 6pm");
    expect(t.out.last().html).toBe("Moved to Friday 9 Oct, 18:00.");
    const task = (await t.repo.getItem(1, 1))!;
    expect(task.dueAt?.toISOString()).toBe("2026-10-09T17:00:00.000Z");
    expect(task.nudgeCount).toBe(0);
  });
});

describe("memory questions and commands", () => {
  it("answers from recalled memories", async () => {
    const t = setup({
      now: START,
      llm: {
        summary: summaryFake,
        route: () => ({ type: "question", title: null, date: null, time: null, hasPersonalFacts: false }),
        answer: (prompt: string) => (prompt.includes("[SAVE] Pass your first cloud certification") ? "You saved a post about passing your first cloud certification." : "Nothing found."),
      },
    });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    await t.say("what did I save about cloud certification?");
    expect(t.out.last().html).toBe("You saved a post about passing your first cloud certification.");
  });

  it("lists items and marks one done by number", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    await t.say("/list");
    expect(t.out.last().html).toContain("#1 Pass your first cloud certification, next check Sunday 4 Oct, 11:00");
    await t.say("/done 1");
    expect((await t.repo.getItem(1, 1))!.status).toBe("done");
    await t.say("/done 99");
    expect(t.out.last().html).toContain("could not find an open item #99");
  });

  it("lets an admin jump the clock for a demo, and hides /jump from others", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake, nudge: () => "NONE" } });
    await onboard(t);
    await t.say("https://example.com/a");
    await t.tap("i:1:y");
    await t.tap("g:1:2");
    await t.say("/jump 2d");
    expect(t.out.texts().some((x) => x.includes("You saved <b>Pass your first cloud certification</b>"))).toBe(true);
    expect(t.out.last().html).toContain("1 reminder sent");
    t.deps.adminIds.clear();
    await t.say("/jump 2d");
    expect(t.out.last().html).toContain("Unknown command");
  });

  it("escapes HTML in content it did not write", async () => {
    const t = setup({ now: START, llm: { summary: () => ({ ...summaryFake(), title: "Use <script> & friends" }) } });
    await onboard(t);
    await t.say("https://example.com/a");
    expect(t.out.last().html).toContain("<b>Use &lt;script&gt; &amp; friends</b>");
  });

  it("recovers when the model fails", async () => {
    const t = setup({ now: START, llm: {} });
    await onboard(t);
    await t.say("https://example.com/a");
    expect(t.out.last().html).toContain("could not summarise that right now");
    await t.say("hello there");
    expect(t.out.last().html).toContain("did not catch that");
    expect(t.repo.items.size).toBe(0);
  });
});
