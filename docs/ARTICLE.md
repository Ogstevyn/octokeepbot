# I built a bot that remembers what I saved and asks if I did it

I save a lot of posts. Study plans, coding tutorials, "5 things to do before your interview". I almost never act on them. So for Walrus Sessions 8 I built OctoKeep, a Telegram bot that keeps what I save in my own Walrus Memory and keeps asking until I do something with it.

## What it does

You send OctoKeep a link. It reads the page or video transcript, sends back a short summary and a few concrete actions, asks whether you plan to act on it, and asks when to check back (two days by default). Then it comes back and asks if you did it. One tap answers, and the answer goes into memory too.

It also takes tasks. "I want to build an app on Thursday, remind me" gets up to three short questions (what app, what tools, what is the first step), and on Thursday morning a plan arrives. And you can ask it things: "what have I been ignoring?" or "what did I save about Rust?"

Instagram cannot be read by a server, so OctoKeep also accepts a screenshot of the post, which a vision model reads, or a screen recording of a Reel, which Whisper transcribes. Voice notes work anywhere you would type.

## Where memory lives

The first design question was what goes into Walrus Memory and what does not. Recall is semantic search. It is very good at "what do I know about this person that relates to this post", and useless for "what is due at 09:00 today". So there are two stores with two jobs.

Postgres (Neon) is only the schedule: item ids, due times, statuses. Its text is encrypted.

Walrus Memory holds everything OctoKeep knows about me, in my own account under the namespace `octokeep`. Each save is one line (`[SAVE] title | summary | actions | intent | check back`), each task one line, and each outcome one line (`[OUTCOME] done "Pass your first cloud certification"`). When I mention something lasting in chat, like "I'm learning Rust", the relayer's `analyze()` extracts it as a fact.

Each user connects their own account. They create a delegate key in the Walrus Memory dashboard, send the account ID and key to the bot, and OctoKeep deletes the message, verifies the key against the relayer and stores it encrypted. Deleting that key in the dashboard cuts the bot off at once, and the memories stay with the user.

## What memory changed

Before memory, a reminder could only say "You saved X two days ago. Did you do it?" That is a to-do app, and I ignore to-do apps.

With memory, every summary, reminder and plan first recalls related lines. If you save a long course after dropping two others, the summary points that out and the reminder asks only for the first module. If you set "build the budget app on Thursday", the plan pulls in the budgeting post you saved the week before. "What have I been ignoring?" is answered from outcomes, not from a list of open rows. Memory has to change what the bot says, or it is just storage.

[Replace with one real exchange from your own use, quoted from Telegram.]

## What was hard

Writes are slow. On mainnet a `remember` plus wait took about 45 seconds in my test, while recall took under 2. A chat reply cannot wait for that, so writes go into a Postgres outbox, the user gets an answer immediately, and the scheduler retries anything that failed. No save is lost to a relayer hiccup.

Reminders need a clock. A Vercel function runs every 15 minutes, claims due items with a lease so two runs never send the same reminder, and recalls memory to word each one.

I also found a few things in the SDK. The one I'd most want fixed: since 0.1.8 the client derives its idempotency key from the text and a 30-minute window, so re-stating a fact within half an hour (a preference that flips back, a habit logged twice) is silently collapsed onto the earlier write, and a recency-sorted recall then returns the stale value. The mock does not model this, so tests pass while production drops the write. I filed it with a reproduction: [issue link].

## Numbers

[N] people used OctoKeep over [D] days, storing [M] memories in their own accounts, the smallest account holding [K]. The models are open-weight and run on Groq: [text model] for summaries and routing, Qwen 3.8 for screenshots, Whisper for recordings.

The code is open source at github.com/Ogstevyn/octobot, and the bot is at t.me/OctoKeep_bot.
