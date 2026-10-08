import { z } from "zod";
import type { Recalled } from "../memory/client.js";

const VOICE = "You are OctoKeep, a Telegram assistant that helps people act on what they save. Write plainly and briefly. No emoji, no hype, no filler.";

const memoriesBlock = (memories: Recalled[]) =>
  memories.length ? memories.map((m) => `- ${m.text}`).join("\n") : "(none)";

const nullableString = z.string().trim().min(1).nullable().catch(null);

// Routing --------------------------------------------------------------------

export const RouteSchema = z.object({
  type: z.enum(["task", "question", "content", "chat"]),
  title: nullableString.optional().default(null),
  date: nullableString.optional().default(null),
  time: nullableString.optional().default(null),
  hasPersonalFacts: z.boolean().catch(false).optional().default(false),
});
export type Route = z.infer<typeof RouteSchema>;

export const routePrompt = (text: string, localNow: string, calendar: string) => ({
  system: `${VOICE}
Classify the user's message.
- "task": they want to do something at a time, or ask to be reminded ("I want to build an app on Thursday, remind me", "call mum tomorrow evening", "remind me to apply for the job on Monday").
- "question": they ask about things they saved, planned or did ("what did I save about Rust?", "what have I been ignoring?", "what did I plan this week?").
- "content": a pasted article, caption or post text (usually long) to summarise.
- "chat": anything else.
For "task" also return:
- title: a short imperative title, e.g. "Build the budget tracker app"
- date: YYYY-MM-DD using the calendar below, or null if no day was given
- time: HH:mm (24h) if a time was given ("9am" -> "09:00", "evening" -> "19:00", "morning" -> "09:00"), else null
Set hasPersonalFacts to true only if the message states lasting facts about the user (goals, job, skills, preferences).
Format: {"type": "...", "title": string|null, "date": string|null, "time": string|null, "hasPersonalFacts": boolean}`,
  prompt: `Local time now: ${localNow}
Calendar:
${calendar}

Message:
"""${text.slice(0, 4000)}"""`,
});

// When the user answers "when?" for a task ------------------------------------

export const WhenSchema = z.object({
  date: nullableString.optional().default(null),
  time: nullableString.optional().default(null),
});

export const whenPrompt = (text: string, localNow: string, calendar: string) => ({
  system: `${VOICE}
Extract a day and time from the user's reply. date: YYYY-MM-DD using the calendar, or null. time: HH:mm 24h, or null.
Format: {"date": string|null, "time": string|null}`,
  prompt: `Local time now: ${localNow}
Calendar:
${calendar}

Reply: """${text.slice(0, 500)}"""`,
});

// Summarising a post ----------------------------------------------------------

export const SummarySchema = z.object({
  title: z.string().trim().min(1).max(140),
  summary: z.string().trim().min(1),
  actions: z
    .array(z.object({ text: z.string().trim().min(1), effort: z.enum(["small", "medium", "large"]).catch("medium") }))
    .min(1)
    .max(5),
  connection: nullableString.optional().default(null),
});
export type Summary = z.infer<typeof SummarySchema>;

export const summaryPrompt = (content: { title: string; text: string; source: string; url?: string }, memories: Recalled[]) => ({
  system: `${VOICE}
Summarise the content so the user does not need to watch or read it.
- title: a clear title, at most 80 characters.
- summary: at most 90 words, concrete, keeps the specific numbers, names and steps that matter.
- actions: 1 to 5 concrete things the user could do because of this content, each starting with a verb, each with effort small (under an hour), medium (a few hours) or large (days).
- connection: one sentence linking this to something in the user's memory below, only if there is a real link; otherwise null. Never invent facts about the user.
Text read from screenshots or transcribed from a recording can be rough: summarise the post itself, use comments only when they add something, and ignore leftover app text.
Format: {"title": string, "summary": string, "actions": [{"text": string, "effort": "small"|"medium"|"large"}], "connection": string|null}`,
  prompt: `What the user already has in memory:
${memoriesBlock(memories)}

Source: ${content.source}${content.url ? ` (${content.url})` : ""}
Title: ${content.title}
Content:
"""${content.text.slice(0, 14000)}"""`,
});

// Tasks -----------------------------------------------------------------------

export const QuestionsSchema = z.object({ questions: z.array(z.string().trim().min(3)).max(3) });

export const questionsPrompt = (title: string, raw: string) => ({
  system: `${VOICE}
The user set a task. Ask up to 3 short questions whose answers would make the reminder genuinely useful when the time comes, for example what exactly it is, which tools or people are involved, and what the first step is.
Skip anything the message already answers. Ask fewer questions for simple tasks (a call or an errand may need 0 or 1). Each question under 12 words.
Format: {"questions": [string]}`,
  prompt: `Task: ${title}
Original message: """${raw.slice(0, 1000)}"""`,
});

export const PlanSchema = z.object({ plan: z.array(z.string().trim().min(3)).min(1).max(6) });

export const planPrompt = (title: string, details: { question: string; answer: string }[], memories: Recalled[]) => ({
  system: `${VOICE}
Write a short ordered plan the user can follow when this task comes up: 2 to 6 steps, each starting with a verb, each under 15 words. Use the details given. Use the user's memories only when they are clearly relevant (for example a saved post about the same tool).
Format: {"plan": [string]}`,
  prompt: `Task: ${title}
Details:
${details.length ? details.map((d) => `- ${d.question} ${d.answer}`).join("\n") : "(none)"}

Relevant memories:
${memoriesBlock(memories)}`,
});

// Replies to nudges -------------------------------------------------------------

export const OutcomeSchema = z.object({
  result: z.enum(["done", "partial", "not_yet", "drop", "snooze", "unclear"]),
  snoozeDays: z.number().int().min(1).max(60).nullable().catch(null).optional().default(null),
  note: nullableString.optional().default(null),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const outcomePrompt = (title: string, intent: string | undefined, reply: string) => ({
  system: `${VOICE}
The user was asked whether they acted on something. Classify their reply.
- done: they did it.
- partial: they did some of it.
- not_yet: not yet but still want to.
- snooze: they ask to be reminded later; set snoozeDays if they name a time ("next week" = 7).
- drop: they no longer want to do it.
- unclear: anything else.
note: a short paraphrase of what they said that is worth remembering, or null.
Format: {"result": "...", "snoozeDays": number|null, "note": string|null}`,
  prompt: `Item: ${title}
They had said: ${intent ?? "(nothing)"}
Their reply: """${reply.slice(0, 1000)}"""`,
});

export const nudgeLinePrompt = (title: string, intent: string | undefined, memories: Recalled[]) => ({
  system: `${VOICE}
Write one short sentence (under 25 words) to add to a reminder about the item below, using what the user's memory says about how they handled similar things or about their goals. If nothing in memory is relevant, reply with exactly: NONE`,
  prompt: `Item: ${title}
They had said: ${intent ?? "(nothing)"}

Memory:
${memoriesBlock(memories)}`,
});

// Questions about their own memory ----------------------------------------------

export const answerPrompt = (question: string, memories: Recalled[], openItems: string[], localNow: string) => ({
  system: `${VOICE}
Answer the user's question using only their memories and their current list below. Lines starting [SAVE] are posts they saved, [TASK] are tasks they set, [OUTCOME] records what they did or skipped. If the answer is not there, say so in one sentence. Keep it under 120 words. Plain text, short lines.`,
  prompt: `Local time now: ${localNow}

Their memories (most relevant first):
${memoriesBlock(memories)}

Their current open and quiet items:
${openItems.length ? openItems.join("\n") : "(none)"}

Question: """${question.slice(0, 1000)}"""`,
});

export const chatPrompt = (text: string) => ({
  system: `${VOICE}
The user sent a message that is not a link, a task or a question about their memory. Reply in one or two sentences. If it helps, mention that they can send a link to summarise or tell you something they want to do and when.`,
  prompt: text.slice(0, 1500),
});

// Learning paths and topics -------------------------------------------------------

export const PathSchema = z.object({
  title: z.string().trim().min(3).max(80),
  steps: z
    .array(z.object({ text: z.string().trim().min(3).max(200), from: nullableString.optional().default(null) }))
    .min(2)
    .max(8),
});

export const pathPrompt = (topic: string, saves: string[]) => ({
  system: `${VOICE}
The user saved the posts below about a topic. Turn them into one ordered learning path: 3 to 8 steps, from basics to advanced, each starting with a verb and under 20 words. For each step, "from" is the exact title of the saved post it draws on, or null. Use only these saves; do not invent resources.
Format: {"title": string, "steps": [{"text": string, "from": string | null}]}`,
  prompt: `Topic: ${topic.slice(0, 100)}

Saved posts:
${saves.map((s) => `- ${s}`).join("\n")}`,
});

export const TopicsSchema = z.object({
  topics: z
    .array(z.object({ name: z.string().trim().min(2).max(40), ids: z.array(z.number().int()).min(1) }))
    .min(1)
    .max(8),
});

export const topicsPrompt = (items: { id: number; title: string }[]) => ({
  system: `${VOICE}
Group the user's saved posts into 2 to 8 topics with short names (1 to 3 words, like "Video editing" or "Sui"). Every id goes in exactly one topic. Put stragglers in "Other".
Format: {"topics": [{"name": string, "ids": [number]}]}`,
  prompt: items.map((i) => `${i.id}: ${i.title}`).join("\n"),
});
