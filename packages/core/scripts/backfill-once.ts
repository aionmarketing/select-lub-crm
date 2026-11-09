/**
 * Run the Evolution history backfill once, then exit.
 *
 * Exists because the alternative — booting the whole worker with
 * `WORKER_HISTORY_BACKFILL=1` — starts every other loop alongside it. Against
 * the pristine base (`packages/core/src/kernel/prisma/worktree-database.ts`) that is actively
 * harmful in three ways:
 *
 * 1. The prefill loop enqueues closed conversation windows and calls the
 *    language model on them. Run over a full history import that is hundreds of
 *    real conversations, and the base build silently costs a large token bill.
 * 2. The worker holds an open connection and keeps the webhook server
 *    listening, and Postgres refuses to copy a database that has open sessions —
 *    so the base could not be cloned while it ran.
 * 3. It never exits, so "the import is finished" is something the operator has
 *    to infer from a log line rather than from the process ending.
 *
 * This runs the backfill and nothing else, and its exit code is the answer.
 *
 * Usage, with `DATABASE_URL` pointed at the database to import into:
 *
 * ```
 * pnpm --filter @select-lub/worker backfill:once
 * ```
 *
 * (Moved here from `apps/worker/src/` in wave 5.2; the command is unchanged.)
 *
 * It reads `SERVER_URL` and `AUTHENTICATION_API_KEY` for the Evolution endpoint,
 * exactly as {@link createEvolutionHistory} does for the worker.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const { prisma } = await import("../src/kernel/prisma/index.js");
if (!prisma) {
  console.error("backfill: no database client — is DATABASE_URL set?");
  process.exit(1);
}

const { kernel } = await import("../src/index.js");
const { backfillHistory, createEvolutionHistory } = await import("../src/modules/channel/index.js");
const { createIngestStore, ingestFetchedHistory, isHistoryBackfillBlockedBySeed } = await import(
  "../src/modules/conversations/index.js"
);

const db = kernel.createDb(prisma);
const store = createIngestStore(db);
const connections = await store.listConnections();

// Reported rather than assumed. The backfill loops over connections and does
// nothing without one, so on an empty database it would otherwise succeed
// having written nothing — and an empty result reads as an Evolution failure
// rather than as a missing row. See the README's "The conversation base".
if (connections.length === 0) {
  console.error(
    "backfill: this database has no whatsapp_connection row, so there is nothing to import into.\n" +
      "         Insert the unit and connection skeleton first — see the repo README, 'The conversation base'.",
  );
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`backfill: ${connections.length} connection(s): ${connections.map((c) => c.instanceName).join(", ")}`);

if (await isHistoryBackfillBlockedBySeed(store)) {
  console.log("backfill: skipped — seeded history exists");
  await prisma.$disconnect();
  process.exit(0);
}

try {
  // The paging is channel's and publishes each record; the insert is
  // conversations' subscriber — the same wiring as the worker.
  ingestFetchedHistory(store);
  await backfillHistory(db, {
    history: createEvolutionHistory(),
    log: (m) => console.log(`backfill: ${m}`),
  });
  const conversations = await prisma.conversation.count();
  const messages = await prisma.message.count();
  console.log(`backfill: done — ${conversations} conversation(s), ${messages} message(s)`);
} catch (error) {
  console.error(`backfill: failed — ${error instanceof Error ? error.message : "unknown"}`);
  await prisma.$disconnect();
  process.exit(1);
}

await prisma.$disconnect();
