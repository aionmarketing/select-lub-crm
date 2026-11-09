/**
 * The runner's one row, `oil_research_runner` (background-oil-research D9, D13, D15).
 *
 * - {@link lockRunnerRow}: the claim's first statement, `SELECT … FOR UPDATE`, which makes research
 *   one at a time across every worker process sharing the database (D8).
 * - {@link writeRunnerHeartbeat}: under the row lock, `last_seen_at`, the key flag, whether the web search is available (review of #188), the day, the
 *   day's spend, the budget, and the pause: an unexpired provider pause is kept; otherwise `no_key` without the
 *   key, `budget` until the next local midnight once the day's spend reaches the budget, else none.
 * - {@link pauseForProvider}: a provider-wide refusal, or the outage breaker, pauses research.
 * - {@link readMotulFailingSince}, {@link isMotulDegraded}, {@link recordMotulOutcome}: since when the
 *   Motul Oil Advisor has been failing, shared by every worker process (oil-research-web-retrieval D6).
 * - `researchStopped`, `readRunnerStatus`, `hasLiveLease`: D15's `stopped` and its reads, in the
 *   module's public scope since PR 4 (`contracts/oil-research-attention.ts`), which the rail's
 *   `readActiveOilResearch` applies for customers; re-exported here for the runner.
 */
import type { DbClient } from "@select-lub/core/db";
import { readRunnerStatus, RUNNER_ROW_ID, type RunnerPause, type RunnerStatus } from "../../contracts/oil-research-attention.js";
import type { MotulOutcome } from "../retrieval/sources.js";
import { budgetReached, daySpendUsd, nextSaoPauloMidnight, saoPauloDay } from "./budget.js";

export {
  hasLiveLease,
  readRunnerStatus,
  researchStopped,
  RUNNER_ROW_ID,
  RUNNER_STALE_MS,
  type RunnerPause,
  type RunnerStatus,
} from "../../contracts/oil-research-attention.js";

/** Creates the row if missing, then locks it for the rest of the transaction. */
export async function lockRunnerRow(tx: DbClient, now: Date): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO oil_research_runner (id, updated_at) VALUES (${RUNNER_ROW_ID}, ${now})
    ON CONFLICT (id) DO NOTHING`;
  await tx.$queryRaw`SELECT id FROM oil_research_runner WHERE id = ${RUNNER_ROW_ID} FOR UPDATE`;
}

/**
 * The heartbeat (D9, step 1), written by the runner's tick and by the sweep every minute.
 *
 * @returns The status written.
 */
export async function writeRunnerHeartbeat(tx: DbClient, input: { now: Date; keySet: boolean; searchAvailable: boolean; budgetUsd: number }): Promise<RunnerStatus> {
  const { now, keySet, searchAvailable, budgetUsd } = input;
  // Under the row lock: the pause read below is the one the write keeps, so a provider pause
  // committed by another transaction is either seen here or waits for this one, never erased.
  await lockRunnerRow(tx, now);
  const spend = await daySpendUsd(tx, now);
  const current = await readRunnerStatus(tx);
  const providerPause = current?.pausedReason === "provider" && current.pausedUntil !== null && current.pausedUntil > now;
  let pausedReason: RunnerPause | null = null;
  let pausedUntil: Date | null = null;
  if (providerPause) {
    pausedReason = "provider";
    pausedUntil = current.pausedUntil;
  } else if (!keySet) {
    pausedReason = "no_key";
  } else if (budgetReached(spend, budgetUsd)) {
    pausedReason = "budget";
    pausedUntil = nextSaoPauloMidnight(now);
  }
  const data = {
    lastSeenAt: now,
    keySet,
    searchAvailable,
    day: saoPauloDay(now),
    daySpendUsd: spend.toFixed(6),
    budgetUsd: budgetUsd.toFixed(6),
    pausedReason,
    pausedUntil,
    updatedAt: now,
  };
  await tx.oilResearchRunner.upsert({ where: { id: RUNNER_ROW_ID }, create: { id: RUNNER_ROW_ID, ...data }, update: data });
  return {
    lastSeenAt: now,
    keySet,
    searchAvailable,
    day: data.day,
    daySpendUsd: spend,
    budgetUsd,
    pausedReason,
    pausedUntil,
    sweepWatermark: current?.sweepWatermark ?? null,
  };
}

/** A provider-wide refusal (D9, step 3): nothing that spends is claimed until `until`. */
export async function pauseForProvider(tx: DbClient, now: Date, until: Date): Promise<void> {
  const data = { pausedReason: "provider", pausedUntil: until, updatedAt: now };
  await lockRunnerRow(tx, now);
  await tx.oilResearchRunner.upsert({ where: { id: RUNNER_ROW_ID }, create: { id: RUNNER_ROW_ID, ...data }, update: data });
}

/** Since when the Motul Oil Advisor has been failing without an answer; null while it answers (or before any run). */
export async function readMotulFailingSince(tx: DbClient): Promise<Date | null> {
  const row = await tx.oilResearchRunner.findUnique({ where: { id: RUNNER_ROW_ID }, select: { motulFailingSince: true } });
  return row?.motulFailingSince ?? null;
}

/**
 * Whether Motul has been failing, continuously, for at least `afterMs` (D6).
 *
 * @param failingSince - {@link readMotulFailingSince}.
 * @param now - The run's clock.
 * @param afterMs - `MOTUL_DEGRADED_AFTER_MS`.
 */
export function isMotulDegraded(failingSince: Date | null, now: Date, afterMs: number): boolean {
  return failingSince !== null && now.getTime() - failingSince.getTime() >= afterMs;
}

/**
 * Records what a run's call to Motul came to: the first `unavailable` stamps the moment it began
 * failing and keeps it, and any answer clears it (D6). Under the runner row's lock, so two worker
 * processes agree on the moment. Writes nothing when nothing changes.
 *
 * @param outcome - What the Motul adapter reported to the run.
 * @param now - The run's clock.
 */
export async function recordMotulOutcome(tx: DbClient, outcome: MotulOutcome, now: Date): Promise<void> {
  await lockRunnerRow(tx, now);
  const current = await readMotulFailingSince(tx);
  const next = outcome === "answered" ? null : (current ?? now);
  if ((next?.getTime() ?? null) === (current?.getTime() ?? null)) return;
  await tx.oilResearchRunner.update({ where: { id: RUNNER_ROW_ID }, data: { motulFailingSince: next } });
}
