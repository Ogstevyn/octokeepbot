import "./env.js";
import { getBot } from "../src/runtime.js";
import { runTick } from "../src/tick.js";

// Runs the scheduler once. Optional: --now 2026-10-08T09:00:00Z --user 123
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const now = arg("now") ? new Date(arg("now")!) : undefined;
const userId = arg("user") ? Number(arg("user")) : undefined;
const { deps } = getBot();
console.log(await runTick(deps, { now, userId }));
