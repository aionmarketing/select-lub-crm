/**
 * Decides what a vehicle's return rows should be, given its services and the
 * returns it already has.
 *
 * Pure: no I/O, no clock, no Prisma. Callers load a vehicle's rows, ask this
 * what to change, and apply it. That shape is deliberate — the same answer is
 * needed by the worker's Omie import (a service just arrived), by the demo seed
 * (services created directly), and by the backfill (services that predate
 * returns entirely). Hooking "open a return" into the import alone would have
 * left the other two writing rows a different way, which is how two definitions
 * of "when is this car due" start.
 *
 * The invariant it enforces: **a vehicle has at most one OPEN return, and it is
 * sourced from that vehicle's most recent dated service.** Everything else about
 * the plan follows from that one sentence.
 *
 * It is idempotent by construction: running it twice with the same rows plans
 * nothing the second time, which is what lets it run after every import.
 *
 * Moved from `packages/shared-types/src/vehicle-return-plan.ts` (5.1d) with declarations unchanged.
 */
import { type IntervalRuleInput, suggestDate } from "./http.return-due.js";

/** A service as the planner needs it: only what decides the return. */
export type PlannableService = {
  id: string;
  /** Null means the service has no date, so it can date no return. */
  performedAt: Date | null;
  /** Matched against the interval rules; null falls back to six months. */
  kind: string | null;
};

/**
 * A return the vehicle already holds: an OPEN one, or an ARCHIVED one.
 *
 * Callers pass each list OLDEST FIRST (created_at, then id). The planner keeps
 * the first of several OPEN returns on the same service, so that order is the
 * tie-break, and it is the same one the unique-index migration used.
 */
export type ExistingOpenReturn = {
  id: string;
  sourceServiceId: string;
};

/** The return to open, with the rule that dated it recorded for tracing. */
export type PlannedReturn = {
  sourceServiceId: string;
  returnDate: Date;
  intervalRuleId: string | null;
  intervalRuleVersion: number | null;
};

/**
 * What to change for one vehicle.
 *
 * `supersede` and `open` are independent: a vehicle can need rows superseded
 * with nothing to open (its services lost their dates), or an open with nothing
 * to supersede (its first service).
 */
export type VehicleReturnPlan = {
  /**
   * Ids of OPEN or ARCHIVED returns to mark SUPERSEDED. Their un-sent reminders
   * are stopped, except a merged duplicate's, which move first (see `merge`).
   */
  supersede: string[];
  /** The return to open, or null when nothing should be open. */
  open: PlannedReturn | null;
  /**
   * Two or more OPEN returns on the latest service: the same return twice, left
   * by two reconciles racing. `into` is the one kept; the reminder messages of
   * `from` move to it BEFORE `from` is superseded, so an attendant's reminders
   * on a duplicate keep firing instead of being stopped. Null when there is none.
   */
  merge: { into: string; from: string[] } | null;
};

/**
 * Plans one vehicle's return rows.
 *
 * @param input.services - Every service of that vehicle. Order decides only
 *   between two services with the same `performedAt` (the first wins), so pass
 *   them in a stable order. Services with no `performedAt` are ignored, since a
 *   return is dated from one.
 * @param input.openReturns - The vehicle's OPEN returns, oldest first. More than
 *   one is not supposed to exist; if it does, this is what collapses it back to
 *   one.
 * @param input.archivedReturns - The vehicle's ARCHIVED returns (owner rulings,
 *   2026-09-25). One on the latest service stays archived and stops a new return
 *   from opening for that service: before, every import reopened an archived
 *   return as a new OPEN row. One on an older service is superseded, as an OPEN
 *   one would be. Defaults to none.
 * @param input.rules - Interval rules for {@link suggestDate}.
 * @returns Rows to supersede, the row to open, and any duplicate to merge.
 *   `{ supersede: [], open: null, merge: null }` means the data already
 *   satisfies the invariant.
 */
export function planVehicleReturns(input: {
  services: PlannableService[];
  openReturns: ExistingOpenReturn[];
  archivedReturns?: ExistingOpenReturn[];
  rules: IntervalRuleInput[];
}): VehicleReturnPlan {
  const archived = input.archivedReturns ?? [];
  const dated = input.services.filter(
    (service): service is PlannableService & { performedAt: Date } => service.performedAt !== null,
  );

  if (dated.length === 0) {
    // No service can date a return, so nothing should be open. An existing open
    // row is stale rather than merely old — supersede it. An archived one is
    // left: no newer service has replaced it.
    return { supersede: input.openReturns.map((row) => row.id), open: null, merge: null };
  }

  const latest = dated.reduce((winner, service) =>
    service.performedAt.getTime() > winner.performedAt.getTime() ? service : winner,
  );

  const onLatest = input.openReturns.filter((row) => row.sourceServiceId === latest.id);
  const [kept, ...duplicates] = onLatest;
  const staleOpen = input.openReturns.filter((row) => row.sourceServiceId !== latest.id);
  const staleArchived = archived.filter((row) => row.sourceServiceId !== latest.id);
  const supersede = [...staleOpen, ...duplicates, ...staleArchived].map((row) => row.id);
  const merge = kept && duplicates.length > 0 ? { into: kept.id, from: duplicates.map((row) => row.id) } : null;

  if (kept || archived.some((row) => row.sourceServiceId === latest.id)) {
    // Deliberately does NOT compare the stored date against a fresh
    // suggestDate. The stored returnDate is authoritative and editable per
    // vehicle; recomputing here would silently undo an edit on the next import,
    // which is the exact failure that storing the date exists to prevent. And
    // an archived return on this service is the attendant's decision to take it
    // off Follow-up; opening a new one would undo it.
    return { supersede, open: null, merge };
  }

  const suggestion = suggestDate({
    performedAt: latest.performedAt,
    kind: latest.kind,
    rules: input.rules,
  });

  return {
    supersede,
    open: {
      sourceServiceId: latest.id,
      returnDate: suggestion.suggestedAt,
      intervalRuleId: suggestion.intervalRuleId,
      intervalRuleVersion: suggestion.intervalRuleVersion,
    },
    merge: null,
  };
}
