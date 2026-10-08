import { z } from "zod";

const MAINNET_RELAYER = "https://relayer.memory.walrus.xyz";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20, "TELEGRAM_BOT_TOKEN is missing"),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, "TELEGRAM_WEBHOOK_SECRET must be 16-256 letters, digits, _ or -").optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is missing"),
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "APP_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)"),
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters").optional(),

  MEMWAL_SERVER_URL: z.string().url().default(MAINNET_RELAYER),
  MEMWAL_NAMESPACE: z.string().min(1).default("octokeep"),
  // Owner credentials, used only by /connect env for admins and by the spike.
  MEMWAL_PRIVATE_KEY: z.string().optional(),
  MEMWAL_ACCOUNT_ID: z.string().optional(),

  LLM_PROVIDER: z.enum(["openai-compatible", "groq", "openrouter", "openai", "ollama"]).default("groq"),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  // Screenshots and screen recordings. "off" disables either one.
  VISION_MODEL: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().optional(),
  OLLAMA_HOST: z.string().default("http://localhost:11434"),

  ADMIN_TELEGRAM_IDS: z.string().optional(),
  // Used in buddy invite links (t.me/<username>?start=...).
  TELEGRAM_BOT_USERNAME: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9_]{5,32}$/).default("OctoKeep_bot")),
});

export type Config = z.infer<typeof schema> & {
  adminIds: Set<number>;
  llm: { baseURL: string; apiKey: string; model: string; provider: string };
  media: { visionModel: string | null; transcribeModel: string | null };
};

const defaults: Record<string, { baseURL: string; model: string; vision: string; transcribe: string }> = {
  groq: { baseURL: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", vision: "qwen/qwen3.8-27b", transcribe: "whisper-large-v3-turbo" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct", vision: "", transcribe: "" },
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini", vision: "gpt-4o-mini", transcribe: "whisper-1" },
  ollama: { baseURL: "", model: "llama3.1", vision: "", transcribe: "" },
  "openai-compatible": { baseURL: "", model: "", vision: "", transcribe: "" },
};

const mediaModel = (value: string | undefined, fallback: string) => {
  if (value?.toLowerCase() === "off") return null;
  return value ?? (fallback || null);
};

let cached: Config | undefined;

// Empty strings in .env mean "not set", so they fall back to defaults.
const clean = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "").map(([k, v]) => [k, v!.trim()]));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(clean(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${problems}`);
  }
  const c = parsed.data;
  const d = defaults[c.LLM_PROVIDER]!;
  const baseURL = c.LLM_BASE_URL ?? (c.LLM_PROVIDER === "ollama" ? `${c.OLLAMA_HOST.replace(/\/+$/, "")}/v1` : d.baseURL);
  const model = c.LLM_MODEL ?? d.model;
  // A pasted API key in the model field is an easy slip, and the model name is
  // printed in logs and /api/health, so refuse it rather than leak it.
  if (/^(gsk_|sk-|sk_|AIza|or-)/.test(model) || (model.length > 40 && !/[\/:.-]/.test(model))) {
    throw new Error("Invalid environment:\n  LLM_MODEL looks like an API key. Put the key in LLM_API_KEY and a model name (or nothing) in LLM_MODEL");
  }
  if (!baseURL) throw new Error("Invalid environment:\n  LLM_BASE_URL is required when LLM_PROVIDER is openai-compatible");
  if (!model) throw new Error("Invalid environment:\n  LLM_MODEL is required when LLM_PROVIDER is openai-compatible");
  const apiKey = c.LLM_API_KEY ?? (c.LLM_PROVIDER === "ollama" ? "ollama" : "");
  if (!apiKey) throw new Error(`Invalid environment:\n  LLM_API_KEY is required for LLM_PROVIDER=${c.LLM_PROVIDER}`);

  const media = { visionModel: mediaModel(c.VISION_MODEL, d.vision), transcribeModel: mediaModel(c.TRANSCRIBE_MODEL, d.transcribe) };

  const adminIds = new Set(
    (c.ADMIN_TELEGRAM_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  );
  return { ...c, adminIds, llm: { baseURL, apiKey, model, provider: c.LLM_PROVIDER }, media };
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
