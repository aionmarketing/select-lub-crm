/**
 * The compare-and-set writes of a live claim (background-oil-research D9, D10, D12): renewing the
 * lease with the meter, recording the outcome (with the pending cycle and the Tecfil takeover),
 * and recording Tecfil. Research writes compare `(id, state = running, attempts,
 * current_run_id)`; Tecfil writes `(id, tecfil_state = running, current_run_id)`. A lost one
 * writes nothing — not the identity, not the run row, not the cache.
 */
import type { DbClient } from "@select-lub/core/db";
import type { MotulCompatibility, TecfilCompatibility } from "../../contracts/http.js";
import { compatibilityCaches } from "../store/compatibility-caches.js";
import type { ResearchClaim, TecfilClaim } from "./claim.js";
import { storeQueuedEstimate } from "./enqueue.js";
import { loadPathTimings, storedEstimate, type StoredEstimate } from "./estimate.js";
import { clearEnginePickWhen, sql } from "./kinds-sql.js";
import { OIL_RESEARCH_MAX_ATTEMPTS, researchBackoffMs, tecfilBackoffMs, type ResearchState, type TecfilState } from "./research-states.js";
import { progressData, writeRun, type RunProgress } from "./run-progress.js";

/**
 * Renews a research claim's lease and flushes the meter to its run row, as one compare-and-set on
 * `(id, state = running, attempts, current_run_id)`. Called before each port call (D9, step 7).
 *
 * @returns False when the claim was lost, and nothing was written.
 */
export async function renewResearchLease(tx: DbClient, claim: ResearchClaim, now: Date, leaseMs: number, progress: RunProgress = {}): Promise<boolean> {
  const { count } = await tx.oilResearch.updateMany({
    where: { id: claim.id, state: "running", attempts: claim.attempts, currentRunId: claim.runId },
    data: { leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
  });
  if (count !== 1) return false;
  await writeRun(tx, claim.runId, progressData(progress));
  return true;
}

/** The same, for a Tecfil claim: on `(id, tecfil_state = running, current_run_id)`, renewing `tecfil_lease_until`. */
export async function renewTecfilLease(tx: DbClient, claim: TecfilClaim, now: Date, leaseMs: number, progress: RunProgress = {}): Promise<boolean> {
  const { count } = await tx.oilResearch.updateMany({
    where: { id: claim.id, tecfilState: "running", currentRunId: claim.runId },
    data: { tecfilLeaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
  });
  if (count !== 1) return false;
  await writeRun(tx, claim.runId, progressData(progress));
  return true;
}

/** An outcome the pipeline gave, before D10's mapping of the last attempt. */
export type ResearchRecord =
  | {
      outcome: "verified";
      /** Inserted in the same transaction as the state. */
      cacheRow: Omit<MotulCompatibility, "id">;
      sourcesReadAt: Date | null;
      incomplete?: boolean;
    }
  | { outcome: "no_spec"; searched: boolean; sourcesReadAt: Date | null }
  | { outcome: "needs_clarification" | "conflicting_sources"; payload: unknown; sourcesReadAt: Date | null }
  /** A wait is not an outcome, so it leaves `sources_read_at` alone; `sourcesReadAt` is ignored. */
  | { outcome: "waiting_manual"; waitUntil: Date; sourcesReadAt?: Date | null }
  | {
      /**
       * An outage (D10): queued again after a backoff; on the last attempt, `fallback` or `failed`.
       * `sourcesReadAt` is stored only when the fallback becomes the current outcome.
       */
      outcome: "transient";
      fallback?: { outcome: "needs_clarification" | "conflicting_sources"; payload: unknown };
      sourcesReadAt?: Date | null;
    }
  | { outcome: "failed" }
  /**
   * An engine re-read that reopened a resting outcome and did not verify (G2, D24): the row keeps
   * its prior outcome and payload, dated by this run. `runOutcome` is what the run itself ended with.
   */
  | { outcome: "kept_prior"; runOutcome: string };

/** The recorded result. */
export type RecordResult =
  | { status: "lost" }
  | {
      status: "recorded";
      /** The row's state now: a pending cycle makes it `queued` whatever the outcome. */
      state: ResearchState;
      /** What the run row says it ended with. */
      runOutcome: string;
      /** The Tecfil claim the verified record took over, for the Tecfil step of the same run (D12). */
      tecfil: TecfilClaim | null;
    };

/** What the recorder needs beside the outcome. */
export type RecordOptions = RunProgress & { now: Date; leaseMs: number; maxAttempts?: number };

/**
 * Records a research claim's outcome (D10) with the claim's compare-and-set. In the same
 * transaction: a verified spec's cache row; a pending cycle (D7), which queues the row with the
 * pending kind and priority, attempts 0 and `requested_at` = `pending_requested_at`; the Tecfil
 * claim a verified record takes over when Tecfil is not yet `ok` or the run was a refetch
 * (D9, step 8) — never with a pending cycle, which does Tecfil itself; and the run row.
 *
 * `sources_read_at` moves only when the recorded outcome becomes the current one (verified, no
 * source, a clarification or a conflict), not on a retry, a failure or a wait. `wait_started_at`
 * is kept through a retried re-resolve, so the manual path's duration still sees its wait.
 *
 * A transient outcome is queued again at now + 5 min, then 15 min; on the last attempt it records
 * its fallback (a clarification or a conflict the sources gave) or `failed`.
 */
export async function recordResearch(tx: DbClient, claim: ResearchClaim, record: ResearchRecord, options: RecordOptions): Promise<RecordResult> {
  const { now } = options;
  const maxAttempts = options.maxAttempts ?? OIL_RESEARCH_MAX_ATTEMPTS;

  // D10's mapping to a target state.
  let state: ResearchState;
  let outcome: string | null = null;
  let payload: unknown = null;
  let dueAt: Date | null = null;
  let searched = true;
  let runOutcome: string;
  let sourcesReadAt: Date | null = null;
  let waitUntil: Date | null = null;
  let waitEstimate: StoredEstimate | null = null;
  switch (record.outcome) {
    case "verified":
      state = "verified";
      outcome = "verified";
      runOutcome = "verified";
      sourcesReadAt = record.sourcesReadAt;
      break;
    case "no_spec":
      state = "no_spec";
      outcome = "no_spec";
      searched = record.searched;
      runOutcome = "no_spec";
      sourcesReadAt = record.sourcesReadAt;
      break;
    case "needs_clarification":
    case "conflicting_sources":
      state = record.outcome;
      outcome = record.outcome;
      payload = record.payload;
      runOutcome = record.outcome;
      sourcesReadAt = record.sourcesReadAt;
      break;
    case "waiting_manual": {
      state = "waiting_manual";
      runOutcome = "waiting_manual";
      waitUntil = record.waitUntil;
      // D14's third moment: (now − requested_at) + the manual range.
      const manual = await loadPathTimings(tx, "manual", now);
      waitEstimate = storedEstimate((now.getTime() - claim.requestedAt.getTime()) / 1000, 0, manual.range);
      break;
    }
    case "transient":
      if (claim.attempts < maxAttempts) {
        state = "queued";
        dueAt = new Date(now.getTime() + researchBackoffMs(claim.attempts));
        runOutcome = "unavailable";
      } else if (record.fallback) {
        state = record.fallback.outcome;
        outcome = record.fallback.outcome;
        payload = record.fallback.payload;
        runOutcome = record.fallback.outcome;
        sourcesReadAt = record.sourcesReadAt ?? null;
      } else {
        state = "failed";
        outcome = "failed";
        runOutcome = "failed";
      }
      break;
    case "failed":
      state = "failed";
      outcome = "failed";
      runOutcome = "failed";
      break;
    case "kept_prior":
      // The SQL keeps the row's own outcome as its state; this is only the fallback for a row with none.
      state = "no_spec";
      runOutcome = record.runOutcome;
      break;
  }

  const keepPrior = record.outcome === "kept_prior";
  const setOutcome = outcome !== null;
  const waiting = state === "waiting_manual";
  // A conflict with its card data is claimed for Tecfil like a verified spec (D12, amended by D24 F1).
  const conflictWithCards = state === "conflicting_sources" && typeof payload === "object" && payload !== null && "card" in payload;
  const takeTecfil = state === "verified" || conflictWithCards;
  const tecfilLeaseUntil = new Date(now.getTime() + options.leaseMs);
  const TAKE = sql`(${takeTecfil}::boolean AND pending_kind IS NULL AND (tecfil_state IS DISTINCT FROM 'ok' OR kind = 'refetch'))`;
  const PENDING = sql`(pending_kind IS NOT NULL)`;
  const NOW = sql`${now}::timestamptz`;
  const payloadJson = payload === null ? null : JSON.stringify(payload);

  const rows = await tx.$queryRaw<{ state: ResearchState; tecfil_state: TecfilState | null; tecfil_attempts: number; took_tecfil: boolean; requested_at: Date | null }[]>`
    UPDATE oil_research SET
      state = CASE WHEN ${PENDING} THEN 'queued' WHEN ${keepPrior}::boolean THEN COALESCE(outcome, ${state}::text) ELSE ${state}::text END,
      kind = COALESCE(pending_kind, kind),
      priority = COALESCE(pending_priority, priority),
      trigger = CASE pending_kind WHEN 'refetch' THEN 'refetch' WHEN 'manual_resolve' THEN 'manual_upgrade' ELSE trigger END,
      attempts = CASE WHEN ${PENDING} THEN 0 ELSE attempts END,
      requested_at = CASE WHEN ${PENDING} THEN pending_requested_at ELSE requested_at END,
      cycle_queued_at = CASE WHEN ${PENDING} THEN ${NOW} ELSE cycle_queued_at END,
      queued_at = CASE WHEN ${PENDING} OR ${state}::text = 'queued' THEN ${NOW} ELSE queued_at END,
      due_at = CASE WHEN ${PENDING} THEN NULL ELSE ${dueAt}::timestamptz END,
      lease_until = NULL,
      outcome = CASE WHEN ${setOutcome}::boolean THEN ${outcome}::text ELSE outcome END,
      outcome_payload = CASE WHEN ${setOutcome}::boolean THEN ${payloadJson}::jsonb ELSE outcome_payload END,
      finished_at = CASE WHEN ${setOutcome}::boolean OR ${keepPrior}::boolean THEN ${NOW} ELSE finished_at END,
      searched = CASE WHEN ${setOutcome}::boolean THEN ${searched}::boolean ELSE searched END,
      sources_read_at = COALESCE(${sourcesReadAt}::timestamptz, sources_read_at),
      wait_started_at = CASE
        WHEN ${PENDING} THEN NULL
        WHEN ${waiting}::boolean THEN ${NOW}
        WHEN ${state}::text = 'queued' THEN wait_started_at
        ELSE NULL END,
      manual_wait_until = CASE WHEN NOT ${PENDING} AND ${waiting}::boolean THEN ${waitUntil}::timestamptz END,
      expected_min_s = CASE WHEN ${PENDING} THEN NULL WHEN ${waiting}::boolean THEN ${waitEstimate?.minS ?? null}::int ELSE expected_min_s END,
      expected_max_s = CASE WHEN ${PENDING} THEN NULL WHEN ${waiting}::boolean THEN ${waitEstimate?.maxS ?? null}::int ELSE expected_max_s END,
      tecfil_state = CASE WHEN ${TAKE} THEN 'running' ELSE tecfil_state END,
      tecfil_lease_until = CASE WHEN ${TAKE} THEN ${tecfilLeaseUntil}::timestamptz ELSE tecfil_lease_until END,
      tecfil_attempts = CASE WHEN ${TAKE} THEN tecfil_attempts + 1 ELSE tecfil_attempts END,
      tecfil_due_at = CASE WHEN ${TAKE} THEN NULL ELSE tecfil_due_at END,
      ${clearEnginePickWhen(PENDING)}
      pending_kind = NULL,
      pending_priority = NULL,
      pending_requested_at = NULL,
      updated_at = ${NOW}
    WHERE id = ${claim.id} AND state = 'running' AND attempts = ${claim.attempts} AND current_run_id = ${claim.runId}
    RETURNING state, tecfil_state, tecfil_attempts, (${takeTecfil}::boolean AND tecfil_state = 'running' AND tecfil_lease_until = ${tecfilLeaseUntil}::timestamptz) AS took_tecfil, requested_at`;
  const updated = rows[0];
  if (!updated) return { status: "lost" };

  if (record.outcome === "verified") {
    await compatibilityCaches(tx).insertCompatibility(record.cacheRow);
  }
  await writeRun(tx, claim.runId, {
    ...progressData(options),
    finishedAt: now,
    outcome: runOutcome,
    incomplete: record.outcome === "verified" ? (record.incomplete ?? false) : record.outcome === "transient",
  });
  if (updated.state === "queued" && updated.requested_at) {
    await storeQueuedEstimate(tx, claim.id, now);
  }
  const tecfil: TecfilClaim | null = updated.took_tecfil
    ? {
        type: "tecfil",
        id: claim.id,
        identityKey: claim.identityKey,
        identity: claim.identity,
        priority: claim.priority,
        runId: claim.runId,
        tecfilAttempts: updated.tecfil_attempts,
        takeover: true,
        leaseUntil: tecfilLeaseUntil,
      }
    : null;
  return { status: "recorded", state: updated.state, runOutcome, tecfil };
}

/** The Tecfil step's outcome (D12). */
export type TecfilRecord =
  | { state: "ok"; row: Omit<TecfilCompatibility, "id"> }
  | { state: "unmatched"; field: string }
  /** A Tecfil failure, and an `unmatched` that followed a picker failure. */
  | { state: "unavailable" };

/**
 * Records a Tecfil claim's outcome, as a compare-and-set on `(id, tecfil_state = running,
 * current_run_id)`: `ok` inserts the Tecfil row and resets the Tecfil attempts; `unmatched`
 * keeps the field; `unavailable` is due again after 15 min, 1 h, 6 h, then every 24 h. The spec's
 * state and attempts are never touched.
 *
 * @returns False when the claim was lost, and nothing was written.
 */
export async function recordTecfil(tx: DbClient, claim: TecfilClaim, record: TecfilRecord, options: RunProgress & { now: Date }): Promise<boolean> {
  const { now } = options;
  const { count } = await tx.oilResearch.updateMany({
    where: { id: claim.id, tecfilState: "running", currentRunId: claim.runId },
    data: {
      tecfilState: record.state,
      tecfilLeaseUntil: null,
      tecfilAttempts: record.state === "ok" ? 0 : undefined,
      tecfilDueAt: record.state === "unavailable" ? new Date(now.getTime() + tecfilBackoffMs(claim.tecfilAttempts)) : null,
      tecfilUnmatchedField: record.state === "unmatched" ? record.field : null,
      updatedAt: now,
    },
  });
  if (count !== 1) return false;
  if (record.state === "ok") await compatibilityCaches(tx).insertTecfilCompatibility(record.row);
  const data = progressData(options);
  if (claim.takeover) {
    await writeRun(tx, claim.runId, data);
  } else {
    await writeRun(tx, claim.runId, { ...data, finishedAt: now, outcome: record.state });
  }
  return true;
}
