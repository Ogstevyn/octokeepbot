import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { z } from "zod";

export interface Llm {
  // Returns JSON validated against the schema. `task` names the call so tests
  // and logs can tell calls apart.
  json<T>(task: string, schema: z.ZodType<T>, system: string, prompt: string): Promise<T>;
  text(task: string, system: string, prompt: string): Promise<string>;
}

export class LlmError extends Error {}

// Models wrap JSON in prose or code fences often enough that we extract the
// first balanced object instead of trusting the raw reply.
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1]! : raw;
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unbalanced JSON object in reply");
}

export function createLlm(opts: { baseURL: string; apiKey: string; model: string; provider: string }): Llm {
  const provider = createOpenAICompatible({ name: opts.provider, baseURL: opts.baseURL, apiKey: opts.apiKey });
  const model = provider(opts.model);

  const call = async (system: string, prompt: string, temperature: number) => {
    const res = await generateText({ model, system, prompt, temperature, maxOutputTokens: 1200, maxRetries: 2, abortSignal: AbortSignal.timeout(40_000) });
    return res.text;
  };

  return {
    async json(task, schema, system, prompt) {
      const sys = `${system}\n\nReply with one JSON object only. No prose, no code fences.`;
      let lastError = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const p = attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was not valid: ${lastError}. Reply again with a single JSON object that matches the format exactly.`;
        let raw = "";
        try {
          raw = await call(sys, p, 0.2);
          const parsed = schema.safeParse(extractJson(raw));
          if (parsed.success) return parsed.data;
          lastError = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
        } catch (e) {
          lastError = String((e as Error).message ?? e);
          if (!raw) throw new LlmError(`${task}: ${lastError}`);
        }
      }
      throw new LlmError(`${task}: model did not return valid JSON (${lastError})`);
    },
    async text(task, system, prompt) {
      try {
        return (await call(system, prompt, 0.5)).trim();
      } catch (e) {
        throw new LlmError(`${task}: ${String((e as Error).message ?? e)}`);
      }
    },
  };
}
