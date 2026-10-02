import { MemWal } from "@mysten-incubation/memwal";
import type { MemwalCreds } from "../types.js";

export interface Recalled {
  text: string;
  distance: number;
  createdAt?: string;
}

// The slice of the MemWal SDK this bot uses. MemWal and MemWalMock both fit.
export interface MemwalLike {
  remember(text: string, namespace?: string): Promise<{ job_id: string }>;
  waitForRememberJob(jobId: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  recall(params: { query: string; limit?: number; maxDistance?: number; namespace?: string }): Promise<{ results: { text: string; distance: number; created_at?: string }[] }>;
  analyze(text: string, namespaceOrOptions?: string | { namespace?: string; occurredAt?: string | Date }): Promise<{ fact_count: number }>;
}

export interface Memory {
  // Resolves once the memory is stored on Walrus and searchable.
  remember(text: string): Promise<void>;
  recall(query: string, limit?: number): Promise<Recalled[]>;
  // Lets the relayer extract and store facts about the user from free text.
  learn(text: string, occurredAt: Date): Promise<number>;
  // Throws if the credentials cannot read this account.
  verify(): Promise<void>;
}

export class MemoryAuthError extends Error {}

// Recall results further than this are noise for our short memory lines.
const MAX_DISTANCE = 0.75;

const looksLikeAuth = (e: unknown) =>
  /\b(401|403)\b|unauthori[sz]ed|forbidden|not authori[sz]ed|invalid signature|delegate key|account not found|no such account/i.test(String((e as Error)?.message ?? e));

export function wrapMemwal(client: MemwalLike, namespace: string): Memory {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (looksLikeAuth(e)) throw new MemoryAuthError(String((e as Error)?.message ?? e));
      throw e;
    }
  };
  return {
    remember: (text) =>
      guard(async () => {
        const job = await client.remember(text, namespace);
        await client.waitForRememberJob(job.job_id, { timeoutMs: 90_000 });
      }),
    recall: (query, limit = 6) =>
      guard(async () => {
        const res = await client.recall({ query, limit, maxDistance: MAX_DISTANCE, namespace });
        return res.results.map((r) => ({ text: r.text, distance: r.distance, createdAt: r.created_at }));
      }),
    learn: (text, occurredAt) => guard(async () => (await client.analyze(text, { namespace, occurredAt })).fact_count),
    verify: () =>
      guard(async () => {
        await client.recall({ query: "OctoKeep connection check", limit: 1, namespace });
      }),
  };
}

const cache = new Map<string, Memory>();

export function memwalFor(creds: MemwalCreds, serverUrl: string, namespace: string): Memory {
  const k = `${creds.accountId}:${creds.key.slice(-8)}:${serverUrl}:${namespace}`;
  let m = cache.get(k);
  if (!m) {
    const client = MemWal.create({ key: creds.key, accountId: creds.accountId, serverUrl, namespace });
    m = wrapMemwal(client as unknown as MemwalLike, namespace);
    cache.set(k, m);
  }
  return m;
}

export function forgetMemwal(creds: MemwalCreds) {
  for (const k of cache.keys()) if (k.startsWith(`${creds.accountId}:`)) cache.delete(k);
}

// Short, labelled lines recall better than prose and read well when the
// relayer returns them inside an LLM prompt.
export const memoryLine = {
  save: (p: { title: string; url?: string; summary: string; actions: string[]; intent: string; when: string }) =>
    `[SAVE] ${p.title}${p.url ? ` | ${p.url}` : ""} | summary: ${p.summary} | actions: ${p.actions.join("; ")} | intent: ${p.intent} | check back: ${p.when}`,
  task: (p: { title: string; when: string; details: string[]; plan: string[] }) =>
    `[TASK] ${p.title} | due: ${p.when}${p.details.length ? ` | details: ${p.details.join("; ")}` : ""}${p.plan.length ? ` | plan: ${p.plan.join("; ")}` : ""}`,
  outcome: (p: { title: string; kind: string; result: string; note?: string; date: string }) =>
    `[OUTCOME] ${p.kind} "${p.title}" | ${p.result}${p.note ? ` | note: ${p.note}` : ""} | ${p.date}`,
};
