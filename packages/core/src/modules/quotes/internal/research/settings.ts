/**
 * What the research jobs run on (background-oil-research D2, D8, D9, D11, D13), and the two limits
 * computed here, in one place: the lease and the run ceiling.
 */
import { limitsFor } from "../model-calls/limits.js";
import { researchModel } from "../model-calls/research-model.js";
import { webSearchTimeoutMs } from "../retrieval/web-search.js";
import { OIL_RESEARCH_MAX_ATTEMPTS } from "./research-states.js";

/** The research settings, as the worker resolved them (`kernel.resolveWorkerSettings`). */
export type OilResearchSettings = {
  /** The runner's tick (`OIL_RESEARCH_TICK_MS`). */
  tickMs: number;
  /** The sweep's tick (`OIL_RESEARCH_SWEEP_MS`). */
  sweepMs: number;
  /** How long a vehicle must be unchanged before its identity is queued (`OIL_RESEARCH_SETTLE_MS`). */
  settleMs: number;
  /** A backfill claim only this long after the last run finished (`OIL_RESEARCH_BACKFILL_PACE_MS`). */
  backfillPaceMs: number;
  /** The wait for a manual (`OIL_RESEARCH_MANUAL_WAIT_MS`). */
  manualWaitMs: number;
  /** The run ceiling (`OIL_RESEARCH_RUN_TIMEOUT_MS`); null for the effort row's (D2). */
  runTimeoutMs: number | null;
  /** A provider-wide refusal pauses research this long (`OIL_RESEARCH_PROVIDER_PAUSE_MS`). */
  providerPauseMs: number;
  /** Consecutive outages on different identities that pause research (`OIL_RESEARCH_OUTAGE_BREAKER`). */
  outageBreaker: number;
  /** Attempts per cycle (`OIL_RESEARCH_MAX_ATTEMPTS`). */
  maxAttempts: number;
  /** The daily budget the backfill stops at, USD (`OIL_RESEARCH_DAILY_BUDGET_USD`). */
  dailyBudgetUsd: number;
  /** Manual ingestion is on: without it research never waits for a manual (D11). */
  manualIngestion: boolean;
  /**
   * How long the Motul Oil Advisor must have been failing, continuously, to count as degraded
   * (`MOTUL_DEGRADED_AFTER_MS`, oil-research-web-retrieval D6).
   */
  motulDegradedAfterMs: number;
};

/** The defaults, as `resolveWorkerSettings` gives them with no env; tests start from these. */
export const DEFAULT_OIL_RESEARCH_SETTINGS: OilResearchSettings = {
  tickMs: 10_000,
  sweepMs: 60_000,
  settleMs: 120_000,
  backfillPaceMs: 60_000,
  manualWaitMs: 30 * 60_000,
  runTimeoutMs: null,
  providerPauseMs: 15 * 60_000,
  outageBreaker: 3,
  maxAttempts: OIL_RESEARCH_MAX_ATTEMPTS,
  dailyBudgetUsd: 2,
  manualIngestion: true,
  motulDegradedAfterMs: 6 * 60 * 60_000,
};

/** The research model, whose limits row picks the lease and the run ceiling. */
function readModel(): { model: string; effort: ReturnType<typeof researchModel>["effort"] } {
  const { model, effort } = researchModel();
  return { model, effort };
}

/**
 * The research lease (D9): `2 × max(OIL_RESEARCH_CALL_TIMEOUT_MS, WEB_SEARCH_TIMEOUT_MS) + 120 s` —
 * longer than any single port call, which run one after another. 12 min on the placeholder row.
 * The Tecfil lease has the same length. Computed here only; the claim and every renewal are handed
 * it.
 */
export function researchLeaseMs(): number {
  const { model, effort } = readModel();
  const callMs = limitsFor(model, effort).callMs;
  const webMs = webSearchTimeoutMs(model);
  return 2 * Math.max(callMs, webMs) + 120_000;
}

/** The run ceiling (D2): the setting when given, else the research model's row — 45 min. */
export function runCeilingMs(settings: Pick<OilResearchSettings, "runTimeoutMs">): number {
  const { model, effort } = readModel();
  return settings.runTimeoutMs ?? limitsFor(model, effort).runMs;
}
