/**
 * Worker process entrypoint: loads env, starts the Evolution webhook server, and runs background loops.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const { prisma } = await import("@select-lub/core/db");
const { kernel } = await import("@select-lub/core");
const { createEvolutionConnectionState, createEvolutionHistory, createEvolutionSend } = await import(
  "@select-lub/core/modules/channel"
);
const { createIngestStore } = await import("@select-lub/core/modules/conversations");
const { buildWorkerApp, startWorker } = await import("./worker.js");

const db = prisma ? kernel.createDb(prisma) : null;
const store = db ? createIngestStore(db) : null;
// Prefill is the prefill module's (4C): its scan and drain run on the same handle.
const { createPrefillJob } = await import("@select-lub/core/modules/prefill");
// Scheduled messages are the scheduling module's (3B); its due tick runs on the same handle.
const { createScheduledDue } = await import("@select-lub/core/modules/scheduling");
const scheduled = db ? createScheduledDue(db) : null;
const evolution = prisma ? createEvolutionSend() : null;
const history = prisma ? createEvolutionHistory() : null;
const connectionState = prisma ? createEvolutionConnectionState() : null;
const prefill = db ? createPrefillJob(db) : null;
const port = Number(process.env.WORKER_PORT ?? 3001);
const host = kernel.resolveWorkerHost();

const app = await buildWorkerApp({
  db,
  store,
});
await app.listen({ port, host });

// The Omie pull is the erp module's (3A-erp); it runs on the same handle.
const { runPull } = await import("@select-lub/core/modules/erp");
const { stop: stopHeartbeat } = startWorker({
  db,
  store,
  scheduled,
  evolution,
  history,
  connectionState,
  prefill,
  runOmiePull: db
    ? (mode, log) => runPull(db, mode, process.env, undefined, undefined, log)
    : undefined,
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) {
    return;
  }
  stopping = true;
  await app.close();
  stopHeartbeat(signal);
}

process.on("SIGTERM", () => {
  void stop("SIGTERM");
});
process.on("SIGINT", () => {
  void stop("SIGINT");
});
