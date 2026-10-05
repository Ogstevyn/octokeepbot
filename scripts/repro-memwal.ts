import "./env.js";
import { MemWal, MemWalMock } from "@mysten-incubation/memwal";
import { loadConfig } from "../src/config.js";

// Reproductions for the Walrus Memory SDK issues in docs/FINDINGS.md.
//
//   npm run repro            offline checks only
//   npm run repro -- --live  also runs the relayer check (writes 3 small memories
//                            to a throwaway namespace on your account)

const KEY = "1".repeat(64);
const ACCOUNT = `0x${"a".repeat(64)}`;

console.log("1. IPv6 loopback is treated as a remote host");
console.log(`   new URL("http://[::1]:8000").hostname = ${JSON.stringify(new URL("http://[::1]:8000").hostname)}`);
console.log("   Creating a client for http://[::1]:8000 (a warning below is the bug):");
MemWal.create({ key: KEY, accountId: ACCOUNT, serverUrl: "http://[::1]:8000" });
console.log("   Creating a client for http://localhost:8000 (no warning expected):");
MemWal.create({ key: KEY, accountId: ACCOUNT, serverUrl: "http://localhost:8000" });

console.log("\n2. MemWalMock keeps a repeated remember that the real client collapses");
const mock = MemWalMock.create({ namespace: "repro" });
const a = await mock.remember("favourite drink: tea");
await mock.remember("favourite drink: coffee");
const c = await mock.remember("favourite drink: tea");
const all = await mock.recall({ query: "favourite drink", limit: 10 });
console.log(`   mock: first and third job ids ${a.job_id === c.job_id ? "are the same" : "differ"}; ${all.results.length} memories stored`);

if (!process.argv.includes("--live")) {
  console.log("\nSkipping the live check. Run with --live to send it to your relayer.");
  process.exit(0);
}

const cfg = loadConfig();
if (!cfg.MEMWAL_PRIVATE_KEY || !cfg.MEMWAL_ACCOUNT_ID) throw new Error("Set MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID in .env");
const namespace = `octokeep-repro-${Date.now()}`;
const live = MemWal.create({ key: cfg.MEMWAL_PRIVATE_KEY, accountId: cfg.MEMWAL_ACCOUNT_ID, serverUrl: cfg.MEMWAL_SERVER_URL, namespace });

console.log(`\n3. Live: a fact re-stated within 30 minutes is silently dropped (namespace ${namespace})`);
const wait = { timeoutMs: 180_000 };
const t0 = Date.now();
const first = await live.rememberAndWait("favourite drink: tea", undefined, wait);
console.log(`   remember "tea"    -> job ${first.job_id} (${Math.round((Date.now() - t0) / 1000)} s)`);
const second = await live.rememberAndWait("favourite drink: coffee", undefined, wait);
console.log(`   remember "coffee" -> job ${second.job_id}`);
const third = await live.rememberAndWait("favourite drink: tea", undefined, wait);
console.log(`   remember "tea"    -> job ${third.job_id}  ${third.job_id === first.job_id ? "<- same job as the first call, nothing new was written" : "(new job)"}`);

const recent = await live.recall({ query: "favourite drink", limit: 5, sort: "recent" });
console.log(`   recall sort=recent: ${recent.results.map((r) => JSON.stringify(r.text)).join(", ")}`);
console.log(`   newest memory is ${JSON.stringify(recent.results[0]?.text)}; the user's latest statement was "favourite drink: tea"`);
