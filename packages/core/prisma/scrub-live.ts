/**
 * CLI for `pnpm db:scrub-live`.
 *
 * Mirrors `prisma/seed.ts`: load `.env`, refuse a bad target, print the host,
 * then write. Importing this file is the process — keep the decision in
 * `resolveScrubLivePermission` so tests do not run the script.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { resolveScrubLivePermission } from "../src/kernel/prisma/seed-permission.js";
import { scrubLiveDataset } from "../src/kernel/prisma/scrub-live.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const permission = resolveScrubLivePermission(process.env);

if (permission.kind === "refused") {
  console.error(permission.message);
  process.exit(1);
}

console.log(permission.message);

const liveInstanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc";
const prisma = new PrismaClient();

const result = await scrubLiveDataset(prisma, { liveInstanceName });
console.log(
  `scrub-live: deleted ${result.deletedMessages} live message(s), ${result.deletedOutbox} outbox row(s), ${result.deletedWebhookEvents} webhook event(s)`,
);

await prisma.$disconnect();
