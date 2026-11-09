/**
 * The one enqueue (background-oil-research D7): every caller — the sweep, a quote-open, the
 * refetch POST, the manual-upgrade check — goes through {@link enqueueResearch}, one
 * `INSERT … ON CONFLICT (identity_key) DO UPDATE … WHERE`. Also the queue position
 * ({@link rowsAhead}) and D14's first stored moment.
 */
import { randomUUID } from "node:crypto";
import type { DbClient } from "@select-lub/core/db";
import { motulIdentitiesMatch } from "../../../../kernel/clients/motul/index.js";
import { readRunnerStatus, runnerCanSearch } from "../../contracts/oil-research-attention.js";
import { loadPathTimings, queueTermS, storedEstimate, type EstimatePath } from "./estimate.js";
import { identityKey, type IdentityFields } from "./identity-key.js";
import { sql, stronger } from "./kinds-sql.js";
import type { StoredPassage } from "./outcome.js";
import {
  DEFAULT_MISS_TTL_MS,
  FAILED_RERUN_AFTER_MS,
  type EnqueueTrigger,
  type ResearchKind,
  type ResearchPriority,
  type ResearchState,
} from "./research-states.js";

/** A complete identity, in the spelling a caller has. */
export type ResearchIdentity = { make: string; year: number; model: string; version: string };

/** What a caller asks for. `refetch` goes with trigger `refetch`; `manual_upgrade` with kind `manual_resolve`. */
export type EnqueueRequest = {
  identity: IdentityFields;
  kind: ResearchKind;
  priority: ResearchPriority;
  trigger: EnqueueTrigger;
  /**
   * An `engine_pick` cycle's copy (D24): the engine, the identity key the clarification rested
   * on, and its passages. Required with kind `engine_pick`, and written onto the row only with the
   * cycle it starts.
   */
  enginePick?: EnginePickCopy;
};

/** What an `engine_pick` row carries (D10, D24). */
export type EnginePickCopy = { engine: string; from: string; passages: StoredPassage[] };

/** Which callers may start a new cycle on a resting row, and when (D10). */
export type RerunPolicy = { missTtlMs: number; failedRerunAfterMs: number };

export const DEFAULT_RERUN_POLICY: RerunPolicy = { missTtlMs: DEFAULT_MISS_TTL_MS, failedRerunAfterMs: FAILED_RERUN_AFTER_MS };

/** The row an enqueue wrote. */
export type EnqueuedRow = {
  id: string;
  identityKey: string;
  state: ResearchState;
  kind: ResearchKind;
  priority: number;
  requestedAt: Date | null;
  /** The statement inserted the row, rather than updating it. */
  inserted: boolean;
};

/**
 * - `incomplete`: an identity missing a field; nothing is written.
 * - `unchanged`: the row already said all of it; nothing was written.
 * - `written`: the row was inserted or changed.
 */
export type EnqueueResult =
  | { status: "incomplete" }
  | { status: "unchanged"; identityKey: string }
  | { status: "written"; row: EnqueuedRow };

/** The latest adoptable cache row for an identity: provenance and a grade list (D7). */
export type AdoptableRow = { consultedAt: Date; tecfilOk: boolean };

const ADOPTABLE_SELECT = { make: true, year: true, model: true, version: true, sourcePublisher: true, viscosities: true, consultedAt: true } as const;

/**
 * Finds the latest adoptable `motul_compatibility` row matching the identity: `source_publisher`
 * non-empty and `viscosities` non-null. A historical row (only `viscosity`, no provenance) is not.
 *
 * @param after - Only a row consulted after this instant counts (a claim's adoption).
 */
export async function findAdoptable(tx: DbClient, identity: ResearchIdentity, after?: Date): Promise<AdoptableRow | null> {
  const rows = await tx.motulCompatibility.findMany({ where: { year: identity.year }, select: ADOPTABLE_SELECT });
  const adoptable = rows
    .filter((row) => motulIdentitiesMatch(row, identity))
    .filter((row) => (row.sourcePublisher ?? "").trim() !== "" && row.viscosities !== null)
    .filter((row) => after === undefined || row.consultedAt > after)
    .sort((a, b) => b.consultedAt.getTime() - a.consultedAt.getTime());
  const latest = adoptable[0];
  if (!latest) return null;
  const tecfil = await tx.tecfilCompatibility.findMany({ where: { year: identity.year }, select: { make: true, year: true, model: true, version: true } });
  return { consultedAt: latest.consultedAt, tecfilOk: tecfil.some((row) => motulIdentitiesMatch(row, identity)) };
}

function completeIdentity(identity: IdentityFields): ResearchIdentity | null {
  if (identityKey(identity) === null) return null;
  return { make: identity.make!.trim(), year: identity.year!, model: identity.model!.trim(), version: identity.version!.trim() };
}

function assertRequest(request: EnqueueRequest): void {
  const refetchPair = (request.kind === "refetch") === (request.trigger === "refetch");
  const upgradePair = request.trigger !== "manual_upgrade" || request.kind === "manual_resolve";
  // An engine pick queues its re-read, or a full research when the clarification kept no passages (G1).
  const pickPair =
    (request.kind !== "engine_pick" || (request.trigger === "engine_pick" && (request.enginePick?.passages.length ?? 0) > 0)) &&
    (request.trigger !== "engine_pick" || request.kind === "engine_pick" || request.kind === "full");
  if (!refetchPair || !upgradePair || !pickPair) {
    throw new Error(`oil research: kind ${request.kind} does not go with trigger ${request.trigger}`);
  }
}

/**
 * The one enqueue (D7): every caller — the sweep, a quote-open, the refetch POST, the manual
 * upgrade check — goes through this statement. No caller reads the research row and then writes.
 *
 * | The row is | The enqueue |
 * |---|---|
 * | absent | inserts it: `verified` / `adopted` when adoptable and not a refetch; else `queued` |
 * | `queued` | priority = LEAST, kind = the stronger; a refetch also makes it due now, attempts 0 |
 * | `running` | a refetch (on a non-refetch run) or a manual upgrade sets `pending_*`; nothing else |
 * | `waiting_manual` | a refetch on a non-refetch cycle ends the wait as a queued refetch; a quote-open lowers the priority |
 * | `verified` | a new cycle for a refetch or a manual upgrade; a quote-open with Tecfil due sets priority 0 |
 * | resting | a new cycle when D10's re-run policy allows this caller |
 *
 * Two quote-open rules (orchestrator rulings, review of #188): with an adoptable row to show, it
 * promotes neither a queued `manual_resolve` nor a manual wait (unless a later conflict or
 * clarification hides the row); and it re-opens a no-source recorded "not searched" only while
 * the runner's fresh heartbeat says it can web-search.
 *
 * When the write leaves a queued row with a `requested_at`, the estimate is stored (D14's first
 * moment), in the same transaction.
 */
export async function enqueueResearch(
  tx: DbClient,
  request: EnqueueRequest,
  now: Date,
  policy: RerunPolicy = DEFAULT_RERUN_POLICY,
): Promise<EnqueueResult> {
  assertRequest(request);
  const identity = completeIdentity(request.identity);
  const key = identityKey(request.identity);
  if (!identity || !key) return { status: "incomplete" };

  // A read of the caches, not of the research row: which rows exist decides only the insert.
  const adoptable = request.kind === "refetch" ? null : await findAdoptable(tx, identity);
  const adopt = adoptable !== null;
  const K = sql`${request.kind}::text`;
  const P = sql`${request.priority}::int`;
  const T = sql`${request.trigger}::text`;
  const NOW = sql`${now}::timestamptz`;
  const missBefore = new Date(now.getTime() - policy.missTtlMs);
  const failedBefore = new Date(now.getTime() - policy.failedRerunAfterMs);
  // A no-source recorded "not searched" is re-opened by a quote-open only while the runner's fresh
  // heartbeat says it can search (orchestrator ruling, review of #188): otherwise every 3 s poll of
  // an open dialog would re-queue it at 0, spend a run each time, and starve the runner.
  const canSearch = request.trigger === "quote_open" && runnerCanSearch(await readRunnerStatus(tx), now);
  const SEARCH_OK = sql`${canSearch}::boolean`;

  // A new cycle from a row that is not queued (D7, D10).
  const NC = sql`(
    (r.state = 'waiting_manual' AND ${K} = 'refetch' AND r.kind <> 'refetch')
    OR (r.state = 'verified' AND (${K} = 'refetch' OR ${T} = 'manual_upgrade'))
    OR (r.state = 'no_spec' AND (${K} = 'refetch' OR ${T} = 'manual_upgrade'
        OR (${T} = 'quote_open' AND ((r.searched = false AND ${SEARCH_OK})
          OR (r.searched = true AND r.finished_at <= ${missBefore}::timestamptz)))))
    OR (r.state = 'failed' AND (${K} = 'refetch' OR ${T} = 'manual_upgrade'
        OR (${T} = 'quote_open' AND r.finished_at <= ${failedBefore}::timestamptz)))
    OR (r.state IN ('needs_clarification', 'conflicting_sources') AND (${K} = 'refetch' OR ${T} = 'manual_upgrade'))
    OR (r.state = 'abandoned' AND (${K} = 'refetch' OR ${T} IN ('quote_open', 'registration', 'backfill')))
    OR (r.state IN ('no_spec', 'needs_clarification', 'conflicting_sources', 'failed', 'abandoned') AND ${T} = 'engine_pick')
  )`;
  // An engine pick that reopens a resting outcome (G2): a re-read that does not verify keeps it.
  const REOPENS = sql`(${K} = 'engine_pick' AND r.state IN ('no_spec', 'needs_clarification', 'conflicting_sources', 'failed'))`;
  // A quote-open that shows an adoptable row does not promote the manual path (orchestrator ruling,
  // review of #188): a queued `manual_resolve` (an upgrade or a wait's re-resolve) and a manual wait
  // keep their priority, so the quote does not say a new search is under way. A queued sweep `full`
  // cycle IS promoted, so the next tick adopts it for free and claims Tecfil at 0. And there is no
  // hold when a later conflict or clarification hides the row, since then no row is shown.
  const showsAdoptable = request.trigger === "quote_open" && adoptable !== null;
  const ADOPTED_AT = sql`${adoptable?.consultedAt ?? null}::timestamptz`;
  const HOLD = sql`(${showsAdoptable}::boolean
    AND (r.kind = 'manual_resolve' OR r.state = 'waiting_manual')
    AND NOT (r.outcome IN ('needs_clarification', 'conflicting_sources') AND r.finished_at > ${ADOPTED_AT}))`;
  // A queued cycle that becomes one of its own, due now, attempts 0: a refetch on a non-refetch
  // cycle, and an engine pick on a queued `full` or `manual_resolve` (G2, orchestrator 2026-09-30),
  // which takes the copied passages. A queued refetch or engine pick meeting an engine pick is QP.
  const QR = sql`(r.state = 'queued' AND ((${K} = 'refetch' AND r.kind <> 'refetch')
    OR (${K} = 'engine_pick' AND r.kind IN ('full', 'manual_resolve'))))`;
  // Any other enqueue on a queued row: the lower priority and the stronger kind.
  const QP = sql`(r.state = 'queued' AND NOT ${HOLD} AND NOT ${QR})`;
  // A running row takes a refetch (unless it is one) or a manual upgrade as its pending cycle.
  const RUN = sql`(r.state = 'running' AND ((${K} = 'refetch' AND r.kind <> 'refetch') OR ${K} = 'manual_resolve'))`;
  // An engine pick on a running row: the run is kept and moved to the front; the pick is dropped (G2).
  const RP = sql`(r.state = 'running' AND ${T} = 'engine_pick')`;
  // A quote-open (or an engine pick) on a wait: the priority only.
  const WQ = sql`(r.state = 'waiting_manual' AND ${T} IN ('quote_open', 'engine_pick') AND NOT ${HOLD})`;
  // A quote-open (or an engine pick) on a verified row whose Tecfil is still to be consulted: its Tecfil claim to the front.
  // A conflict with its card data is claimed for Tecfil like a verified spec, so it is promoted alike (D12 as amended).
  const VT = sql`((r.state = 'verified' OR (r.state = 'conflicting_sources' AND r.outcome_payload -> 'card' IS NOT NULL))
    AND ${T} IN ('quote_open', 'engine_pick') AND r.tecfil_state IN ('pending', 'unavailable'))`;
  // The engine pick's copy (D24): written with the cycle it starts, cleared by a cycle of another kind.
  const pick = request.kind === "engine_pick" ? request.enginePick! : null;
  const ENGINE = sql`${pick?.engine ?? null}::text`;
  const FROM = sql`${pick?.from ?? null}::text`;
  const PASSAGES = sql`${pick ? JSON.stringify(pick.passages) : null}::jsonb`;
  const LOWER = sql`LEAST(r.priority, ${P})`;
  const PENDING_KIND = sql`(CASE WHEN r.pending_kind IS NULL THEN ${K} ELSE ${stronger(sql`r.pending_kind`, K)} END)`;
  const PENDING_PRIORITY = sql`LEAST(COALESCE(r.pending_priority, ${P}), ${P})`;
  const REQUESTED_IF_ATTENDED = sql`(CASE WHEN ${P} <= 1 THEN ${NOW} END)`;

  const rows = await tx.$queryRaw<
    { id: string; identity_key: string; state: ResearchState; kind: ResearchKind; priority: number; requested_at: Date | null; inserted: boolean }[]
  >`
    INSERT INTO oil_research AS r (
      id, identity_key, make, year, model, version, state, kind, priority, trigger, attempts,
      queued_at, cycle_queued_at, requested_at, finished_at, outcome, sources_read_at, tecfil_state,
      engine_pick_engine, engine_pick_from, engine_pick_passages,
      created_at, updated_at)
    VALUES (
      ${randomUUID()}, ${key}, ${identity.make}, ${identity.year}, ${identity.model}, ${identity.version},
      ${adopt ? "verified" : "queued"}::text,
      ${adopt ? "full" : request.kind}::text,
      ${P},
      ${adopt ? "adopted" : request.trigger}::text,
      0, ${NOW}, ${NOW},
      ${adopt || request.priority > 1 ? null : now}::timestamptz,
      ${adopt ? now : null}::timestamptz,
      ${adopt ? "verified" : null}::text,
      ${adoptable?.consultedAt ?? null}::timestamptz,
      ${adoptable ? (adoptable.tecfilOk ? "ok" : "pending") : null}::text,
      ${adopt ? null : (pick?.engine ?? null)}::text, ${adopt ? null : (pick?.from ?? null)}::text,
      ${adopt || !pick ? null : JSON.stringify(pick.passages)}::jsonb,
      ${NOW}, ${NOW})
    ON CONFLICT (identity_key) DO UPDATE SET
      state = CASE WHEN ${NC} THEN 'queued' ELSE r.state END,
      kind = CASE WHEN ${NC} OR ${QR} THEN ${K} WHEN ${QP} THEN ${stronger(sql`r.kind`, K)} ELSE r.kind END,
      priority = CASE WHEN ${NC} THEN ${P} WHEN ${QR} OR ${QP} OR ${WQ} OR ${VT} OR ${RP} THEN ${LOWER} ELSE r.priority END,
      trigger = CASE WHEN ${NC} OR ${QR} THEN ${T} WHEN ${QP} AND ${P} < r.priority THEN ${T} ELSE r.trigger END,
      attempts = CASE WHEN ${NC} OR ${QR} THEN 0 ELSE r.attempts END,
      due_at = CASE WHEN ${NC} OR ${QR} THEN NULL ELSE r.due_at END,
      queued_at = CASE WHEN ${NC} THEN ${NOW} ELSE r.queued_at END,
      cycle_queued_at = CASE WHEN ${NC} OR ${QR} THEN ${NOW} ELSE r.cycle_queued_at END,
      requested_at = CASE
        WHEN ${NC} OR ${QR} THEN ${REQUESTED_IF_ATTENDED}
        WHEN (${QP} OR ${WQ}) AND r.requested_at IS NULL AND ${LOWER} <= 1 THEN ${NOW}
        ELSE r.requested_at END,
      pending_kind = CASE WHEN ${RUN} THEN ${PENDING_KIND} WHEN ${NC} THEN NULL ELSE r.pending_kind END,
      pending_priority = CASE WHEN ${RUN} THEN ${PENDING_PRIORITY} WHEN ${NC} THEN NULL ELSE r.pending_priority END,
      pending_requested_at = CASE
        WHEN ${RUN} THEN COALESCE(r.pending_requested_at, ${REQUESTED_IF_ATTENDED})
        WHEN ${NC} THEN NULL ELSE r.pending_requested_at END,
      wait_started_at = CASE WHEN ${NC} OR ${QR} THEN NULL ELSE r.wait_started_at END,
      manual_wait_until = CASE WHEN ${NC} THEN NULL ELSE r.manual_wait_until END,
      expected_min_s = CASE WHEN ${NC} OR ${QR} THEN NULL ELSE r.expected_min_s END,
      expected_max_s = CASE WHEN ${NC} OR ${QR} THEN NULL ELSE r.expected_max_s END,
      tecfil_attempts = CASE WHEN ${NC} AND ${K} = 'refetch' THEN 0 ELSE r.tecfil_attempts END,
      engine_pick_engine = CASE WHEN ${NC} OR ${QR} THEN ${ENGINE} ELSE r.engine_pick_engine END,
      engine_pick_from = CASE WHEN ${NC} OR ${QR} THEN ${FROM} ELSE r.engine_pick_from END,
      engine_pick_passages = CASE WHEN ${NC} OR ${QR} THEN ${PASSAGES} ELSE r.engine_pick_passages END,
      engine_pick_reopened = CASE WHEN ${NC} THEN ${REOPENS} WHEN ${QR} THEN false ELSE r.engine_pick_reopened END,
      updated_at = ${NOW}
    WHERE ${NC} OR ${QR}
      OR (${QP} AND (${LOWER} <> r.priority OR ${stronger(sql`r.kind`, K)} <> r.kind))
      OR (${RUN} AND (${PENDING_KIND} IS DISTINCT FROM r.pending_kind OR ${PENDING_PRIORITY} IS DISTINCT FROM r.pending_priority))
      OR ((${WQ} OR ${VT} OR ${RP}) AND ${P} < r.priority)
    RETURNING r.id, r.identity_key, r.state, r.kind, r.priority, r.requested_at, (r.xmax::text = '0') AS inserted`;

  const row = rows[0];
  if (!row) return { status: "unchanged", identityKey: key };
  if (row.state === "queued" && row.requested_at) {
    await storeQueuedEstimate(tx, row.id, now);
  }
  return {
    status: "written",
    row: { id: row.id, identityKey: row.identity_key, state: row.state, kind: row.kind, priority: row.priority, requestedAt: row.requested_at, inserted: row.inserted },
  };
}

/** A row's place in claim order: `(priority, requested_at NULLS LAST, queued_at, id)`. */
type QueuePlace = { id: string; priority: number; requestedAt: Date | null; queuedAt: Date };

/**
 * The rows ahead of a queued row in claim order, plus one when a run is in progress (D14's queue
 * term; also the contract's `queuePosition`).
 */
export async function rowsAhead(tx: DbClient, place: QueuePlace, now: Date): Promise<number> {
  const req = place.requestedAt;
  const rows = await tx.$queryRaw<{ ahead: number; busy: boolean }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM oil_research AS o
        WHERE o.state = 'queued' AND o.id <> ${place.id}
          AND (o.priority < ${place.priority}
            OR (o.priority = ${place.priority} AND (
                  (${req}::timestamptz IS NULL AND o.requested_at IS NOT NULL)
                  OR o.requested_at < ${req}::timestamptz
                  OR (o.requested_at IS NOT DISTINCT FROM ${req}::timestamptz
                      AND (o.queued_at < ${place.queuedAt} OR (o.queued_at = ${place.queuedAt} AND o.id < ${place.id})))))))
        AS ahead,
      EXISTS (SELECT 1 FROM oil_research
        WHERE (state = 'running' AND lease_until > ${now}) OR (tecfil_state = 'running' AND tecfil_lease_until > ${now}))
        AS busy`;
  const first = rows[0];
  return (first?.ahead ?? 0) + (first?.busy ? 1 : 0);
}

/** The path a row estimates on (D14): a wait or a `manual_resolve` on `manual`, anything else on `search`. */
function estimatePathOf(state: string, kind: string): EstimatePath {
  return state === "waiting_manual" || kind === "manual_resolve" ? "manual" : "search";
}

/** D14's first moment: (now − requested_at) + the queue term + the path's run range, on a queued row. */
export async function storeQueuedEstimate(tx: DbClient, id: string, now: Date): Promise<void> {
  const row = await tx.oilResearch.findUnique({ where: { id }, select: { id: true, state: true, kind: true, priority: true, requestedAt: true, queuedAt: true } });
  if (!row || row.state !== "queued" || !row.requestedAt) return;
  const path = estimatePathOf(row.state, row.kind);
  const [timings, search, ahead] = await Promise.all([
    loadPathTimings(tx, path, now),
    path === "search" ? null : loadPathTimings(tx, "search", now),
    rowsAhead(tx, row, now),
  ]);
  const estimate = storedEstimate((now.getTime() - row.requestedAt.getTime()) / 1000, queueTermS(ahead, (search ?? timings).p50S), timings.range);
  await tx.oilResearch.updateMany({ where: { id, state: "queued" }, data: { expectedMinS: estimate.minS, expectedMaxS: estimate.maxS } });
}
