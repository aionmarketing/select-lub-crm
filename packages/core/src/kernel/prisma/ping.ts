/**
 * CLI entry: runs `SELECT 1` against CRM Postgres and exits.
 *
 * Loads the repository root's `.env` (`../../../../../.env` from this file) when present. Exits with code `1` when `DATABASE_URL` is unset or the query fails.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../../../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const { prisma } = await import("./client.js");

if (!prisma) {
  console.error("DATABASE_URL is not set; cannot ping Postgres.");
  process.exit(1);
}

await prisma.$queryRaw`SELECT 1`;
console.log("postgres ok");
await prisma.$disconnect();
