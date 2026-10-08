import { describe, expect, it } from "vitest";
import { handleCallback, handleMessage } from "../src/bot/core.js";
import type { Memory, Recalled } from "../src/memory/client.js";
import { runTick } from "../src/tick.js";
import { onboard, setup, summaryFake } from "./helpers.js";

const DAY = 86_400_000;
const later = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const START = new Date("2026-10-02T10:00:00Z"); // Friday 11:00 in Lagos

// Saves the default link and picks a 2-day check-back.
async function saveOne(t: ReturnType<typeof setup>, url = "https://example.com/article") {
  await t.say(url);
  await t.tap(`i:${t.repo.items.size}:y`);
  await t.tap(`g:${t.repo.items.size}:2`);
}

// Makes recall return fixed results, as the real relayer would for a close match.
function stubRecall(t: ReturnType<typeof setup>, results: Recalled[]) {
  const original = t.deps.memoryFor;
  t.deps.memoryFor = (c) => {
    const m = original(c);
    return { ...m, recall: async () => results } satisfies Memory;
  };
}

describe("earlier saves", () => {
  it("says when the same link was saved before, and what happened to it", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await saveOne(t);
    t.setNow(later(START, 1));
    await t.say("https://example.com/article");
    const msg = t.out.last().html;
    expect(msg).toContain("<b>You have been here before</b>");
    expect(msg).toContain('You already saved this on 2 Oct 2026 as "Pass your first cloud certification". It is still open. I check in on Sunday 4 Oct, 11:00.');
  });

  it("finds a similar save in memory and says it was finished", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await saveOne(t);
    await t.say("/done 1");
    stubRecall(t, [{ text: "[SAVE] Pass your first cloud certification | https://example.com/article | summary: ...", distance: 0.2, createdAt: START.toISOString() }]);
    await t.say("https://other.example.com/cloud-cert-guide");
    expect(t.out.last().html).toContain('You saved something similar on 2 Oct 2026: "Pass your first cloud certification". You finished that one.');
  });

  it("says nothing when the closest save is not close enough", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await saveOne(t);
    stubRecall(t, [{ text: "[SAVE] Pass your first cloud certification | summary: ...", distance: 0.6 }]);
    await t.say("https://other.example.com/unrelated");
    expect(t.out.last().html).not.toContain("You have been here before");
  });
});

describe("accountability buddy", () => {
  const friend = { userId: 2, chatId: 2, firstName: "Tobi" };
  let mid = 5000;
  const friendSays = (t: ReturnType<typeof setup>, text: string) => handleMessage(t.deps, { ...friend, messageId: ++mid, text });
  const toFriend = (t: ReturnType<typeof setup>) => t.out.sent.filter((s) => s.chatId === 2).map((s) => s.html);

  async function withBuddy() {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.say("/buddy");
    const link = t.out.last().html.match(/https:\/\/t\.me\/OctoKeep_bot\?start=(buddy_[A-Za-z0-9_-]+)/);
    expect(link).not.toBeNull();
    await friendSays(t, `/start ${link![1]}`);
    return t;
  }

  it("links a friend through the invite link and tells both sides", async () => {
    const t = await withBuddy();
    expect(toFriend(t).at(-1)).toContain("You are now Stephen's accountability buddy.");
    expect(t.out.sent.filter((s) => s.chatId === 1).at(-1)!.html).toContain("Tobi is now your accountability buddy.");
    expect((await t.repo.getUser(1))!.buddyId).toBe(2);
    // The invite is used up.
    expect((await t.repo.getUser(1))!.buddyInvite).toBeNull();
    await t.say("/buddy");
    expect(t.out.last().html).toContain("Your accountability buddy is Tobi.");
  });

  it("refuses unknown and own invite links", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await friendSays(t, "/start buddy_nottherightone");
    expect(toFriend(t).at(-1)).toContain("no longer valid");
    await t.say("/buddy");
    const token = t.out.last().html.match(/start=(buddy_[A-Za-z0-9_-]+)/)![1];
    await t.say(`/start ${token}`);
    expect(t.out.last().html).toContain("That is your own buddy link.");
  });

  it("tells the buddy about a shared goal, a missed reminder once, and when it is done", async () => {
    const t = await withBuddy();
    await saveOne(t);
    const confirm = t.out.last();
    expect(confirm.buttons?.flat().map((b) => b.text)).toEqual(["Share with buddy"]);
    await t.tap("sb:1");
    expect(toFriend(t).at(-1)).toContain("Stephen shared a goal with you: <b>Pass your first cloud certification</b>");
    expect(t.out.last().html).toBe("Shared with Tobi.");
    expect((await t.repo.getItem(1, 1))!.payload.shared).toBe(true);

    const before = toFriend(t).length;
    // First reminder: nothing to the buddy yet.
    await runTick(t.deps, { now: later(START, 2) });
    expect(toFriend(t).length).toBe(before);
    // The first went unanswered; the second reminder also tells the buddy.
    await runTick(t.deps, { now: later(START, 6) });
    expect(toFriend(t).length).toBe(before + 1);
    expect(toFriend(t).at(-1)).toContain("has not answered my last reminder");
    // Only once per item.
    await runTick(t.deps, { now: later(START, 14) });
    expect(toFriend(t).length).toBe(before + 1);

    await t.say("/done 1");
    expect(toFriend(t).at(-1)).toBe("Stephen finished <b>Pass your first cloud certification</b>.");
  });

  it("shows no share button without a buddy, and removes a buddy", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await saveOne(t);
    expect(t.out.last().buttons).toBeUndefined();

    const b = await withBuddy();
    await b.say("/buddy");
    await handleCallback(b.deps, { userId: 1, chatId: 1, firstName: "Stephen", messageId: b.out.last().id, data: "bd:rm" });
    expect((await b.repo.getUser(1))!.buddyId).toBeNull();
    expect(b.out.last().html).toContain("Buddy removed.");
  });

  it("does not break when the buddy blocked the bot", async () => {
    const t = await withBuddy();
    await saveOne(t);
    t.out.blocked.add(2);
    await t.tap("sb:1");
    expect(t.out.last().html).toContain("I could not reach your buddy.");
  });
});

describe("reminders at the usual reply hour", () => {
  it("moves whole-day check-backs to the hour the user usually answers", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    // Three answers at 19:xx Lagos time (18:xx UTC).
    for (let i = 0; i < 3; i++) {
      t.setNow(new Date(START.getTime() + i * DAY));
      await saveOne(t, `https://example.com/a${i}`);
      t.setNow(new Date(`2026-10-0${2 + i}T18:20:00Z`));
      await t.say(`/done ${i + 1}`);
    }
    expect((await t.repo.getUser(1))!.activeHours![19]).toBe(3);

    t.setNow(new Date("2026-10-05T09:00:00Z")); // Monday 10:00 in Lagos
    await saveOne(t, "https://example.com/next");
    expect(t.out.last().html).toBe("Saved. I will check in on Wednesday 7 Oct, 19:00 (around when you usually reply).");
    expect((await t.repo.getItem(4, 1))!.nextAt?.toISOString()).toBe("2026-10-07T18:00:00.000Z");
  });

  it("keeps the chosen time until there is enough data, and never moves custom times", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await saveOne(t);
    expect(t.out.last().html).toBe("Saved. I will check in on Sunday 4 Oct, 11:00.");
    await t.repo.updateUser(1, { activeHours: Array.from({ length: 24 }, (_, h) => (h === 19 ? 5 : 0)) });
    await t.say("https://example.com/custom");
    await t.tap("i:2:y");
    await t.say("5 min");
    expect(t.out.last().html).toBe("Saved. I will check in on Friday 2 Oct, 11:05 (in 5 minutes).");
  });
});

describe("learning paths", () => {
  const pathLlm = {
    summary: summaryFake,
    path: () => ({
      title: "Rust from zero",
      steps: [
        { text: "Read the ownership chapter", from: "Rust ownership in 10 minutes" },
        { text: "Build a CLI todo app", from: "Build a CLI in Rust" },
        { text: "Learn async with Tokio", from: null },
      ],
    }),
  };

  it("builds a path from saves in memory and schedules it", async () => {
    const t = setup({ now: START, llm: pathLlm });
    await onboard(t);
    stubRecall(t, [
      { text: "[SAVE] Rust ownership in 10 minutes | summary: ...", distance: 0.2 },
      { text: "[SAVE] Build a CLI in Rust | summary: ...", distance: 0.3 },
      { text: "[OUTCOME] saved post \"Something\" | done", distance: 0.4 },
    ]);
    await t.say("/path rust");
    const msg = t.out.last();
    expect(msg.html).toContain("<b>Rust from zero</b>");
    expect(msg.html).toContain("Built from 2 of your saves.");
    expect(msg.html).toContain('1. Read the ownership chapter\n   <i>from "Rust ownership in 10 minutes"</i>');
    expect(msg.html).toContain("3. Learn async with Tokio");
    await t.tap("pa:go");
    expect(t.out.last().html).toBe("Got it. Saturday 3 Oct, 09:00. I will send the path then, starting with step 1.");
    const task = (await t.repo.getItem(1, 1))!;
    expect(task.kind).toBe("task");
    expect((task.payload as { plan: string[] }).plan).toEqual(["Read the ownership chapter", "Build a CLI todo app", "Learn async with Tokio"]);
  });

  it("asks for more saves when there are not enough", async () => {
    const t = setup({ now: START, llm: pathLlm });
    await onboard(t);
    stubRecall(t, [{ text: "[SAVE] Rust ownership in 10 minutes | summary: ...", distance: 0.2 }]);
    await t.say("/path rust");
    expect(t.out.last().html).toBe("I found one saved post about rust. Save at least two, then try again.");
    await t.say("/path");
    expect(t.out.last().html).toContain("Send /path and a topic");
  });
});

describe("topics", () => {
  it("groups saves by topic with counts and the next open one", async () => {
    const t = setup({
      now: START,
      llm: {
        summary: summaryFake,
        topics: () => ({ topics: [{ name: "Cloud", ids: [1, 2] }, { name: "Video editing", ids: [3, 99] }] }),
      },
    });
    await onboard(t);
    for (let i = 0; i < 3; i++) await saveOne(t, `https://example.com/t${i}`);
    await t.say("/done 1");
    await t.say("/topics");
    const msg = t.out.last().html;
    expect(msg).toContain("<b>Cloud</b>: 2 saved, 1 done\nNext up: Pass your first cloud certification");
    expect(msg).toContain("<b>Video editing</b>: 1 saved, 0 done");
    expect(msg).not.toContain("Other");
  });

  it("waits for at least three saves", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.say("/topics");
    expect(t.out.last().html).toContain("at least three");
  });
});
