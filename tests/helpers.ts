import { MemWalMock } from "@mysten-incubation/memwal";
import type { z } from "zod";
import type { Deps, Out } from "../src/bot/core.js";
import { handleCallback, handleMedia, handleMessage, type IncomingMedia } from "../src/bot/core.js";
import type { Media } from "../src/media/media.js";
import { MemoryRepo } from "../src/db/memory.js";
import type { Llm } from "../src/llm/llm.js";
import { MemoryAuthError, wrapMemwal, type Memory, type MemwalLike } from "../src/memory/client.js";
import type { FetchResult } from "../src/sources/index.js";
import type { Button, MemwalCreds } from "../src/types.js";

export const GOOD_ACCOUNT = `0x${"a".repeat(64)}`;
export const GOOD_KEY = "b".repeat(64);
export const BAD_KEY = "c".repeat(64);

export interface Sent {
  id: number;
  chatId: number;
  html: string;
  buttons?: Button[][];
}

export class FakeOut implements Out {
  sent: Sent[] = [];
  deleted: number[] = [];
  buttonsRemoved: number[] = [];
  blocked = new Set<number>();
  private seq = 1000;

  async send(chatId: number, html: string, buttons?: Button[][]) {
    if (this.blocked.has(chatId)) {
      const { BlockedError } = await import("../src/bot/core.js");
      throw new BlockedError("blocked");
    }
    const id = ++this.seq;
    this.sent.push({ id, chatId, html, buttons });
    return id;
  }
  async removeButtons(_chatId: number, messageId: number) {
    this.buttonsRemoved.push(messageId);
  }
  async deleteMessage(_chatId: number, messageId: number) {
    this.deleted.push(messageId);
  }
  async typing() {}
  last() {
    return this.sent.at(-1)!;
  }
  texts() {
    return this.sent.map((s) => s.html);
  }
}

type Handler = (prompt: string, system: string) => unknown;

export class FakeLlm implements Llm {
  calls: { task: string; prompt: string }[] = [];
  constructor(public handlers: Record<string, Handler>) {}
  async json<T>(task: string, schema: z.ZodType<T>, system: string, prompt: string): Promise<T> {
    this.calls.push({ task, prompt });
    const h = this.handlers[task];
    if (!h) throw new Error(`no fake for ${task}`);
    return schema.parse(h(prompt, system));
  }
  async text(task: string, system: string, prompt: string): Promise<string> {
    this.calls.push({ task, prompt });
    const h = this.handlers[task];
    if (!h) throw new Error(`no fake for ${task}`);
    return String(h(prompt, system));
  }
}

// One MemWal mock per account; a bad key fails like the relayer would.
export class FakeMemory {
  mocks = new Map<string, MemWalMock>();
  failWrites = false;
  memory(creds: MemwalCreds): Memory {
    if (creds.key === BAD_KEY) {
      const fail = async () => {
        throw new MemoryAuthError("401 unauthorized");
      };
      return { remember: fail, recall: fail, learn: fail, verify: fail, count: fail };
    }
    let mock = this.mocks.get(creds.accountId);
    if (!mock) {
      mock = MemWalMock.create({ namespace: "octokeep" });
      this.mocks.set(creds.accountId, mock);
    }
    const inner = wrapMemwal(mock as unknown as MemwalLike, "octokeep");
    return {
      ...inner,
      remember: async (text) => {
        if (this.failWrites) throw new Error("relayer unavailable");
        return inner.remember(text);
      },
    };
  }
  async all(accountId = GOOD_ACCOUNT): Promise<string[]> {
    const mock = this.mocks.get(accountId);
    if (!mock) return [];
    const r = await mock.recall({ query: "save task outcome", limit: 100, namespace: "octokeep", maxDistance: 1.01 });
    return r.results.map((x) => x.text);
  }
}

// Scripted vision and speech models. Image bytes and audio bytes are the
// UTF-8 text the fake "reads", so a test can say what is in the picture.
export class FakeMedia implements Media {
  images: string[] = [];
  audio: { filename: string; mime: string }[] = [];
  failImages = false;
  readImage: Media["readImage"] = async (bytes: Uint8Array, mime: string) => {
    if (this.failImages) throw new Error("vision model unavailable");
    this.images.push(mime);
    return new TextDecoder().decode(bytes);
  };
  transcribe: Media["transcribe"] = async (bytes: Uint8Array, filename: string, mime: string) => {
    this.audio.push({ filename, mime });
    return new TextDecoder().decode(bytes);
  };
}

export function setup(opts: { now?: Date; llm?: Record<string, Handler>; fetch?: (url: string) => Promise<FetchResult>; media?: Media } = {}) {
  let now = opts.now ?? new Date("2026-10-02T10:00:00Z"); // a Friday
  const repo = new MemoryRepo(() => now);
  const out = new FakeOut();
  const mem = new FakeMemory();
  const llm = new FakeLlm(opts.llm ?? {});
  const logs: string[] = [];
  const media = opts.media ?? new FakeMedia();
  const deps: Deps = {
    repo,
    out,
    llm,
    memoryFor: (c) => mem.memory(c),
    fetchContent:
      opts.fetch ??
      (async (url) => ({
        ok: true,
        content: { title: "How to pass a cloud certification", text: "Start with the entry exam. Study daily. Book the exam on day one.", source: "YouTube", url },
      })),
    now: () => now,
    adminIds: new Set([1]),
    envCreds: { accountId: GOOD_ACCOUNT, key: GOOD_KEY },
    media,
    // Albums wait for their other photos; tests move the clock instead.
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    log: (m, e) => logs.push(`${m} ${e ?? ""}`),
  };
  let msgId = 1;
  const user = { userId: 1, chatId: 1, firstName: "Stephen" };
  const say = (text: string) => handleMessage(deps, { ...user, messageId: ++msgId, text }).then(() => msgId);
  const tap = (data: string, messageId = out.last().id) => handleCallback(deps, { ...user, messageId, data });
  // Sends a photo, video or voice message whose "content" is `content`.
  const send = (kind: IncomingMedia["kind"], content: string, extra: Partial<IncomingMedia> = {}) =>
    handleMedia(deps, {
      ...user,
      messageId: ++msgId,
      kind,
      mime: kind === "image" ? "image/jpeg" : kind === "voice" ? "audio/ogg" : "video/mp4",
      caption: "",
      download: async () => new TextEncoder().encode(content),
      ...extra,
    }).then(() => msgId);
  const setNow = (d: Date) => {
    now = d;
  };
  return { deps, repo, out, mem, llm, logs, media, say, send, tap, setNow, user };
}

// Gets a user through /start, timezone and /connect.
export async function onboard(t: ReturnType<typeof setup>, zone = "Lagos") {
  await t.say("/start");
  await t.say(zone);
  await t.say(GOOD_ACCOUNT);
  await t.say(GOOD_KEY);
}

export const summaryFake = () => ({
  title: "Pass your first cloud certification",
  summary: "Start with the entry-level exam, study 45 minutes a day for four weeks, and book the exam on day one.",
  actions: [
    { text: "Book the exam for four weeks from now", effort: "small" },
    { text: "Finish module 1 of the free course", effort: "medium" },
  ],
  connection: null,
});
