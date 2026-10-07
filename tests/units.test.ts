import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/crypto.js";
import { extractJson } from "../src/llm/llm.js";
import { afterNudge, outboxDelayMs } from "../src/schedule.js";
import { extractArticle, findUrl, youtubeId } from "../src/sources/index.js";
import { calendarContext, formatIn, formatWhen, parseCheckBack, parseGap, parseTimeOfDay, resolveZone, toInstant, tomorrowAt } from "../src/time.js";
import { loadConfig } from "../src/config.js";

const KEY = "0".repeat(63) + "1";

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("hello walrus", KEY);
    const b = encrypt("hello walrus", KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe("hello walrus");
  });
  it("rejects tampered ciphertext and the wrong key", () => {
    const token = encrypt("secret", KEY);
    const raw = Buffer.from(token.slice(3), "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => decrypt(`v1:${raw.toString("base64")}`, KEY)).toThrow();
    expect(() => decrypt(token, "f".repeat(64))).toThrow();
    expect(() => decrypt("v2:abc", KEY)).toThrow();
  });
});

describe("timezones", () => {
  it("resolves cities, countries, IANA names and offsets", () => {
    expect(resolveZone("Lagos")).toBe("Africa/Lagos");
    expect(resolveZone("nigeria")).toBe("Africa/Lagos");
    expect(resolveZone("africa/lagos")).toBe("Africa/Lagos");
    expect(resolveZone("London")).toBe("Europe/London");
    expect(resolveZone("new york")).toBe("America/New_York");
    expect(resolveZone("UTC+1")).toBe("UTC+1");
    expect(resolveZone("gmt-5")).toBe("UTC-5");
    expect(resolveZone("+05:30")).toBe("UTC+5:30");
    expect(resolveZone("utc")).toBe("UTC");
    expect(resolveZone("narnia")).toBeNull();
    expect(resolveZone("UTC+20")).toBeNull();
  });
  it("converts local wall time to the right instant", () => {
    expect(toInstant("2026-10-08", "09:00", "Africa/Lagos")!.toISOString()).toBe("2026-10-08T08:00:00.000Z");
    // London is on BST in October, GMT in December.
    expect(toInstant("2026-10-08", "09:00", "Europe/London")!.toISOString()).toBe("2026-10-08T08:00:00.000Z");
    expect(toInstant("2026-12-08", "09:00", "Europe/London")!.toISOString()).toBe("2026-12-08T09:00:00.000Z");
    expect(toInstant("2026-10-08", "09:00", "UTC+5:30")!.toISOString()).toBe("2026-10-08T03:30:00.000Z");
  });
  it("builds a calendar the model can read", () => {
    const cal = calendarContext(new Date("2026-10-02T23:30:00Z"), "Africa/Lagos").split("\n");
    // 23:30 UTC is already Saturday 00:30 in Lagos.
    expect(cal[0]).toBe("2026-10-03 Saturday (today)");
    expect(cal[1]).toBe("2026-10-04 Sunday (tomorrow)");
    expect(cal).toHaveLength(14);
  });
  it("formats times in the user's zone", () => {
    expect(formatWhen(new Date("2026-10-08T08:00:00Z"), "Africa/Lagos", new Date("2026-10-02T10:00:00Z"))).toBe("Thursday 8 Oct, 09:00");
    // 22:30 UTC is 23:30 on the 2nd in Lagos; 23:30 UTC is already the 3rd.
    expect(tomorrowAt(new Date("2026-10-02T22:30:00Z"), "Africa/Lagos", "09:00").toISOString()).toBe("2026-10-03T08:00:00.000Z");
    expect(tomorrowAt(new Date("2026-10-02T23:30:00Z"), "Africa/Lagos", "09:00").toISOString()).toBe("2026-10-04T08:00:00.000Z");
  });
});

describe("parsing", () => {
  it("reads times of day", () => {
    expect(parseTimeOfDay("9am")).toBe("09:00");
    expect(parseTimeOfDay("9:30 pm")).toBe("21:30");
    expect(parseTimeOfDay("12am")).toBe("00:00");
    expect(parseTimeOfDay("12 pm")).toBe("12:00");
    expect(parseTimeOfDay("21:00")).toBe("21:00");
    expect(parseTimeOfDay("at 7")).toBe("07:00");
    expect(parseTimeOfDay("evening")).toBe("19:00");
    expect(parseTimeOfDay("13pm")).toBeNull();
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("thursday")).toBeNull();
  });
  it("reads gaps", () => {
    expect(parseGap("3")).toBe(3);
    expect(parseGap("3 days")).toBe(3);
    expect(parseGap("2w")).toBe(14);
    expect(parseGap("1 week")).toBe(7);
    expect(parseGap("0")).toBeNull();
    expect(parseGap("100")).toBeNull();
    expect(parseGap("soon")).toBeNull();
  });
  it("finds URLs without trailing punctuation", () => {
    expect(findUrl("look at this: https://example.com/a?b=1).")).toBe("https://example.com/a?b=1");
    expect(findUrl("no link here")).toBeNull();
  });
  it("recognises YouTube links", () => {
    expect(youtubeId(new URL("https://www.youtube.com/watch?v=abc123DEF45"))).toBe("abc123DEF45");
    expect(youtubeId(new URL("https://youtu.be/abc123DEF45?t=4"))).toBe("abc123DEF45");
    expect(youtubeId(new URL("https://m.youtube.com/shorts/abc123DEF45"))).toBe("abc123DEF45");
    expect(youtubeId(new URL("https://example.com/watch?v=x"))).toBeNull();
  });
  it("extracts JSON from messy model output", () => {
    expect(extractJson('Sure! ```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"t": "a } inside", "n": {"x": 2}} done')).toEqual({ t: "a } inside", n: { x: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });
});

describe("article extraction", () => {
  it("pulls the main text and title", () => {
    const body = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} explains how to study for the exam with a clear plan and real practice questions every single week.</p>`).join("");
    const html = `<html><head><title>Ignore me</title><meta property="og:title" content="Study plan"><meta property="og:site_name" content="Example Blog"></head><body><nav>Home About</nav><article><h1>Study plan</h1>${body}</article><footer>Copyright</footer></body></html>`;
    const c = extractArticle(html, "https://blog.example.com/post")!;
    expect(c.title).toBe("Study plan");
    expect(c.source).toBe("Example Blog");
    expect(c.text).toContain("Paragraph 11");
    expect(c.text).not.toContain("Copyright");
  });
  it("falls back to the meta description on thin pages", () => {
    const html = `<html><head><meta property="og:title" content="Short"><meta name="description" content="A useful description of the page that is long enough to keep."></head><body><div id="app"></div></body></html>`;
    const c = extractArticle(html, "https://app.example.com/")!;
    expect(c.text).toContain("useful description");
    expect(c.source).toBe("app.example.com");
  });
  it("returns null when there is nothing to read", () => {
    expect(extractArticle("<html><body></body></html>", "https://x.example")).toBeNull();
  });
});

describe("custom check-back time", () => {
  const now = new Date("2026-10-02T10:00:00Z"); // 11:00 in Lagos
  const zone = "Africa/Lagos";
  const mins = (s: string) => {
    const at = parseCheckBack(s, now, zone);
    return at ? (at.getTime() - now.getTime()) / 60_000 : null;
  };

  it("reads durations", () => {
    expect(mins("5 min")).toBe(5);
    expect(mins("5m")).toBe(5);
    expect(mins("in 45 minutes")).toBe(45);
    expect(mins("2 hours")).toBe(120);
    expect(mins("1h 30m")).toBe(90);
    expect(mins("an hour")).toBe(60);
    expect(mins("half an hour")).toBe(30);
    expect(mins("3 days")).toBe(3 * 1440);
    expect(mins("3")).toBe(3 * 1440);
    expect(mins("2 weeks")).toBe(14 * 1440);
  });

  it("reads clock times as the next occurrence, local", () => {
    expect(parseCheckBack("6pm", now, zone)).toEqual(new Date("2026-10-02T17:00:00Z"));
    expect(parseCheckBack("9am", now, zone)).toEqual(new Date("2026-10-03T08:00:00Z"));
    expect(parseCheckBack("tomorrow 9am", now, zone)).toEqual(new Date("2026-10-03T08:00:00Z"));
    expect(parseCheckBack("tomorrow", now, zone)).toEqual(new Date("2026-10-03T08:00:00Z"));
    expect(parseCheckBack("at 18:30", now, zone)).toEqual(new Date("2026-10-02T17:30:00Z"));
  });

  it("rejects nonsense and out-of-range values", () => {
    for (const s of ["soon", "0 min", "30 seconds", "61 days", "5 apples", "next year"]) expect(parseCheckBack(s, now, zone)).toBeNull();
  });

  it("formats short gaps", () => {
    expect(formatIn(5 * 60_000)).toBe("5 minutes");
    expect(formatIn(90 * 60_000)).toBe("1 hour 30 minutes");
    expect(formatIn(2 * 86_400_000)).toBe("2 days");
    expect(formatIn(7 * 86_400_000)).toBe("1 week");
  });
});

describe("schedule", () => {
  const now = new Date("2026-10-02T10:00:00Z");
  it("backs off saves and goes quiet after three nudges", () => {
    const a = afterNudge({ kind: "save", gapDays: 2, nudgeCount: 0 }, now);
    expect(a).toEqual({ status: "open", nextAt: new Date("2026-10-06T10:00:00Z"), nudgeCount: 1 });
    const b = afterNudge({ kind: "save", gapDays: 2, nudgeCount: 1 }, now);
    expect(b.nextAt).toEqual(new Date("2026-10-10T10:00:00Z"));
    expect(afterNudge({ kind: "save", gapDays: 2, nudgeCount: 2 }, now)).toEqual({ status: "quiet", nextAt: null, nudgeCount: 3 });
  });
  it("gives a task one follow-up a day later", () => {
    // A gap of minutes still backs off from a day after the first reminder.
    expect(afterNudge({ kind: "save", gapDays: 5 / 1440, nudgeCount: 0 }, now).nextAt).toEqual(new Date(now.getTime() + 2 * 86_400_000));
    expect(afterNudge({ kind: "task", gapDays: 1, nudgeCount: 0 }, now).nextAt).toEqual(new Date("2026-10-03T10:00:00Z"));
    expect(afterNudge({ kind: "task", gapDays: 1, nudgeCount: 1 }, now).status).toBe("quiet");
  });
  it("retries memory writes with growing delays", () => {
    expect(outboxDelayMs(1)).toBe(60_000);
    expect(outboxDelayMs(4)).toBe(7_200_000);
    expect(outboxDelayMs(9)).toBe(21_600_000);
  });
});

describe("config", () => {
  const base = { TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz", DATABASE_URL: "memory", APP_ENCRYPTION_KEY: "a".repeat(64), LLM_API_KEY: "k" };
  it("applies provider defaults and treats blank values as unset", () => {
    const c = loadConfig({ ...base, LLM_PROVIDER: "groq", MEMWAL_SERVER_URL: "", LLM_MODEL: "  " });
    expect(c.llm.baseURL).toBe("https://api.groq.com/openai/v1");
    expect(c.MEMWAL_SERVER_URL).toBe("https://relayer.memory.walrus.xyz");
    expect(c.MEMWAL_NAMESPACE).toBe("octokeep");
    expect(c.llm.model).toBeTruthy();
  });
  it("names the problem without echoing values", () => {
    expect(() => loadConfig({ ...base, APP_ENCRYPTION_KEY: "short-secret-value" })).toThrow(/APP_ENCRYPTION_KEY must be 64 hex/);
    try {
      loadConfig({ ...base, APP_ENCRYPTION_KEY: "short-secret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("short-secret-value");
    }
  });
  it("builds the Ollama URL and parses admin ids", () => {
    const c = loadConfig({ ...base, LLM_PROVIDER: "ollama", LLM_API_KEY: "", ADMIN_TELEGRAM_IDS: "12, 34,x" });
    expect(c.llm.baseURL).toBe("http://localhost:11434/v1");
    expect([...c.adminIds]).toEqual([12, 34]);
  });
});

describe("config safety", () => {
  const base = { TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz", DATABASE_URL: "memory", APP_ENCRYPTION_KEY: "a".repeat(64), LLM_API_KEY: "k" };
  it("refuses an API key pasted into LLM_MODEL without echoing it", () => {
    const leaked = "gsk_" + "Z".repeat(48);
    let message = "";
    try {
      loadConfig({ ...base, LLM_MODEL: leaked });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("LLM_MODEL looks like an API key");
    expect(message).not.toContain(leaked);
  });
  it("accepts real model names", () => {
    for (const m of ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b"]) {
      expect(loadConfig({ ...base, LLM_MODEL: m }).llm.model).toBe(m);
    }
  });
});

describe("reasoning output", () => {
  it("drops <think> blocks before reading JSON", async () => {
    const { stripThinking } = await import("../src/llm/llm.js");
    const raw = '<think>The user wants {"a": 0}? No.</think>\n{"a": 1}';
    expect(extractJson(stripThinking(raw))).toEqual({ a: 1 });
    expect(stripThinking("<think>unfinished")).toBe("");
  });
});
