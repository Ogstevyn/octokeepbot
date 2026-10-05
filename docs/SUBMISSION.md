# Walrus Sessions 8 submission kit

Deadline: 9 October 2026. Submit by 8 October to be safe.
Form: https://walform.wal.app/f?formId=0x09b022796f9cb7ce24247e3097c5c8ae2b414317c90c8aeb6ce335e7caf31ff5

## Requirements and where each one stands

| Requirement | Where it is met |
|---|---|
| Uses Walrus Memory (MemWal) on mainnet | `src/memory/client.ts`, mainnet relayer, each user's own account |
| Deployed somewhere real | Telegram bot t.me/OctoKeep_bot, backend on Vercel |
| At least 3 real users with 10+ memories each | `npm run stats` prints the count from each user's Walrus Memory account |
| Open-source repo with setup and local reproduction steps | github.com/Ogstevyn/octobot, README "Run it locally" |
| 500 to 800 word technical article | `docs/ARTICLE.md`, publish on dev.to and link it |
| Share on X tagging @WalrusProtocol with #WalrusMemory | post below |

Prize tracks: Best Chatbot, Beyond the Big Two (non-Claude/GPT model), Best Article, Bug Bounty (reproducible bug filed on MemWal GitHub), Promo Bounty.

## Form answers

**Project name:** OctoKeep

**Repository:** https://github.com/Ogstevyn/octobot

**Live app:** https://t.me/OctoKeep_bot (landing page: https://octokeep.wal.app)

**Model used:** Open-weight models on Groq. Text: the model in docs/EVAL.md that you settled on. Screenshots: qwen/qwen3.8-27b. Recordings and voice: whisper-large-v3-turbo. No Claude or GPT API.

**One bug:** Since SDK 0.1.8, `remember()` derives its idempotency key from the text plus a 30-minute bucket, so a fact the user re-states within 30 minutes (a preference that flips back, a habit logged twice) is silently collapsed onto the earlier write. The response is a normal 202 with the old job id, and `recall({ sort: "recent" })` then returns the stale value. MemWalMock does not model it, so tests pass while production drops the write. Repro: `npm run repro -- --live`. Issue: [link].

**One improvement:** Let `remember()` take structured tags (for example `kind: "outcome"`) and let `recall()` filter by them and by a time range. OctoKeep has to prefix every line with `[SAVE]`, `[TASK]` or `[OUTCOME]` and hope similarity search keeps them apart; "what did I finish this week" needs a filter, not a vector.

**Article:** [dev.to link]

**Users / memories:** paste the output of `npm run stats`.

## GitHub issue 1 (file at github.com/MystenLabs/MemWal/issues)

Search the issues for "idempotency" first. If it is already reported, add your reproduction as a comment instead.

Title: `remember(): identical text re-stated within 30 minutes is silently collapsed onto the earlier job`

```
SDK: @mysten-incubation/memwal 0.1.8 (TypeScript), mainnet relayer

Steps
1. const m = MemWal.create({ key, accountId, namespace: "repro-<timestamp>" })
2. await m.rememberAndWait("favourite drink: tea")
3. await m.rememberAndWait("favourite drink: coffee")
4. await m.rememberAndWait("favourite drink: tea")   // within 30 minutes of step 2
5. await m.recall({ query: "favourite drink", limit: 5, sort: "recent" })

Expected
Step 4 writes a new memory (or says it did not), and recall with sort "recent" returns "tea" first.

Actual
Step 4 returns the job id from step 2 and nothing new is written. Recall with sort "recent" returns "coffee" as newest. Nothing in the response shows the write was collapsed.

Cause
derivedIdempotencyKey() hashes a 30-minute time bucket + namespace + text when no idempotencyKey is passed, and the relayer returns the existing job for a known (owner, idempotency_key). This protects against retries but cannot distinguish a deliberate repeat. The window also depends on bucket edges: two identical calls seconds apart across a boundary both write.

MemWalMock stores all three, so tests built on the mock do not catch it.

Suggestion
Reuse a generated key only for retries of the same call (pendingRememberKeys already covers that within an instance), or return deduplicated: true in the accepted response, and document the window on remember().

Workaround
Pass a fresh idempotencyKey per intended write.

Full output of my run:
<paste the output of npm run repro -- --live>
```

## GitHub issue 2

Search the issues for "::1" first.

Title: `normalizeServerUrl warns about plaintext HTTP for http://[::1] (IPv6 loopback)`

```
SDK: @mysten-incubation/memwal 0.1.8 (TypeScript)

Steps
MemWal.create({ key, accountId, serverUrl: "http://[::1]:8000" })

Expected
No warning. The doc comment on normalizeServerUrl says ::1 is exempt, and http://localhost:8000 gives no warning.

Actual
[memwal] serverUrl "http://[::1]:8000" uses plaintext HTTP on a non-localhost host...

Cause
new URL("http://[::1]:8000").hostname is "[::1]" (with brackets), so host === "::1" in packages/sdk/src/utils.ts never matches. The Python SDK handles this correctly and has a test for http://[::1]:8000.

Fix
Also accept "[::1]" (or strip brackets before comparing).
```

## X post

```
I kept saving posts and never acting on them, so I built OctoKeep for #WalrusMemory Sessions 8.

Send it a link, a screenshot or a Reel recording. It summarises it, asks what you will do, and checks back until you do it. Everything it learns lives in your own @WalrusProtocol Memory account.

Bot: t.me/OctoKeep_bot
Code: github.com/Ogstevyn/octobot
```

Attach the demo video or 2 screenshots: a summary with actions, and a reminder that mentions something from earlier.

## Promo post (for communities: Discord servers, WhatsApp/Telegram dev groups, Reddit)

```
Walrus is running Sessions 8 until 9 October: build a chatbot with persistent memory using Walrus Memory. $2,500 in prizes, including a bug bounty that needs no chatbot, just a reproducible bug on GitHub.

Details: https://dev.to/walgo/walrus-sessions-8-building-chatbots-that-actually-remember-you-2500-in-prizes-ends-oct-9-3i16
SDK: https://github.com/MystenLabs/MemWal
```

## Demo video (90 seconds)

1. Open octokeep.wal.app, tap Open in Telegram.
2. Send a YouTube link. Show the summary and actions, tap "Yes", pick 2 days.
3. Send an Instagram screenshot. Show the summary.
4. Type `/jump 2d`. Show the reminder that mentions the first step.
5. Send "build the budget app on Thursday at 9, remind me", answer the questions, then `/jump` the number of days until Thursday (for example `/jump 3d`) and show the plan.
6. Ask "what have I been ignoring?"
7. Send `/memory` to show the count from Walrus Memory.
