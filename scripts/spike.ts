import "./env.js";
import { MemWal } from "@mysten-incubation/memwal";
import { neon } from "@neondatabase/serverless";
import { Bot } from "grammy";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm/llm.js";
import { SummarySchema, summaryPrompt } from "../src/llm/prompts.js";
import { fetchContent } from "../src/sources/index.js";
import { createMedia } from "../src/media/media.js";
import { deflateSync } from "node:zlib";

// Checks every external dependency with the values in .env and prints what
// worked. Never prints a secret.
const results: { step: string; ok: boolean; detail: string; ms: number; optional?: boolean }[] = [];
async function step(name: string, fn: () => Promise<string>, optional = false) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail, ms: Date.now() - t });
  } catch (e) {
    results.push({ step: name, ok: false, detail: String((e as Error).message ?? e).slice(0, 300), ms: Date.now() - t, optional });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? "PASS" : optional ? "WARN" : "FAIL"}  ${r.step} (${r.ms} ms)  ${r.detail}`);
}

let c: ReturnType<typeof loadConfig> | undefined;
await step("config", async () => {
  c = loadConfig();
  return `llm=${c.llm.provider}/${c.llm.model} relayer=${c.MEMWAL_SERVER_URL} namespace=${c.MEMWAL_NAMESPACE}`;
});
if (!c) process.exit(1);
const cfg = c;

await step("telegram getMe", async () => {
  const me = await new Bot(cfg.TELEGRAM_BOT_TOKEN).api.getMe();
  const hook = await new Bot(cfg.TELEGRAM_BOT_TOKEN).api.getWebhookInfo();
  return `@${me.username}, webhook ${hook.url || "not set"}`;
});

await step("postgres", async () => {
  if (cfg.DATABASE_URL === "memory") return "using in-memory store";
  const sql = neon(cfg.DATABASE_URL);
  const rows = (await sql.query("SELECT version() AS v, to_regclass('public.items') AS items")) as { v: string; items: string | null }[];
  return `${rows[0]!.v.split(" ").slice(0, 2).join(" ")}, schema ${rows[0]!.items ? "present" : "missing, run npm run migrate"}`;
});

const llm = createLlm(cfg.llm);
await step("llm list models", async () => {
  const res = await fetch(`${cfg.llm.baseURL.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${cfg.llm.apiKey}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  const ids = (data.data ?? []).map((m) => m.id);
  return `${ids.length} models; configured model ${ids.includes(cfg.llm.model) ? "is available" : "NOT in list"}; sample: ${ids.filter((i) => /llama|qwen|gpt-oss|deepseek|gemma|mistral|kimi/i.test(i)).slice(0, 12).join(", ")}`;
});
await step("llm summary JSON", async () => {
  const p = summaryPrompt(
    { title: "How to pass your first cloud certification", source: "Test", text: "Start with the entry-level exam. Study 45 minutes a day for four weeks using the free official course. Book the exam on day one so the date is real. Take one practice test in week three and review every wrong answer." },
    [],
  );
  const s = await llm.json("summary", SummarySchema, p.system, p.prompt);
  return `title "${s.title}", ${s.actions.length} actions`;
});

// Screenshots and screen recordings. Optional: without them the bot asks for
// pasted text instead.
const media = createMedia({ baseURL: cfg.llm.baseURL, apiKey: cfg.llm.apiKey, ...cfg.media });
if (media.readImage) {
  await step(
    `vision ${cfg.media.visionModel}`,
    async () => {
      const text = await media.readImage!(testPng(), "image/png");
      return `replied with ${text.length} chars`;
    },
    true,
  );
} else console.log("SKIP  vision: no VISION_MODEL for this provider");
if (media.transcribe) {
  await step(
    `transcribe ${cfg.media.transcribeModel}`,
    async () => {
      const text = await media.transcribe!(testWav(), "test.wav", "audio/wav");
      return `endpoint works (${text.length} chars from a second of tone)`;
    },
    true,
  );
} else console.log("SKIP  transcribe: no TRANSCRIBE_MODEL for this provider");

if (cfg.MEMWAL_PRIVATE_KEY && cfg.MEMWAL_ACCOUNT_ID) {
  const mw = MemWal.create({ key: cfg.MEMWAL_PRIVATE_KEY, accountId: cfg.MEMWAL_ACCOUNT_ID, serverUrl: cfg.MEMWAL_SERVER_URL, namespace: `${cfg.MEMWAL_NAMESPACE}-spike` });
  await step("memwal health", async () => {
    const h = await mw.health();
    return `status ${h.status}, relayer ${h.version}${h.write_ready === false ? ", writes NOT ready" : ""}`;
  });
  const marker = `spike-${Date.now()}`;
  await step("memwal remember + wait", async () => {
    const job = await mw.remember(`[SAVE] OctoKeep spike test ${marker} | summary: checking that memory works | intent: none`);
    await mw.waitForRememberJob(job.job_id, { timeoutMs: 120_000 });
    return `job ${job.job_id.slice(0, 8)}… stored`;
  });
  await step("memwal recall", async () => {
    const r = await mw.recall({ query: "OctoKeep spike test checking that memory works", limit: 3 });
    const hit = r.results.find((x) => x.text.includes(marker));
    if (!hit) throw new Error(`stored memory not found in ${r.results.length} results`);
    return `found it at distance ${hit.distance.toFixed(3)}`;
  });
} else {
  console.log("SKIP  memwal: set MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID to test it");
}

// Sites can block a given network, so these only warn: the bot asks the user
// to paste the text when a page cannot be read.
for (const url of ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://paulgraham.com/greatwork.html"]) {
  await step(
    `fetch ${new URL(url).hostname}`,
    async () => {
      const r = await fetchContent(url);
      if (!r.ok) throw new Error(`${r.reason} (${r.source})`);
      return `"${r.content.title.slice(0, 60)}", ${r.content.text.length} chars`;
    },
    true,
  );
}

const failed = results.filter((r) => !r.ok && !r.optional);
const warned = results.filter((r) => !r.ok && r.optional);
console.log(`\n${results.length - failed.length - warned.length}/${results.length} checks passed${warned.length ? `, ${warned.length} warning${warned.length > 1 ? "s" : ""}` : ""}${failed.length ? `, ${failed.length} failed` : ""}.`);
process.exit(failed.length ? 1 : 0);

// A 64x64 orange PNG, built by hand so the spike needs no image library.
function testPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const size = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [255, 106, 92]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// One second of a quiet 440 Hz tone as 16 kHz mono WAV.
function testWav(): Uint8Array {
  const rate = 16_000;
  const samples = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + samples.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(samples.length, 40);
  return Buffer.concat([h, samples]);
}
