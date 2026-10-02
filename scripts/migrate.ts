import "./env.js";
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";
import { migrate } from "../src/db/neon.js";

const c = config();
if (c.DATABASE_URL === "memory") {
  console.log("DATABASE_URL=memory: nothing to migrate.");
} else {
  const sql = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  const n = await migrate(c.DATABASE_URL, sql);
  console.log(`Database schema is up to date (${n} statements applied).`);
}
