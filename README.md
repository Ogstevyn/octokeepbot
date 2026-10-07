# OctoKeep

A Telegram bot that reads what you save, remembers it in your own Walrus Memory account, and checks back until you act on it.

- Send a link to a video, article or post. OctoKeep summarises it so you do not have to watch it, lists the actions in it, asks what you plan to do, and comes back after the gap you choose (2 days by default) to ask whether you did it.
- Say "I want to build an app on Thursday, remind me". OctoKeep confirms the time, asks up to three short questions, and on Thursday sends an organised plan.
- Ask "what have I been ignoring?" or "what did I save about Rust?" and it answers from your memory.
- Send a screenshot or a screen recording instead of a link. A vision model reads the screenshot (several sent together become one summary) and a speech model transcribes the recording. Voice messages work anywhere you would type.

Bot: [t.me/OctoKeep_bot](https://t.me/OctoKeep_bot). Landing page: `site/`, hosted on Walrus Sites (see `docs/WALRUS_SITES.md`).

## How memory is used

Walrus Memory and Postgres do different jobs.

- **Walrus Memory** holds what OctoKeep knows about you, in your own account and namespace `octokeep`: one line per saved post (`[SAVE] ...`), task (`[TASK] ...`) and outcome (`[OUTCOME] ...`), plus facts the relayer extracts from what you tell it. Every summary, nudge, task plan and answer recalls from it, so a reminder can say "last time you skipped a long course; start with the first step" and a task plan can pull in a post you saved about the same tool.
- **Postgres** is only the schedule: which item is due when, and its status. Recall is semantic search, so it cannot answer "what is due at 09:00"; the database can. Item text, pending conversation state and your Walrus Memory credentials are encrypted with `APP_ENCRYPTION_KEY` before they are written.

Each user connects their own account with `/connect`: the Account ID and a delegate key they create for OctoKeep. The bot deletes the message holding the key, checks it against the relayer, and stores it encrypted. Deleting that key in the Walrus Memory dashboard cuts OctoKeep off immediately; the memories stay in the user's account.

If a memory write fails it is queued and retried by the scheduler, so a relayer hiccup never loses a save.

## Stack

TypeScript on Node 20+, [grammY](https://grammy.dev) for Telegram, `@mysten-incubation/memwal` for Walrus Memory, the Vercel AI SDK with any OpenAI-compatible model (Groq, OpenRouter, OpenAI or a local Ollama), a vision model and Whisper on the same API for screenshots and recordings, Neon Postgres, Luxon for timezones, Readability for articles. Deployed as Vercel functions: `api/telegram.ts` (webhook), `api/cron/tick.ts` (scheduler), `api/health.ts`.

## Run it locally

You need Node 20 or newer, a bot token from @BotFather, a Walrus Memory account with a delegate key, a model API key (a free Groq key works), and a Neon database (or `DATABASE_URL=memory` to try it without one).

```bash
npm install
cp .env.example .env      # then fill it in
npm run spike             # checks Telegram, Postgres, the model and Walrus Memory with your values
npm run migrate           # creates the tables
npm run dev               # runs the bot with long polling and the scheduler every minute
```

Open the bot in Telegram and send `/start`. Put your own Telegram id in `ADMIN_TELEGRAM_IDS` to use `/connect env` (connects with the credentials in `.env`) and `/jump 2d` (runs the scheduler two days ahead, for demos).

`npm run dev` removes any webhook, because Telegram delivers updates to a webhook or to polling, never both. Run `npm run set-webhook` again before relying on the deployed bot.

## Deploy

1. Import the repository into Vercel. No build command is needed; `vercel.json` serves `site/` as a static mirror and `api/` as functions.
2. Add every variable from `.env.example` in Project Settings, Environment Variables. `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET` are required in production.
3. Deploy, then point Telegram at it and register the command menu:
   ```bash
   npm run set-webhook -- https://your-project.vercel.app
   ```
4. Schedule the reminders. On cron-job.org create a job every minute that calls
   `https://your-project.vercel.app/api/cron/tick?secret=<CRON_SECRET>`.
   Reminders fire on the first run after they are due, so the interval is how late a reminder can be;
   users can pick check-back times like "5 min", so every minute keeps them on time.
   (Vercel Cron also works on paid plans; it sends the secret as a Bearer header, which the endpoint accepts.)
5. Check `https://your-project.vercel.app/api/health`.

For a demo without waiting days, call the tick endpoint with a future time, which sends whatever would be due then:
`/api/cron/tick?secret=<CRON_SECRET>&now=2026-10-08T08:00:00Z&user=<telegram id>`.

## Evidence and reproduction scripts

- `npm run stats` prints, for every user, how many memories their Walrus Memory account holds in the `octokeep` namespace (via `listNamespaces`), with Telegram ids replaced by labels.
- `npm run eval` runs summaries and message classification against one or more models and writes `docs/EVAL.md`. Set `EVAL_MODELS` to a comma-separated list.
- `npm run repro` reproduces the SDK issues in `docs/FINDINGS.md`; add `-- --live` to run the relayer check against your own account.

## Tests

```bash
npm run check   # type check, tests, and the site sync check
```

The tests drive full conversations through the bot logic with the SDK's `MemWalMock`, an in-memory store and a scripted model: onboarding and key deletion, the save, nudge and outcome loop, backoff to `/ignored`, tasks across timezones, rescheduling, overlapping scheduler runs, blocked users, retried memory writes, HTML escaping and model failures.

## Limits

- Instagram, Facebook and Threads posts are not fetched; those platforms forbid scraping, and Instagram's embed API needs Meta app review and does not return the caption. Send a screenshot (tap "more" first so the whole caption shows) or a screen recording instead. X and TikTok use their public oEmbed endpoints.
- Screenshots work for posts with text: captions, carousels, text on the image. A photo with no text has nothing to summarise unless you add a caption saying what to remember.
- Recordings need speech. Telegram lets bots download files up to 20 MB, which is roughly two minutes of screen recording.
- YouTube often blocks transcript requests from cloud servers. When it does, OctoKeep asks you to paste the description or key points.
- Times are understood in the timezone you pick in `/start`; change it with `/timezone`.

## Commands

`/start` `/list` `/tasks` `/ignored` `/memory` `/gap` `/done <n>` `/timezone` `/connect` `/disconnect` `/help` `/cancel`
