/**
 * The worker's composition: the webhook app, and every loop as a job on the kernel's
 * registry. The loop table and its rulings: `README.md`. Intervals, flags, env names:
 * `kernel.resolveWorkerSettings`.
 */
import { kernel } from "@select-lub/core";
import { prisma } from "@select-lub/core/db";
import * as channel from "@select-lub/core/modules/channel";
import * as conversations from "@select-lub/core/modules/conversations";
import * as prefill from "@select-lub/core/modules/prefill";
import * as quotes from "@select-lub/core/modules/quotes";
import * as scheduling from "@select-lub/core/modules/scheduling";

type Log = (message: string) => void;

/** The log prefix each job's failure has always been reported under. */
const JOB_FAILURE_LOG: Readonly<Record<string, string>> = {
  "channel/drain-outbox": "outbox failed",
  "channel/reclaim-stuck": "outbox reclaim failed",
  [scheduling.DUE_AND_SYNC_JOB]: "outbox failed",
  [prefill.ENQUEUE_AND_DRAIN_JOB]: "prefill failed",
  "worker/omie-incremental": "omie incremental pull failed",
};

/** The webhook app with channel's route; closing it removes the canonicalize subscriber. */
export async function buildWorkerApp(
  options: { secret?: string; db?: kernel.Db | null; store?: conversations.IngestStore | null; log?: Log } = {},
) {
  const secret = "secret" in options ? options.secret : process.env.EVOLUTION_WEBHOOK_SECRET;
  const log = options.log ?? console.log;
  const app = await kernel.buildWebhookApp({ db: options.db });
  await channel.createWebhookPlugin({ secret, log })(app);
  const off = options.store ? conversations.canonicalizeReceivedWebhooks(options.store, log) : null;
  if (off) app.addHook("onClose", async () => off());
  return app;
}

/** The ports the loops run on; omit one to skip the loops that need it. */
export type WorkerPorts = {
  runOmiePull?: (mode: "full" | "incremental", log?: Log) => Promise<void>;
  db?: kernel.Db | null; store?: conversations.IngestStore | null;
  evolution?: channel.EvolutionSend | null;
  history?: channel.EvolutionHistory | null;
  connectionState?: channel.EvolutionConnectionState | null;
  prefill?: prefill.PrefillJobPort | null;
  scheduled?: scheduling.ScheduledDue | null;
  /**
   * The oil research ports, ONE object (background-oil-research D21): tests pass fakes. Absent,
   * the production ports are built on `db` — only when research is switched on.
   */
  oilResearchPorts?: quotes.OilResearchPorts;
  log?: Log; exit?: (code: number) => void;
};

/** The research settings the quotes jobs run on, from the worker's. */
function oilResearchSettings(set: kernel.WorkerSettings): quotes.OilResearchSettings {
  return {
    tickMs: set.oilResearchTickMs,
    sweepMs: set.oilResearchSweepMs,
    settleMs: set.oilResearchSettleMs,
    backfillPaceMs: set.oilResearchBackfillPaceMs,
    manualWaitMs: set.oilResearchManualWaitMs,
    runTimeoutMs: set.oilResearchRunTimeoutMs,
    providerPauseMs: set.oilResearchProviderPauseMs,
    outageBreaker: set.oilResearchOutageBreaker,
    maxAttempts: set.oilResearchMaxAttempts,
    dailyBudgetUsd: set.oilResearchDailyBudgetUsd,
    manualIngestion: set.manualIngestion,
    motulDegradedAfterMs: set.motulDegradedAfterMs,
  };
}

/**
 * Starts every loop; `stop(signal)` aborts the ticks' signal, waits them out (a research run's
 * release included), unsubscribes, disconnects, then exits 0. `options.oilResearch` switches
 * background oil research on explicitly; tests pass false.
 */
export function startWorker(options: Partial<kernel.WorkerSettings> & WorkerPorts = {}) {
  const set = kernel.resolveWorkerSettings(options);
  const { db, store, evolution, history, connectionState, scheduled, runOmiePull } = options;
  const log = options.log ?? console.log;
  // Channel's outbound and history events reach conversations' ingestion; the webhook one is buildWorkerApp's.
  const unsubscribe = store ? [conversations.insertSentMessages(store), conversations.ingestFetchedHistory(store)] : [];
  // The start-up reconcile runs outside the registry, so it keeps its own flag.
  const runReconcile = kernel.singleFlight(async () => {
    if (!db || !connectionState) return;
    const failed = (error: unknown) => log(`connection state reconcile failed ${kernel.messageOf(error)}`);
    await channel.reconcileConnection(db, connectionState).catch(failed);
  });
  log("worker started");
  log(store ? "ingest store ready" : "ingest store skipped (DATABASE_URL unset)");
  if (set.omiePull && runOmiePull) void kernel.runOnce("omie pull", log, () => runOmiePull("full", log));
  if (store && db && history && set.historyBackfill) {
    const skipped = () => log("history backfill skipped: seeded history exists");
    const backfill = () => kernel.runOnce("history backfill", log, () => channel.backfillHistory(db, { history, log }));
    void conversations.isHistoryBackfillBlockedBySeed(store).then((blocked) => (blocked ? skipped() : backfill()));
  }
  void runReconcile();
  const jobs = kernel.createJobRegistry();
  // Retry THEN reconcile as one job (ruling Q2-A): both write `connection_state`.
  const heartbeat = async () => {
    log("heartbeat");
    const failed = (error: unknown) => log(`retry failed ${kernel.messageOf(error)}`);
    if (store) await conversations.retryPendingEvents(store, new Date(), log).catch(failed);
    await runReconcile();
  };
  jobs.register({ name: "worker/heartbeat", everyMs: set.heartbeatMs, run: heartbeat });
  if (db && store && evolution) {
    const { outboxPollMs, claimTimeoutMs } = set;
    // Not refused: under hold-unknown-outcome-sends a short timeout can only label an
    // in-flight send "Envio incerto"; it can no longer resend it.
    if (!(claimTimeoutMs > channel.EVOLUTION_MEDIA_SEND_TIMEOUT_MS)) {
      log(`warning: WORKER_OUTBOX_CLAIM_TIMEOUT_MS=${claimTimeoutMs} is not above the ${channel.EVOLUTION_MEDIA_SEND_TIMEOUT_MS} ms media send limit`);
    }
    channel.createJobs({ db, evolution, log, outboxPollMs, claimTimeoutMs })(jobs.register);
    // Due tick THEN sync as one job (3B, Q4): both write `scheduled_message`.
    if (scheduled) scheduling.createJobs({ db, everyMs: outboxPollMs, scheduled })(jobs.register);
  }
  // Scan THEN drain on its own poll (4C): the window closes on silence, which no event signals.
  if (options.prefill) prefill.createJobs({ everyMs: set.prefillPollMs, prefill: options.prefill })(jobs.register);
  // Reads the manufacturer manuals the oil-spec search records, one per tick, in the background
  // (owner-approved). MANUAL_INGESTION_ENABLED=false is its kill switch.
  if (db && set.manualIngestion) {
    quotes.createManualIngestionJobs({ db, everyMs: set.manualIngestMs, budgetUsd: set.oilResearchDailyBudgetUsd })(jobs.register);
  }
  // Background oil research (background-oil-research D9, D21): only with a database and
  // OIL_RESEARCH_ENABLED=true — off in development and every test env, on in production's fly.toml.
  if (db && set.oilResearch) {
    const ports = options.oilResearchPorts ?? quotes.createProductionResearchPorts(db);
    quotes.createOilResearchJobs({ db, ports, settings: oilResearchSettings(set) })(jobs.register);
    log("oil research on");
  } else {
    log(`oil research off (${db ? "OIL_RESEARCH_ENABLED is not true" : "no database"})`);
  }
  // The research model and effort, and any pair with no measured limits (which runs on the
  // placeholder row): said once here, so the model in force is visible (background-oil-research D2).
  quotes.reportResearchModel((message, detail) => log(`${message} ${detail}`));
  if (set.omieIncremental && runOmiePull) {
    jobs.register({ name: "worker/omie-incremental", everyMs: set.omieIncrementalMs, run: () => runOmiePull("incremental", log) });
  }
  const onError = (name: string, error: unknown) => log(`${JOB_FAILURE_LOG[name] ?? `${name} failed`} ${kernel.messageOf(error)}`);
  const running = jobs.start({ onError });
  const after = () => {
    for (const off of unsubscribe) off();
    return prisma?.$disconnect();
  };
  const exit = options.exit ?? ((code: number) => process.exit(code));
  // `jobs`: the registered names, so a test can see what this start runs.
  return { stop: kernel.createStop({ running, log, after, exit }), jobs: jobs.registered.map((job) => job.name) };
}
