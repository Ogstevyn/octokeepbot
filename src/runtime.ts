import type { Api } from "grammy";
import { config } from "./config.js";
import { MemoryRepo } from "./db/memory.js";
import { NeonRepo } from "./db/neon.js";
import type { Repo } from "./db/repo.js";
import { createLlm } from "./llm/llm.js";
import { createMedia } from "./media/media.js";
import { memwalFor } from "./memory/client.js";
import { fetchContent } from "./sources/index.js";
import type { Deps } from "./bot/core.js";
import { createBot, telegramOut } from "./bot/telegram.js";

const log: Deps["log"] = (message, extra) => console.error(`[octokeep] ${message}`, extra ?? "");

let repo: Repo | undefined;

export function getRepo(): Repo {
  const c = config();
  repo ??= c.DATABASE_URL === "memory" ? new MemoryRepo() : new NeonRepo(c.DATABASE_URL, c.APP_ENCRYPTION_KEY);
  return repo;
}

export function buildDeps(api: Api): Deps {
  const c = config();
  return {
    repo: getRepo(),
    out: telegramOut(api, log),
    llm: createLlm(c.llm),
    memoryFor: (creds) => memwalFor(creds, c.MEMWAL_SERVER_URL, c.MEMWAL_NAMESPACE),
    fetchContent,
    now: () => new Date(),
    adminIds: c.adminIds,
    media: createMedia({ baseURL: c.llm.baseURL, apiKey: c.llm.apiKey, ...c.media }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    envCreds: c.MEMWAL_PRIVATE_KEY && c.MEMWAL_ACCOUNT_ID ? { key: c.MEMWAL_PRIVATE_KEY, accountId: c.MEMWAL_ACCOUNT_ID } : null,
    log,
  };
}

let bot: ReturnType<typeof createBot> | undefined;
let deps: Deps | undefined;

// One bot per process; serverless instances reuse it across warm requests.
export function getBot() {
  if (!bot) {
    bot = createBot(config().TELEGRAM_BOT_TOKEN, (api) => (deps = buildDeps(api)));
  }
  return { bot, deps: deps! };
}
