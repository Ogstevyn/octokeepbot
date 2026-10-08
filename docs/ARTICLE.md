# I kept bookmarking things I never did. So I built a bot that remembers, and asks.

I save things all day. A tutorial on the split-mask effect in After Effects. A thread on learning Sui Move. A Reel about structuring explainer videos. I tap bookmark, feel a little productive, and never open any of them again.

It isn't that I don't care. Nothing ever comes back for me. A bookmark is a drawer, and drawers don't talk.

So for Walrus Sessions 8 I built OctoKeep, a Telegram bot that remembers what you save and keeps asking until you do something with it.

## What it does

You send it something: a link, a screenshot of a post, a voice note, or a video. Instagram won't let a server read its posts, so one tester screen-recorded a Reel, split it into two parts and sent both. OctoKeep transcribed them and came back with a title, a summary and three small actions.

Then it asks two things. Do you want to act on this? When should I check back? A day, a week, or any time you type, like "5 min" or "6pm". When the time comes, it asks if you did it. One tap answers, and the answer is remembered too.

It also takes tasks. A tester wrote at 3am: "I just started my coding journey in web3 and I'm currently learning Sui Move... remind me in the next 2 hours to study." OctoKeep asked three short questions: experience level, hours per day, preferred resource. When the time came, it sent a five-step plan, from reading the official docs to deploying a module on a local testnet.

Another tester tried to break it. Remind me to cook. To bath. To take water. To laugh. To touch grass. It caught a time that had already passed and asked for a new one. Cooking came back with a plan that starts, sensibly, with "Rinse rice until water runs clear."

## Where the memory lives

Each user connects their own Walrus Memory account. OctoKeep never owns the memory. It writes short lines into the user's account: `[SAVE] ...`, `[TASK] ...`, `[OUTCOME] done "Study Sui Move"`. Postgres holds only the schedule: ids, times and statuses, with the text encrypted.

Recall is semantic search. It is very good at "what does this person care about" and useless for "what is due at 09:00". So each store does the job it is good at.

Memory is what makes this more than a to-do list. Every summary, reminder and plan recalls related lines first. Send a link you saved last week and it tells you, and says whether you finished it. Ask "what have I been ignoring?" and it answers from your outcomes. `/path rust` turns scattered saves into one ordered plan. And because the memory belongs to the user, the same account can be read from Claude or Cursor through the Walrus Memory MCP server.

## The buddy

Some goals need a person. `/buddy` gives you an invite link for a friend. Share a goal with them, and if you miss a reminder, they get a message. When you finish, they hear that too. During testing, a friend's chat filled up with "ogNla shared a goal with you", which is the kind of gentle social pressure a bookmark never gives you.

## What was hard

Setup. To connect, a user copies an Account ID and a delegate private key from the Walrus Memory dashboard. One tester sent her wallet's private key instead, got rejected, and we finished the setup on a video call. The dashboard has three kinds of keys, and nothing says which one an app needs. Walrus Memory already has an approve-in-browser login for its MCP server. Opening that to apps would fix this.

Writes are slow. Saving a memory took about 45 seconds on mainnet, so writes go into a queue and the user gets a reply straight away.

I also filed two SDK issues. The serious one, [#1127](https://github.com/MystenLabs/MemWal/issues/1127): re-stating the same fact within 30 minutes is silently collapsed onto the earlier write, so a recency-sorted recall returns the stale value. The small one, [#1128](https://github.com/MystenLabs/MemWal/issues/1128): an IPv6 loopback URL triggers the plaintext-HTTP warning.

## Numbers

In the first 48 hours, 16 people started the bot and 6 connected their own Walrus Memory. Together they stored 66 memories: 18 saves, 18 tasks and 23 resolved items. Three accounts passed ten memories, with 25, 19 and 15.

It runs on open-weight models on Groq: Qwen 3.8 for text and screenshots, Whisper for recordings and voice notes.

Next: one-tap connect, and group chats, so a team's shared links stop dying in the scroll.

Try it at [t.me/OctoKeep_bot](https://t.me/OctoKeep_bot). The code is at [github.com/Ogstevyn/octobot](https://github.com/Ogstevyn/octobot).
