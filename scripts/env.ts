import { fileURLToPath } from "node:url";

// Loads .env for local scripts. Vercel provides env vars itself.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
