import "./env.js";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm/llm.js";
import { RouteSchema, routePrompt, SummarySchema, summaryPrompt } from "../src/llm/prompts.js";
import { calendarContext, localNow } from "../src/time.js";

// Runs the two calls OctoKeep depends on most (summarise a post, classify a
// message) against each model and reports how often the reply was valid,
// how often the classification was right, and how long it took.
//
//   npm run eval
//   EVAL_MODELS=openai/gpt-oss-120b,qwen/qwen3.8-27b npm run eval

const c = loadConfig();
const models = (process.env.EVAL_MODELS ?? `${c.llm.model},qwen/qwen3.8-27b`).split(",").map((m) => m.trim()).filter(Boolean);

const posts = [
  ["How to pass your first cloud certification", "Start with the entry-level exam. Study 45 minutes a day for four weeks using the free official course. Book the exam on day one so the date is real. Take one practice test in week three and review every wrong answer."],
  ["5 things to do before a tech interview", "Research the company's product and recent news. Practise answering out loud, not in your head. Prepare two questions about the team. Test your camera and mic the night before. Send a short thank-you note within a day."],
  ["Budget in three steps", "List your monthly income. Write down fixed costs like rent and transport. Pick one category to cut by 20 percent this month, and move that money to savings on payday so you never see it."],
  ["Learn Rust ownership in a weekend", "Read chapter 4 of the Rust Book on Saturday morning. Write a small CLI that reads a file and counts words. Fight the borrow checker on purpose: pass references, then try to mutate them, and read every error."],
  ["Morning routine that stuck", "Wake at the same time every day, weekends too. No phone for the first 30 minutes. Drink water, walk for ten minutes outside, then write the one task that matters most today."],
  ["Grow on X as a developer", "Post one thing you learned every weekday. Reply to five people bigger than you with something useful. Share screenshots of real work, not motivation. Pin a thread of your best projects."],
  ["Meal prep for a busy week", "Cook rice and beans in bulk on Sunday. Roast two trays of vegetables. Portion into five boxes. Keep sauces separate so food does not go soggy. Freeze two portions for Thursday and Friday."],
  ["Ship a side project in 30 days", "Pick a problem you have yourself. Write the one-sentence pitch first. Build the smallest version in two weeks. Show it to ten people in week three. Fix the top complaint and launch in week four."],
  ["Sleep better tonight", "Keep the room cool and dark. Stop caffeine after 2pm. Put the phone outside the bedroom. If you cannot sleep after 20 minutes, get up and read something boring until you feel tired."],
  ["Negotiate your first salary", "Find the range for the role on two salary sites. Never give the first number. When they offer, pause, thank them, and ask if there is flexibility. Ask for the offer in writing before you accept."],
] as const;

const messages: [string, "task" | "question" | "content" | "chat"][] = [
  ["I want to build an app on Thursday, remind me", "task"],
  ["remind me to call mum tomorrow evening", "task"],
  ["apply for the Andela job on Monday at 9am", "task"],
  ["what did I save about Rust?", "question"],
  ["what have I been ignoring?", "question"],
  ["what did I plan for this week", "question"],
  ["hi", "chat"],
  ["thanks, that was helpful", "chat"],
  ["gym on saturday morning, remind me", "task"],
  ["did I save anything about budgeting?", "question"],
];

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
const now = new Date();
const rows: string[] = [];

for (const model of models) {
  const llm = createLlm({ ...c.llm, model });
  let summaryOk = 0;
  let routeOk = 0;
  let routeRight = 0;
  const times: number[] = [];
  for (const [title, text] of posts) {
    const t = Date.now();
    try {
      const p = summaryPrompt({ title, text, source: "Eval" }, []);
      const s = await llm.json("summary", SummarySchema, p.system, p.prompt);
      if (s.actions.length > 0) summaryOk++;
    } catch (e) {
      console.log(`  ${model} summary "${title}": ${String((e as Error).message).slice(0, 120)}`);
    }
    times.push(Date.now() - t);
  }
  for (const [text, expected] of messages) {
    const t = Date.now();
    try {
      const p = routePrompt(text, localNow(now, "Africa/Lagos"), calendarContext(now, "Africa/Lagos"));
      const r = await llm.json("route", RouteSchema, p.system, p.prompt);
      routeOk++;
      if (r.type === expected) routeRight++;
      else console.log(`  ${model} route "${text}": got ${r.type}, expected ${expected}`);
    } catch (e) {
      console.log(`  ${model} route "${text}": ${String((e as Error).message).slice(0, 120)}`);
    }
    times.push(Date.now() - t);
  }
  const row = `| ${model} | ${summaryOk}/${posts.length} | ${routeOk}/${messages.length} | ${routeRight}/${messages.length} | ${median(times)} ms |`;
  console.log(row);
  rows.push(row);
}

const table = [
  `Run on ${now.toISOString().slice(0, 10)} with provider ${c.llm.provider}.`,
  "",
  "| Model | Valid summaries | Valid classifications | Correct classifications | Median latency |",
  "|---|---|---|---|---|",
  ...rows,
].join("\n");
writeFileSync("docs/EVAL.md", `# Model eval\n\nProduced by \`npm run eval\` (scripts/eval.ts).\n\n${table}\n`);
console.log(`\n${table}\n\nWritten to docs/EVAL.md`);
