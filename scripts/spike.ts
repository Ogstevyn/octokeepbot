import "./env.js";
import { MemWal } from "@mysten-incubation/memwal";
import { neon } from "@neondatabase/serverless";
import { Bot } from "grammy";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm/llm.js";
import { SummarySchema, summaryPrompt } from "../src/llm/prompts.js";
import { fetchContent } from "../src/sources/index.js";

// Checks every external dependency with the values in .env and prints what
// worked. Never prints a secret.
const results: { step: string; ok: boolean; detail: string; ms: number }[] = [];
async function step(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail, ms: Date.now() - t });
  } catch (e) {
    results.push({ step: name, ok: false, detail: String((e as Error).message ?? e).slice(0, 300), ms: Date.now() - t });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step} (${r.ms} ms)  ${r.detail}`);
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

for (const url of ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://paulgraham.com/greatwork.html", "https://www.reddit.com/r/learnprogramming/top/"]) {
  await step(`fetch ${new URL(url).hostname}`, async () => {
    const r = await fetchContent(url);
    if (!r.ok) throw new Error(`${r.reason} (${r.source})`);
    return `"${r.content.title.slice(0, 60)}", ${r.content.text.length} chars`;
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
