/**
 * Process entry: loads repo `.env`, refuses to start without a database, builds
 * the Fastify app on the shared Prisma client, and listens on `PORT`/`HOST`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertDatabaseConfigured } from "./startup.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// Before importing the app: `@select-lub/core/db` instantiates its client at import
// time from DATABASE_URL, and the app must never come up on anything else.
assertDatabaseConfigured();

const [{ buildApp }, { prisma }] = await Promise.all([import("./app.js"), import("@select-lub/core/db")]);
if (!prisma) {
  // Unreachable after the guard above; kept so the type narrows without a cast.
  assertDatabaseConfigured({});
  throw new Error("DATABASE_URL is set but the database client did not initialise.");
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const app = await buildApp({ db: prisma });
await app.listen({ port, host });
