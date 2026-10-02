import { describe, expect, it } from "vitest";
import { fileNameFor, MAX_DOWNLOAD_BYTES } from "../src/bot/core.js";
import { loadConfig } from "../src/config.js";
import { MemoryRepo } from "../src/db/memory.js";
import { hasSpeech, hasText, stripThinking } from "../src/media/media.js";
import { FakeMedia, onboard, setup, summaryFake } from "./helpers.js";

const START = new Date("2026-10-02T10:00:00Z");
const POST = "@studywithsam\n5 things to do before your first tech interview: research the company, practise answers out loud, prepare two questions.\nImage: a woman at a desk with a laptop";

const summaryPrompt = (t: ReturnType<typeof setup>) => t.llm.calls.filter((c) => c.task === "summary").at(-1)!.prompt;

describe("screenshots", () => {
  it("reads a screenshot and summarises it like a link", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.send("image", POST);
    expect(t.out.last().html).toContain("Do you want to act on this?");
    expect(t.out.last().html).toContain("<i>Screenshot</i>");
    expect(summaryPrompt(t)).toContain("research the company");
    expect((await t.repo.getItem(1, 1))!.status).toBe("draft");
  });

  it("finishes an Instagram link that could not be read", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake }, fetch: async () => ({ ok: false, reason: "paste", source: "Instagram" }) });
    await onboard(t);
    await t.say("https://www.instagram.com/p/xyz/");
    expect(t.out.last().html).toContain("cannot read Instagram posts directly");
    expect(t.out.last().html).toContain("screenshot");
    expect(t.out.last().html).toContain("screen recording");
    await t.send("image", POST);
    const item = (await t.repo.getItem(1, 1))!;
    expect(item.payload).toMatchObject({ url: "https://www.instagram.com/p/xyz/", source: "instagram.com" });
    expect((await t.repo.getUser(1))!.pending).toEqual({ kind: "save_intent", itemId: 1 });
  });

  it("combines an album into one summary, in order", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    const before = t.out.sent.length;
    await Promise.all(
      ["Slide one: research the company first.", "Slide two: practise your answers out loud.", "Slide three: prepare two questions."].map((text, i) =>
        t.send("image", text, { groupId: "album-1", messageId: 100 + i, caption: i === 0 ? "https://www.instagram.com/p/abc/" : "" }),
      ),
    );
    const summaries = t.out.sent.slice(before).filter((s) => s.html.includes("Do you want to act on this?"));
    expect(summaries).toHaveLength(1);
    const prompt = summaryPrompt(t);
    expect(prompt.indexOf("Screenshot 1:\nSlide one")).toBeGreaterThan(-1);
    expect(prompt.indexOf("Screenshot 3:\nSlide three")).toBeGreaterThan(prompt.indexOf("Screenshot 2:"));
    expect(((await t.repo.getItem(1, 1))!.payload as { url?: string }).url).toBe("https://www.instagram.com/p/abc/");
    expect(t.repo.parts.size).toBe(0);
  });

  it("says so when a picture has no text", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.send("image", "Image: a sunset over the sea");
    expect(t.out.last().html).toContain("I only see a picture (a sunset over the sea)");
    expect(t.repo.items.size).toBe(0);
  });

  it("uses the user's caption when the picture has no text", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.send("image", "Image: a pair of running shoes", { caption: "Buy these before the half marathon in November" });
    expect(t.out.last().html).toContain("Do you want to act on this?");
    expect(summaryPrompt(t)).toContain("Note from the user: Buy these");
  });

  it("reports a vision failure without saving", async () => {
    const media = new FakeMedia();
    media.failImages = true;
    const t = setup({ now: START, llm: { summary: summaryFake }, media });
    await onboard(t);
    await t.send("image", POST);
    expect(t.out.last().html).toContain("could not read that image");
    expect(t.repo.items.size).toBe(0);
  });

  it("explains when screenshots are not set up", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake }, media: { readImage: null, transcribe: null } });
    await onboard(t);
    await t.send("image", POST);
    expect(t.out.last().html).toContain("not set up");
  });
});

describe("recordings and voice", () => {
  const SPEECH = "Today I will show you how to set up a budget in three steps. First list your income, then your fixed costs, then pick one category to cut.";

  it("transcribes a screen recording and summarises it", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.send("recording", SPEECH);
    expect(t.media instanceof FakeMedia && t.media.audio[0]).toEqual({ filename: "video.mp4", mime: "video/mp4" });
    expect(t.out.last().html).toContain("<i>Screen recording</i>");
    expect(summaryPrompt(t)).toContain("Transcript of the video:\n" + SPEECH);
  });

  it("asks for a screenshot when a video has no speech", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    await t.send("recording", "Thank you.");
    expect(t.out.last().html).toContain("could not hear any speech");
    expect(t.repo.items.size).toBe(0);
  });

  it("refuses files Telegram will not let a bot download", async () => {
    const t = setup({ now: START, llm: { summary: summaryFake } });
    await onboard(t);
    let downloaded = false;
    await t.send("recording", SPEECH, {
      fileSize: MAX_DOWNLOAD_BYTES + 1,
      download: async () => {
        downloaded = true;
        return new Uint8Array();
      },
    });
    expect(downloaded).toBe(false);
    expect(t.out.last().html).toContain("over 20 MB");
  });

  it("treats a voice message as typed text", async () => {
    const t = setup({
      now: START,
      llm: {
        route: () => ({ type: "task", title: "Build the budget app", date: "2026-10-08", time: "09:00" }),
        questions: () => ({ questions: [] }),
        plan: () => ({ plan: ["Sketch the screens"], firstStep: "Sketch the screens" }),
      },
    });
    await onboard(t);
    await t.send("voice", "I want to build the budget app on Thursday at nine, remind me");
    const texts = t.out.texts();
    expect(texts.some((x) => x.includes("<i>Heard:</i> I want to build the budget app"))).toBe(true);
    expect(t.llm.calls.some((c) => c.task === "route")).toBe(true);
  });
});

describe("media helpers", () => {
  it("tells speech from Whisper noise", () => {
    expect(hasSpeech("Thank you.")).toBe(false);
    expect(hasSpeech("you you you")).toBe(false);
    expect(hasSpeech("First list your income, then your fixed costs, then cut one thing.")).toBe(true);
  });
  it("tells text from a bare picture description", () => {
    expect(hasText("Image: a sunset")).toBe(false);
    expect(hasText("Study 45 minutes a day for four weeks.\nImage: a desk")).toBe(true);
  });
  it("strips reasoning tags", () => {
    expect(stripThinking("<think>hmm</think>\nCaption text")).toBe("Caption text");
  });
  it("names uploads so the speech API knows the format", () => {
    expect(fileNameFor("audio/ogg")).toBe("voice.ogg");
    expect(fileNameFor("video/quicktime")).toBe("video.mp4");
    expect(fileNameFor("audio/x-m4a")).toBe("audio.m4a");
  });
  it("claims an album only once, after every part is read and quiet", async () => {
    const repo = new MemoryRepo();
    const t0 = new Date("2026-10-02T10:00:00Z");
    const at = (ms: number) => new Date(t0.getTime() + ms);
    await repo.addMediaPart(1, "g", 11, t0);
    await repo.addMediaPart(1, "g", 10, t0);
    await repo.finishMediaPart(1, "g", 11, { caption: "", text: "second" }, at(500));
    expect(await repo.claimMediaGroup(1, "g", at(1000))).toBeNull(); // part 10 still reading
    await repo.finishMediaPart(1, "g", 10, { caption: "", text: "first" }, at(1500));
    expect(await repo.claimMediaGroup(1, "g", at(1000))).toBeNull(); // changed too recently
    expect((await repo.claimMediaGroup(1, "g", at(2000)))!.map((p) => p.text)).toEqual(["first", "second"]);
    expect(await repo.claimMediaGroup(1, "g", at(2000))).toBeNull(); // already claimed
  });
});

describe("media config", () => {
  const base = { TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz", DATABASE_URL: "memory", APP_ENCRYPTION_KEY: "a".repeat(64), LLM_API_KEY: "k" };
  it("defaults to Groq's vision and speech models", () => {
    expect(loadConfig({ ...base, LLM_PROVIDER: "groq" }).media).toEqual({ visionModel: "qwen/qwen3.8-27b", transcribeModel: "whisper-large-v3-turbo" });
  });
  it("can turn either off or override it", () => {
    expect(loadConfig({ ...base, VISION_MODEL: "off", TRANSCRIBE_MODEL: "whisper-large-v3" }).media).toEqual({ visionModel: null, transcribeModel: "whisper-large-v3" });
    expect(loadConfig({ ...base, LLM_PROVIDER: "openrouter" }).media).toEqual({ visionModel: null, transcribeModel: null });
  });
});
