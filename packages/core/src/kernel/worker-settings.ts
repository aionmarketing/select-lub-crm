/**
 * The worker's loop intervals and start-up flags, and the env names they read.
 *
 * Moved out of `apps/worker/src/worker.ts`'s `startWorker` in wave 5.2 with
 * every default, name and parse unchanged: `Number(...)` as before (so a
 * non-numeric interval is `NaN`, as it was), and only the Omie poll falls back
 * when it is not a positive finite number. An explicit option beats the env.
 *
 * The oil research settings (background-oil-research, PR 3) fall back to their
 * defaults on anything unusable, and the budget parses strictly (D3).
 */
import { parseMoney } from "./money.js";

/** What `startWorker` runs on, and how often. */
export interface WorkerSettings {
  /** Ingest retry + connection reconcile, `WORKER_HEARTBEAT_MS` (30 s). */
  heartbeatMs: number;
  /** Outbox drain and scheduled due tick, `WORKER_OUTBOX_POLL_MS` (1 s). */
  outboxPollMs: number;
  /** Prefill scan then drain, `WORKER_PREFILL_POLL_MS` (1 s). */
  prefillPollMs: number;
  /** Age at which a `claimed` outbox row is failed as an unknown outcome, `WORKER_OUTBOX_CLAIM_TIMEOUT_MS` (3 min). */
  claimTimeoutMs: number;
  /** Evolution history import once at start, `WORKER_HISTORY_BACKFILL=1`. */
  historyBackfill: boolean;
  /** Omie full pull once at start, `WORKER_OMIE_PULL=1`. */
  omiePull: boolean;
  /** The incremental Omie poll, `WORKER_OMIE_POLL=1`. */
  omieIncremental: boolean;
  /** Its interval, `WORKER_OMIE_POLL_MS` (1 h; also when not a positive number). */
  omieIncrementalMs: number;
  /**
   * Reading the manufacturer manuals the oil-spec search records (ingest-harvested-manuals).
   * On unless `MANUAL_INGESTION_ENABLED=false`: the owner approved background ingestion, and
   * this is its kill switch.
   */
  manualIngestion: boolean;
  /** Its interval, `WORKER_MANUAL_INGEST_MS` (1 min; also when not a positive number). */
  manualIngestMs: number;
  /**
   * Background oil research (background-oil-research D9, D21): on only when
   * `OIL_RESEARCH_ENABLED` is exactly `"true"`. Off in development and in every test env;
   * `apps/worker/fly.toml` switches it on in production.
   */
  oilResearch: boolean;
  /** The runner's tick, `OIL_RESEARCH_TICK_MS` (10 s). */
  oilResearchTickMs: number;
  /** The sweep's tick, `OIL_RESEARCH_SWEEP_MS` (60 s). */
  oilResearchSweepMs: number;
  /** How long a vehicle must be unchanged before its identity is queued, `OIL_RESEARCH_SETTLE_MS` (120 s). */
  oilResearchSettleMs: number;
  /** A backfill claim only this long after the last run finished, `OIL_RESEARCH_BACKFILL_PACE_MS` (60 s). */
  oilResearchBackfillPaceMs: number;
  /** The wait for a manual found by the search, `OIL_RESEARCH_MANUAL_WAIT_MS` (30 min: background-oil-research D11, kept by task 1.13). */
  oilResearchManualWaitMs: number;
  /**
   * A run's ceiling, `OIL_RESEARCH_RUN_TIMEOUT_MS`; `null` when unset, and the quotes module then
   * takes it from the effort in force (D2: 45 min at `high`, 90 min at `max`, 25 min at `low`).
   */
  oilResearchRunTimeoutMs: number | null;
  /** A provider-wide refusal pauses research this long, `OIL_RESEARCH_PROVIDER_PAUSE_MS` (15 min). */
  oilResearchProviderPauseMs: number;
  /** Consecutive outages on different identities that pause research, `OIL_RESEARCH_OUTAGE_BREAKER` (3). */
  oilResearchOutageBreaker: number;
  /** Attempts per research cycle, `OIL_RESEARCH_MAX_ATTEMPTS` (3). */
  oilResearchMaxAttempts: number;
  /**
   * The daily budget the backfill stops at, `OIL_RESEARCH_DAILY_BUDGET_USD` (2.00), parsed
   * strictly: anything but a number ≥ 0 with a dot is logged and the default is used. 0 is valid.
   */
  oilResearchDailyBudgetUsd: number;
  /**
   * How long Motul must have been failing, continuously, to count as degraded (it then no longer
   * makes a research run incomplete), `MOTUL_DEGRADED_AFTER_MS` (6 h; oil-research-web-retrieval D6).
   */
  motulDegradedAfterMs: number;
}

/** The default daily budget, USD (D8, D13; raised from 1 to 2 by the owner, 2026-10-11). */
export const DEFAULT_OIL_RESEARCH_DAILY_BUDGET_USD = 2;

/** `value` when it is a positive finite number, else `fallback`. */
function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `value` when it is a finite number ≥ 0, else `fallback`. */
function nonNegativeOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** An env integer ≥ 1, else `fallback`; unset reads as the fallback. */
function envPositive(raw: string | undefined, fallback: number): number {
  return raw === undefined || raw.trim() === "" ? fallback : positiveOr(Number(raw), fallback);
}

/** An env whole number ≥ 1, else `fallback`: `0.5`, `0` and `-1` are refused, not floored. */
function envCount(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** An env number > 0, else `null` (unset or not one). */
function envPositiveOrNull(raw: string | undefined): number | null {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

/** An env integer ≥ 0, else `fallback`. */
function envNonNegative(raw: string | undefined, fallback: number): number {
  return raw === undefined || raw.trim() === "" ? fallback : nonNegativeOr(Number(raw), fallback);
}

/** The budget, strictly: a typo is reported with its name and the default applies (D3). */
function budgetFrom(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_OIL_RESEARCH_DAILY_BUDGET_USD;
  const value = parseMoney(raw);
  if (value !== null) return value;
  console.warn(
    "money-setting",
    JSON.stringify({ outcome: "invalid", name: "OIL_RESEARCH_DAILY_BUDGET_USD", value: raw, using: DEFAULT_OIL_RESEARCH_DAILY_BUDGET_USD }),
  );
  return DEFAULT_OIL_RESEARCH_DAILY_BUDGET_USD;
}

/**
 * Resolves each setting from the option, else the env, else the default.
 *
 * @param options - Explicit values; a test passes these.
 * @param env - Defaults to `process.env`, read at call time.
 */
export function resolveWorkerSettings(
  options: Partial<WorkerSettings> = {},
  env: NodeJS.ProcessEnv = process.env,
): WorkerSettings {
  const parsedPollMs = Number(options.omieIncrementalMs ?? env.WORKER_OMIE_POLL_MS ?? 3_600_000);
  return {
    heartbeatMs: options.heartbeatMs ?? Number(env.WORKER_HEARTBEAT_MS ?? 30_000),
    outboxPollMs: options.outboxPollMs ?? Number(env.WORKER_OUTBOX_POLL_MS ?? 1_000),
    prefillPollMs: options.prefillPollMs ?? Number(env.WORKER_PREFILL_POLL_MS ?? 1_000),
    claimTimeoutMs: options.claimTimeoutMs ?? Number(env.WORKER_OUTBOX_CLAIM_TIMEOUT_MS ?? 180_000),
    historyBackfill: options.historyBackfill ?? env.WORKER_HISTORY_BACKFILL === "1",
    omiePull: options.omiePull ?? env.WORKER_OMIE_PULL === "1",
    omieIncremental: options.omieIncremental ?? env.WORKER_OMIE_POLL === "1",
    omieIncrementalMs: Number.isFinite(parsedPollMs) && parsedPollMs > 0 ? parsedPollMs : 3_600_000,
    manualIngestion: options.manualIngestion ?? env.MANUAL_INGESTION_ENABLED !== "false",
    manualIngestMs: options.manualIngestMs ?? positiveOr(Number(env.WORKER_MANUAL_INGEST_MS), 60_000),
    oilResearch: options.oilResearch ?? env.OIL_RESEARCH_ENABLED === "true",
    oilResearchTickMs: options.oilResearchTickMs ?? envPositive(env.OIL_RESEARCH_TICK_MS, 10_000),
    oilResearchSweepMs: options.oilResearchSweepMs ?? envPositive(env.OIL_RESEARCH_SWEEP_MS, 60_000),
    oilResearchSettleMs: options.oilResearchSettleMs ?? envNonNegative(env.OIL_RESEARCH_SETTLE_MS, 120_000),
    oilResearchBackfillPaceMs: options.oilResearchBackfillPaceMs ?? envNonNegative(env.OIL_RESEARCH_BACKFILL_PACE_MS, 60_000),
    oilResearchManualWaitMs: options.oilResearchManualWaitMs ?? envNonNegative(env.OIL_RESEARCH_MANUAL_WAIT_MS, 30 * 60_000),
    oilResearchRunTimeoutMs:
      options.oilResearchRunTimeoutMs !== undefined ? options.oilResearchRunTimeoutMs : envPositiveOrNull(env.OIL_RESEARCH_RUN_TIMEOUT_MS),
    oilResearchProviderPauseMs: options.oilResearchProviderPauseMs ?? envPositive(env.OIL_RESEARCH_PROVIDER_PAUSE_MS, 15 * 60_000),
    oilResearchOutageBreaker: options.oilResearchOutageBreaker ?? envCount(env.OIL_RESEARCH_OUTAGE_BREAKER, 3),
    oilResearchMaxAttempts: options.oilResearchMaxAttempts ?? envCount(env.OIL_RESEARCH_MAX_ATTEMPTS, 3),
    oilResearchDailyBudgetUsd: options.oilResearchDailyBudgetUsd ?? budgetFrom(env.OIL_RESEARCH_DAILY_BUDGET_USD),
    motulDegradedAfterMs: options.motulDegradedAfterMs ?? envPositive(env.MOTUL_DEGRADED_AFTER_MS, 6 * 60 * 60_000),
  };
}
