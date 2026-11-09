/**
 * Releases, the expired-lease sweep and the end of a manual wait (background-oil-research D9,
 * D11, D12, D19). A release refunds the attempt; an expired lease keeps it counted; a Tecfil
 * claim's release or expiry goes back to Tecfil `pending` and never touches the spec.
 */
import { Prisma, type DbClient } from "@select-lub/core/db";
import type { ResearchClaim, TecfilClaim } from "./claim.js";
import { clearEnginePickWhen, sql, stronger } from "./kinds-sql.js";
import { storeQueuedEstimate } from "./enqueue.js";
import { OIL_RESEARCH_MAX_ATTEMPTS } from "./research-states.js";
import { progressData, writeRun, type RunProgress } from "./run-progress.js";

/** What a release is told: the spend so far, and when the row is due again (a rate limit's `Retry-After`). */
export type ReleaseOptions = RunProgress & { now: Date; dueAt?: Date | null };

/**
 * Releases a research claim (D8's rate limit, D9's provider pause, D19's shutdown): the row is
 * `queued` again with the attempt refunded, due at `dueAt` (now when absent), and the run row
 * gets `outcome = released` with the spend metered so far. A pending manual upgrade is merged in
 * (the stronger kind, the lower priority); a pending refetch starts its own cycle: attempts 0,
 * `requested_at` = `pending_requested_at`, and its estimate stored.
 *
 * @returns False when the claim was lost, and nothing was written.
 */
export async function releaseResearch(tx: DbClient, claim: ResearchClaim, options: ReleaseOptions): Promise<boolean> {
  const { now } = options;
  const NOW = sql`${now}::timestamptz`;
  const NEW_CYCLE = sql`(COALESCE(pending_kind = 'refetch' AND kind <> 'refetch', false))`;
  const rows = await tx.$queryRaw<{ new_cycle: boolean; requested_at: Date | null }[]>`
    UPDATE oil_research SET
      state = 'queued',
      kind = ${stronger(sql`kind`, sql`COALESCE(pending_kind, kind)`)},
      priority = LEAST(priority, COALESCE(pending_priority, priority)),
      trigger = CASE WHEN ${NEW_CYCLE} THEN 'refetch' ELSE trigger END,
      attempts = CASE WHEN ${NEW_CYCLE} THEN 0 ELSE GREATEST(attempts - 1, 0) END,
      cycle_queued_at = CASE WHEN ${NEW_CYCLE} THEN ${NOW} ELSE cycle_queued_at END,
      queued_at = CASE WHEN ${NEW_CYCLE} THEN ${NOW} ELSE queued_at END,
      requested_at = CASE WHEN ${NEW_CYCLE} THEN pending_requested_at ELSE COALESCE(requested_at, pending_requested_at) END,
      wait_started_at = CASE WHEN ${NEW_CYCLE} THEN NULL ELSE wait_started_at END,
      expected_min_s = CASE WHEN ${NEW_CYCLE} THEN NULL ELSE expected_min_s END,
      expected_max_s = CASE WHEN ${NEW_CYCLE} THEN NULL ELSE expected_max_s END,
      due_at = CASE WHEN ${NEW_CYCLE} THEN NULL ELSE ${options.dueAt ?? null}::timestamptz END,
      lease_until = NULL,
      ${clearEnginePickWhen(NEW_CYCLE)}
      pending_kind = NULL,
      pending_priority = NULL,
      pending_requested_at = NULL,
      updated_at = ${NOW}
    WHERE id = ${claim.id} AND state = 'running' AND attempts = ${claim.attempts} AND current_run_id = ${claim.runId}
    RETURNING (cycle_queued_at = ${NOW}) AS new_cycle, requested_at`;
  const released = rows[0];
  if (!released) return false;
  await writeRun(tx, claim.runId, { ...progressData(options), finishedAt: now, outcome: "released" });
  // A pending refetch started its own cycle: D14's first moment for it.
  if (released.new_cycle && released.requested_at) await storeQueuedEstimate(tx, claim.id, now);
  return true;
}

/**
 * Releases a Tecfil claim: its Tecfil state goes back to `pending`, due at `dueAt` (now when
 * absent), with its Tecfil attempt refunded; the spec's state is untouched (D19).
 *
 * @returns False when the claim was lost, and nothing was written.
 */
export async function releaseTecfil(tx: DbClient, claim: TecfilClaim, options: ReleaseOptions): Promise<boolean> {
  const { now } = options;
  const { count } = await tx.oilResearch.updateMany({
    where: { id: claim.id, tecfilState: "running", currentRunId: claim.runId },
    data: { tecfilState: "pending", tecfilLeaseUntil: null, tecfilDueAt: options.dueAt ?? null, tecfilAttempts: { decrement: 1 }, updatedAt: now },
  });
  if (count !== 1) return false;
  const data = progressData(options);
  await writeRun(tx, claim.runId, claim.takeover ? data : { ...data, finishedAt: now, outcome: "released" });
  return true;
}

/**
 * The expired-lease sweep (D9, step 5). A `running` row whose lease has passed is `queued` again,
 * due now, while its cycle has attempts left, and `failed` when it has none. A pending cycle
 * starts instead — a refetch on a non-refetch cycle, or any pending kind once the cycle is out of
 * attempts (recorded `failed`, as the recorder records an outcome) — with its own kind, priority
 * and `requested_at`, and its estimate stored. A row whose Tecfil lease has passed goes back to Tecfil `pending`, due now,
 * with its spec state, attempts and cache rows untouched — never queued for research. The run rows
 * of both are closed as `lost`.
 *
 * @returns How many research and Tecfil leases were swept.
 */
export async function sweepExpiredLeases(tx: DbClient, now: Date, maxAttempts: number = OIL_RESEARCH_MAX_ATTEMPTS): Promise<{ research: number; tecfil: number }> {
  const NOW = sql`${now}::timestamptz`;
  // The pending cycle starts: a refetch on a non-refetch cycle, or any pending kind once the
  // cycle has no attempts left (a pending manual upgrade must not die with a failed cycle).
  const NEW_CYCLE = sql`(pending_kind IS NOT NULL AND ((pending_kind = 'refetch' AND kind <> 'refetch') OR attempts >= ${maxAttempts}))`;
  // An engine pick that reopened a resting outcome keeps it when it cannot verify (G2), a crash included.
  const KEEP = sql`(kind = 'engine_pick' AND engine_pick_reopened AND outcome IS NOT NULL)`;
  const OUT = sql`(attempts >= ${maxAttempts} AND NOT ${KEEP})`;
  const EXHAUSTED = sql`(NOT ${NEW_CYCLE} AND attempts >= ${maxAttempts})`;
  const research = await tx.$queryRaw<{ id: string; run_id: string | null; new_cycle: boolean; requested_at: Date | null }[]>`
    WITH expired AS (
      SELECT id, current_run_id FROM oil_research WHERE state = 'running' AND lease_until <= ${now} FOR UPDATE
    )
    UPDATE oil_research AS r SET
      state = CASE WHEN ${EXHAUSTED} AND ${KEEP} THEN outcome WHEN ${EXHAUSTED} THEN 'failed' ELSE 'queued' END,
      kind = CASE
        WHEN ${NEW_CYCLE} THEN pending_kind
        WHEN ${EXHAUSTED} THEN kind
        ELSE ${stronger(sql`kind`, sql`COALESCE(pending_kind, kind)`)} END,
      priority = CASE
        WHEN ${NEW_CYCLE} THEN pending_priority
        WHEN ${EXHAUSTED} THEN priority
        ELSE LEAST(priority, COALESCE(pending_priority, priority)) END,
      trigger = CASE WHEN ${NEW_CYCLE} THEN (CASE pending_kind WHEN 'refetch' THEN 'refetch' ELSE 'manual_upgrade' END) ELSE trigger END,
      attempts = CASE WHEN ${NEW_CYCLE} THEN 0 ELSE attempts END,
      cycle_queued_at = CASE WHEN ${NEW_CYCLE} THEN ${NOW} ELSE cycle_queued_at END,
      queued_at = CASE WHEN ${NEW_CYCLE} THEN ${NOW} ELSE queued_at END,
      requested_at = CASE
        WHEN ${NEW_CYCLE} THEN pending_requested_at
        WHEN ${EXHAUSTED} THEN requested_at
        ELSE COALESCE(requested_at, pending_requested_at) END,
      wait_started_at = CASE WHEN ${NEW_CYCLE} THEN NULL ELSE wait_started_at END,
      expected_min_s = CASE WHEN ${NEW_CYCLE} THEN NULL ELSE expected_min_s END,
      expected_max_s = CASE WHEN ${NEW_CYCLE} THEN NULL ELSE expected_max_s END,
      outcome = CASE WHEN ${OUT} THEN 'failed' ELSE outcome END,
      outcome_payload = CASE WHEN ${OUT} THEN NULL ELSE outcome_payload END,
      finished_at = CASE WHEN attempts >= ${maxAttempts} THEN ${NOW} ELSE finished_at END,
      due_at = NULL,
      lease_until = NULL,
      ${clearEnginePickWhen(NEW_CYCLE)}
      pending_kind = NULL,
      pending_priority = NULL,
      pending_requested_at = NULL,
      updated_at = ${NOW}
    FROM expired WHERE r.id = expired.id
    RETURNING r.id, expired.current_run_id AS run_id, (r.cycle_queued_at = ${NOW}) AS new_cycle, r.requested_at`;
  const tecfil = await tx.$queryRaw<{ run_id: string | null }[]>`
    UPDATE oil_research SET tecfil_state = 'pending', tecfil_lease_until = NULL, tecfil_due_at = NULL, updated_at = ${NOW}
    WHERE tecfil_state = 'running' AND tecfil_lease_until <= ${now}
    RETURNING current_run_id AS run_id`;
  const runIds = [...research, ...tecfil].map((row) => row.run_id).filter((id): id is string => id !== null);
  if (runIds.length > 0) {
    await tx.oilResearchRun.updateMany({ where: { id: { in: runIds }, finishedAt: null }, data: { finishedAt: now, outcome: "lost" } });
  }
  // D14's first moment for each pending cycle the sweep started.
  for (const row of research) {
    if (row.new_cycle && row.requested_at) await storeQueuedEstimate(tx, row.id, now);
  }
  return { research: research.length, tecfil: tecfil.length };
}

/**
 * Ends a manual wait (D11): the row is `queued` as a `manual_resolve`, trigger `wait_ended`, at
 * its cycle's priority and `requested_at`, with attempts 0 — the re-resolve is a cycle of its
 * own. `wait_started_at` stays for the re-resolve's run row (the manual path's duration). The
 * runner decides when (every reading ended, or the deadline passed).
 *
 * @returns False when the row was no longer waiting.
 */
export async function endManualWait(tx: DbClient, id: string, now: Date): Promise<boolean> {
  const { count } = await tx.oilResearch.updateMany({
    where: { id, state: "waiting_manual" },
    data: {
      state: "queued", kind: "manual_resolve", trigger: "wait_ended", attempts: 0, cycleQueuedAt: now, queuedAt: now, dueAt: null, manualWaitUntil: null,
      // A cycle of its own clears an engine pick's copy (orchestrator, 2026-10-01).
      enginePickEngine: null, enginePickFrom: null, enginePickPassages: Prisma.DbNull, enginePickReopened: false,
      updatedAt: now,
    },
  });
  return count === 1;
}
