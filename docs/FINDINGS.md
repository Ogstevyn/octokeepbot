# Findings

Notes from building OctoKeep on Walrus Memory (`@mysten-incubation/memwal` 0.1.8, mainnet relayer `https://relayer.memory.walrus.xyz`). Each entry says what I did, what I expected, what happened, and a suggested fix. `npm run repro` reproduces the two SDK issues; `npm run repro -- --live` runs the relayer part against your own account.

## 1. A fact re-stated within 30 minutes is silently dropped

Filed as https://github.com/MystenLabs/MemWal/issues/1127.

**What I did.** Called `remember("favourite drink: tea")`, then `remember("favourite drink: coffee")`, then `remember("favourite drink: tea")` again a few minutes later, each awaited to completion, then `recall({ query: "favourite drink", sort: "recent" })`.

**Expected.** Three memories, newest first: tea, coffee, tea. Or, if duplicates are intentionally merged, some signal that the third call wrote nothing.

**What happens** (from the SDK and relayer source; `npm run repro -- --live` shows it on a real account). The third call returns the job id of the first call and writes nothing new. `sort: "recent"` then returns "coffee" as the newest memory, although the user's latest statement was "tea". The response is an ordinary `202` with the old `job_id`, so the caller cannot tell a collapse from a write.

**Why.** Since 0.1.8 the SDK derives the idempotency key from `sha256(30-minute bucket + namespace + text)` when the caller does not pass one (`derivedIdempotencyKey` in `memwal.js`). That was added so a retry after a dropped connection does not pay for a second blob, which is a good goal. But the key cannot tell a retry from a user deliberately saying the same thing again, and the relayer collapses any request with a known `(owner, idempotency_key)` onto the existing job. The window also depends on wall-clock bucket edges: two identical calls 2 seconds apart across a boundary both write, two calls 29 minutes apart inside one bucket do not.

**Where it bites.** Any agent that stores state changes as plain sentences: a preference that flips back, a habit logged twice in an hour ("drank water"), a status that returns to an earlier value. Recency-sorted recall then reports a stale state.

**Suggested fix.** Scope the derived key to one logical call rather than to content: generate it once per `remember()` invocation and reuse it only for that call's own retries (the existing `pendingRememberKeys` map already does this within an instance). If cross-instance replay protection is still wanted, return `deduplicated: true` in the accepted response so callers can see it, and document the window next to `remember()`, not only in the changelog.

**Mainnet run** (`npm run repro -- --live`):

```
remember "tea"    -> job 519fa53e-2f00-471b-80e6-763f9f8965cd (33 s)
remember "coffee" -> job 9cd76f6d-bb97-46bb-8c5e-7d42c3be2907
remember "tea"    -> job 519fa53e-2f00-471b-80e6-763f9f8965cd  <- same job as the first call, nothing new was written
recall sort=recent: "favourite drink: coffee", "favourite drink: tea"
```

**Workaround.** Pass your own `idempotencyKey` (a fresh UUID per intended write), or include something unique in the text. OctoKeep's memory lines include item titles and dates, so it is rarely affected.

## 2. `MemWalMock` does not model that collapse

**What I did.** Ran the same three calls against `MemWalMock`.

**What happened.** The mock stores all three and returns three different job ids. Tests written against the mock pass, then the same code drops data on the real relayer. The mock also stores `analyze()` input verbatim as a single fact, while the relayer extracts zero or more facts, so code that counts facts behaves differently in tests and production.

**Suggested fix.** Have `MemWalMock.rememberAsync` derive the same key and return the existing job inside the window, or document the difference in the mock's header comment.

## 3. IPv6 loopback relayer URLs get the plaintext-HTTP warning

Filed as https://github.com/MystenLabs/MemWal/issues/1128.

**What I did.** `MemWal.create({ ..., serverUrl: "http://[::1]:8000" })` for a local relayer.

**Expected.** No warning, as for `http://localhost:8000`. The doc comment on `normalizeServerUrl` says `::1` is exempt.

**What happened.** `[memwal] serverUrl "http://[::1]:8000" uses plaintext HTTP on a non-localhost host...`. `new URL("http://[::1]:8000").hostname` is `"[::1]"` with brackets, so the check `host === "::1"` never matches. The Python SDK gets this right (its `urlparse` strips the brackets and it has a test for `http://[::1]:8000`), so this is a TypeScript-only parity bug.

**Suggested fix.** In `packages/sdk/src/utils.ts`, compare against `"[::1]"` as well, or strip brackets before comparing.

## Things that are not bugs but cost me time

- **Writes are slow and asynchronous.** On mainnet, `remember` plus `waitForRememberJob` took 45 s in my spike run (recall took 1.8 s). A chat reply cannot wait for that, so OctoKeep queues each write in Postgres, answers the user at once, and retries failed writes from the scheduler. The default `waitForRememberJob` timeout is 60 s, close to what a normal write takes.
- **Recall cannot answer "what is due now".** It is similarity search. A reminder bot needs an exact time index, so Postgres holds the schedule and Walrus Memory holds what the bot knows about the user. Every reminder, summary and answer recalls from Walrus Memory to personalise itself.
- **Namespace defaults to `"default"`.** Pass the namespace explicitly to both `create()` and each call, or memories land where another app on the same account also writes.
- **Which relayer.** Accounts made at memory.walrus.xyz live on the mainnet relayer; the staging relayer is a different system and will not accept those keys. The error for a key used against the wrong relayer looks like an auth failure, not "wrong network".
- **Counting memories.** `listNamespaces()` returns `memory_count` per namespace, which is the cleanest way to show a user how much is stored. OctoKeep's `/memory` command and `npm run stats` use it.
