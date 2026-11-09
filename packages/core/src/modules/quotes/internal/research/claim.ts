/**
 * The claim (background-oil-research D8, D9, D12): under the runner-row lock, one due row by a
 * MATERIALIZED CTE with `FOR UPDATE` — a research claim (with adoption and
 * abandonment first) or a Tecfil claim, never two at once.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type DbClient } from "@select-lub/core/db";
import { configuredResearchModelKey } from "../model-calls/research-model.js";
import { budgetReached, daySpendUsd } from "./budget.js";
import { findAdoptable, type EnginePickCopy, type ResearchIdentity } from "./enqueue.js";
import { ENGINE_PICK_RUN_RANGE, loadPathTimings, storedEstimate, type StoredEstimate } from "./estimate.js";
import type { StoredPassage } from "./outcome.js";
import { identityKey } from "./identity-key.js";
import { sweepExpiredLeases } from "./release.js";
import { OIL_RESEARCH_MAX_ATTEMPTS, type ResearchKind, type ResearchTrigger } from "./research-states.js";
import { hasLiveLease, lockRunnerRow } from "./runner-row.js";

/** A research claim: the identity, the cycle, and what identifies the claim (D9). */
export type ResearchClaim = {
  type: "research";
  id: string;
  identityKey: string;
  identity: ResearchIdentity;
  kind: ResearchKind;
  trigger: ResearchTrigger;
  priority: number;
  /** Counted at the claim; with `runId`, what every later write compares. */
  attempts: number;
  runId: string;
  path: "search" | "manual" | "engine_pick";
  /**
   * An `engine_pick` cycle's copy (D24): the engine, the identity the clarification rested on,
   * the passages to re-read, and whether it reopened a resting outcome (G2). Null otherwise.
   */
  enginePick: (EnginePickCopy & { reopened: boolean }) | null;
  startedAt: Date;
  requestedAt: Date;
  cycleQueuedAt: Date;
  waitStartedAt: Date | null;
  leaseUntil: Date;
  estimate: StoredEstimate;
};

/** A Tecfil claim on a verified row (D12): never touches `state`, `attempts` or `lease_until`. */
export type TecfilClaim = {
  type: "tecfil";
  id: string;
  identityKey: string;
  identity: ResearchIdentity;
  priority: number;
  runId: string;
  tecfilAttempts: number;
  /** The claim a verified record took over, in the same run (D9, step 8). */
  takeover: boolean;
  leaseUntil: Date;
};

/**
 * - a research or Tecfil claim;
 * - `adopted`: a `full` cycle whose identity got an adoptable cache row after it was queued is
 *   recorded `verified` with no run row and no provider call;
 * - `abandoned`: a `full` cycle the sweep queued whose key no vehicle carries any more;
 * - `busy`: a research or Tecfil lease is live — one at a time (D8);
 * - `idle`: nothing is due.
 */
export type ClaimResult =
  | ResearchClaim
  | TecfilClaim
  | { type: "adopted"; id: string; identityKey: string }
  | { type: "abandoned"; id: string; identityKey: string }
  | { type: "busy" }
  | { type: "idle" };

/** What a claim tick is told by the runner. */
export type ClaimOptions = {
  now: Date;
  /** The research lease: `2 × max(OIL_RESEARCH_CALL_TIMEOUT_MS, WEB_SEARCH_TIMEOUT_MS) + 120 s` (D9). The Tecfil lease has the same length. */
  leaseMs: number;
  /** `OIL_RESEARCH_DAILY_BUDGET_USD`: at or above it, no priority-2 claim that spends (D8, D13). */
  budgetUsd: number;
  /** `OIL_RESEARCH_BACKFILL_PACE_MS`: a priority-2 claim only this long after the last run finished. */
  paceMs: number;
  maxAttempts?: number;
};

type DueRow = {
  id: string;
  identity_key: string;
  make: string;
  year: number;
  model: string;
  version: string;
  state: string;
  kind: ResearchKind;
  priority: number;
  trigger: ResearchTrigger;
  attempts: number;
  queued_at: Date;
  cycle_queued_at: Date;
  requested_at: Date | null;
  wait_started_at: Date | null;
  tecfil_attempts: number;
  engine_pick_engine: string | null;
  engine_pick_from: string | null;
  engine_pick_passages: StoredPassage[] | null;
  engine_pick_reopened: boolean;
};

/**
 * How long a queued `engine_pick` whose key no vehicle carries is held before it is abandoned (D24):
 * the route enqueues it just before it writes the corrected version, so a claim in between must
 * not abandon it; a version write that failed leaves it to be abandoned after this.
 */
export const ENGINE_PICK_ABANDON_GRACE_MS = 60_000;

/**
 * A row the Tecfil claim may take (D12, amended by D24 F1): a verified spec, or a conflict recorded
 * with its card data, whose cards' filters must price.
 */
export const TECFIL_ROW_SQL = Prisma.sql`(state = 'verified' OR (state = 'conflicting_sources' AND outcome_payload -> 'card' IS NOT NULL))`;

/** Whether some vehicle with complete fields still carries the key (`vehicle` is readable by every module). */
async function someVehicleCarries(tx: DbClient, key: string, year: number): Promise<boolean> {
  const vehicles = await tx.vehicle.findMany({
    where: { year, make: { not: null }, model: { not: null }, version: { not: null } },
    select: { make: true, year: true, model: true, version: true },
  });
  return vehicles.some((vehicle) => identityKey(vehicle) === key);
}

/**
 * One claim tick (D8, D9): expired leases are swept first; then, under the runner-row lock and
 * only while no research or Tecfil lease is live, one due row is selected by a MATERIALIZED CTE
 * with `FOR UPDATE` and claimed. The claim commits with the caller's transaction,
 * before any provider call.
 *
 * Due: `queued` with `due_at` null or past (research), or `verified` with its Tecfil `pending` or
 * `unavailable` and `tecfil_due_at` null or past (Tecfil). A priority-2 row is due only once the
 * pace has passed since the last run finished, and a priority-2 research only below the budget;
 * priority 0 and 1 are exempt from both.
 */
export async function claimNextResearch(tx: DbClient, options: ClaimOptions): Promise<ClaimResult> {
  const { now, leaseMs } = options;
  const maxAttempts = options.maxAttempts ?? OIL_RESEARCH_MAX_ATTEMPTS;
  await lockRunnerRow(tx, now);
  await sweepExpiredLeases(tx, now, maxAttempts);

  if (await hasLiveLease(tx, now)) return { type: "busy" };

  const [spend, last] = await Promise.all([
    daySpendUsd(tx, now),
    tx.$queryRaw<{ at: Date | null }[]>`SELECT MAX(finished_at) AS at FROM oil_research_run WHERE path <> 'reading'`,
  ]);
  const lastFinishedAt = last[0]?.at ?? null;
  const paced = lastFinishedAt === null || now.getTime() - lastFinishedAt.getTime() >= options.paceMs;
  const capped = budgetReached(spend, options.budgetUsd);

  // A MATERIALIZED CTE: `IN (SELECT … LIMIT n FOR UPDATE)` can over-claim under a generic plan.
  // No SKIP LOCKED: the runner-row lock already serialises claimers, and an enqueue holds a row
  // lock even when its `DO UPDATE … WHERE` writes nothing — SKIP LOCKED would pass over an
  // attended row a quote-open is touching and take a backfill row instead. So the claim waits
  // for that short enqueue, then takes the row in order.
  const due = await tx.$queryRaw<DueRow[]>`
    WITH due AS MATERIALIZED (
      SELECT id FROM oil_research
      WHERE ((state = 'queued' AND (due_at IS NULL OR due_at <= ${now}))
          OR (${TECFIL_ROW_SQL} AND tecfil_state IN ('pending', 'unavailable')
              AND (tecfil_due_at IS NULL OR tecfil_due_at <= ${now})))
        AND (priority < 2 OR (${paced}::boolean AND (state <> 'queued' OR NOT ${capped}::boolean)))
      ORDER BY priority, requested_at NULLS LAST, queued_at, id
      LIMIT 1
      FOR UPDATE
    )
    SELECT r.id, r.identity_key, r.make, r.year, r.model, r.version, r.state, r.kind, r.priority, r.trigger,
      r.attempts, r.queued_at, r.cycle_queued_at, r.requested_at, r.wait_started_at, r.tecfil_attempts,
      r.engine_pick_engine, r.engine_pick_from, r.engine_pick_passages, r.engine_pick_reopened
    FROM oil_research AS r JOIN due ON due.id = r.id`;
  const row = due[0];
  if (!row) return { type: "idle" };
  const identity: ResearchIdentity = { make: row.make, year: row.year, model: row.model, version: row.version };
  const runId = randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  if (row.state !== "queued") {
    const { count } = await tx.oilResearch.updateMany({
      where: { id: row.id, state: row.state, tecfilState: { in: ["pending", "unavailable"] } },
      data: { tecfilState: "running", tecfilLeaseUntil: leaseUntil, currentRunId: runId, tecfilAttempts: { increment: 1 }, updatedAt: now },
    });
    if (count !== 1) return { type: "idle" };
    await insertRun(tx, { runId, row, kind: "tecfil_only", path: "tecfil", startedAt: now });
    return { type: "tecfil", id: row.id, identityKey: row.identity_key, identity, priority: row.priority, runId, tecfilAttempts: row.tecfil_attempts + 1, takeover: false, leaseUntil };
  }

  if (row.kind === "full") {
    const adoptable = await findAdoptable(tx, identity, row.cycle_queued_at);
    if (adoptable) {
      await tx.oilResearch.updateMany({
        where: { id: row.id, state: "queued" },
        data: {
          state: "verified",
          trigger: "adopted",
          outcome: "verified",
          outcomePayload: Prisma.DbNull,
          finishedAt: now,
          sourcesReadAt: adoptable.consultedAt,
          dueAt: null,
          expectedMinS: null,
          expectedMaxS: null,
          tecfilState: adoptable.tecfilOk ? "ok" : "pending",
          tecfilDueAt: null,
          updatedAt: now,
        },
      });
      return { type: "adopted", id: row.id, identityKey: row.identity_key };
    }
    if ((row.trigger === "registration" || row.trigger === "backfill") && !(await someVehicleCarries(tx, row.identity_key, row.year))) {
      await tx.oilResearch.updateMany({
        where: { id: row.id, state: "queued" },
        data: { state: "abandoned", outcome: "abandoned", outcomePayload: Prisma.DbNull, finishedAt: now, dueAt: null, expectedMinS: null, expectedMaxS: null, updatedAt: now },
      });
      return { type: "abandoned", id: row.id, identityKey: row.identity_key };
    }
  }

  // An engine pick's cycle — its re-read, or the G1 fallback `full` it queued — whose key no vehicle
  // carries yet (orchestrator, 2026-10-01: the G1 fallback gets the same grace).
  const pickCycle = row.kind === "engine_pick" || (row.kind === "full" && row.trigger === "engine_pick");
  if (pickCycle && !(await someVehicleCarries(tx, row.identity_key, row.year))) {
    // The route writes the corrected version right after it enqueues; a pick whose version write
    // failed leaves a key no car carries, abandoned once the grace has passed (D24).
    const graceEnds = new Date(row.cycle_queued_at.getTime() + ENGINE_PICK_ABANDON_GRACE_MS);
    if (now < graceEnds) {
      await tx.oilResearch.updateMany({ where: { id: row.id, state: "queued" }, data: { dueAt: graceEnds, updatedAt: now } });
      return { type: "idle" };
    }
    await tx.oilResearch.updateMany({
      where: { id: row.id, state: "queued" },
      data: { state: "abandoned", outcome: "abandoned", outcomePayload: Prisma.DbNull, finishedAt: now, dueAt: null, expectedMinS: null, expectedMaxS: null, updatedAt: now },
    });
    return { type: "abandoned", id: row.id, identityKey: row.identity_key };
  }

  const path: ResearchClaim["path"] = row.kind === "manual_resolve" ? "manual" : row.kind === "engine_pick" ? "engine_pick" : "search";
  const requestedAt = row.requested_at ?? now;
  // D14's second moment: (started_at − requested_at) + the path's run range, no queue term. An
  // engine re-read is in neither sample: its estimate is the fixed 1–2 minutes (D14, D24).
  const range = path === "engine_pick" ? ENGINE_PICK_RUN_RANGE : (await loadPathTimings(tx, path, now)).range;
  const estimate = storedEstimate((now.getTime() - requestedAt.getTime()) / 1000, 0, range);
  const { count } = await tx.oilResearch.updateMany({
    where: { id: row.id, state: "queued", attempts: row.attempts },
    data: {
      state: "running",
      attempts: { increment: 1 },
      currentRunId: runId,
      startedAt: now,
      requestedAt,
      leaseUntil,
      expectedMinS: estimate.minS,
      expectedMaxS: estimate.maxS,
      updatedAt: now,
    },
  });
  if (count !== 1) return { type: "idle" };
  await insertRun(tx, { runId, row: { ...row, requested_at: requestedAt }, kind: row.kind, path, startedAt: now });
  return {
    type: "research",
    id: row.id,
    identityKey: row.identity_key,
    identity,
    kind: row.kind,
    trigger: row.trigger,
    priority: row.priority,
    attempts: row.attempts + 1,
    runId,
    path,
    enginePick:
      row.kind === "engine_pick" && row.engine_pick_engine && row.engine_pick_passages?.length
        ? { engine: row.engine_pick_engine, from: row.engine_pick_from ?? "", passages: row.engine_pick_passages, reopened: row.engine_pick_reopened }
        : null,
    startedAt: now,
    requestedAt,
    cycleQueuedAt: row.cycle_queued_at,
    waitStartedAt: row.wait_started_at,
    leaseUntil,
    estimate,
  };
}

async function insertRun(
  tx: DbClient,
  input: { runId: string; row: DueRow; kind: string; path: string; startedAt: Date },
): Promise<void> {
  const { row } = input;
  await tx.oilResearchRun.create({
    data: {
      id: input.runId,
      researchId: row.id,
      identityKey: row.identity_key,
      kind: input.kind,
      trigger: row.trigger,
      path: input.path,
      queuedAt: row.queued_at,
      cycleQueuedAt: row.cycle_queued_at,
      requestedAt: row.requested_at,
      waitStartedAt: input.path === "manual" ? row.wait_started_at : null,
      startedAt: input.startedAt,
      // Fixed at claim, whether or not the run makes a model call (switch-oil-research-to-openai D7).
      researchModel: configuredResearchModelKey(),
    },
  });
}
