/**
 * The Serviços ledger's rules: the São Paulo period, the search box, the
 * return-state filter, ordering, the cursor and the page.
 *
 * Pure. Moved from `apps/api/src/services/store.ts`, bodies unchanged, when the
 * services routes became this module's slices (adopt-modular-vertical-slices
 * 3C). `list-unit-services` loads the rows and hands them here. The return-state
 * comparison is `contracts/return-state.ts`'s, the one Follow-up uses too.
 */
import type { UnitServicePage, UnitServiceQuery, UnitServiceRow } from "../contracts/http.js";
import * as shared from "../../../shared/index.js";
import { classifyReturnDate, type ReturnState } from "../contracts/return-state.js";

/** Page size used when a request names no `limit`. */
export const DEFAULT_UNIT_SERVICE_LIMIT = 50;

/**
 * Calendar day a service's `performedAt` falls on in America/Sao_Paulo.
 *
 * @param performedAt - ISO instant, or null for an undated service.
 * @returns `YYYY-MM-DD`, or null when the service carries no date.
 */
export function servicePeriodKey(performedAt: string | null): string | null {
  if (performedAt === null) {
    return null;
  }
  const parsed = new Date(performedAt);
  return Number.isNaN(parsed.getTime()) ? null : shared.saoPauloDateKey(parsed);
}

/**
 * Whether a service falls inside the requested inclusive period.
 *
 * An undated service is outside any bounded period — it cannot be placed on the
 * calendar — but is inside an unbounded one, so it still reaches the ledger when
 * no filter is applied.
 *
 * @param performedAt - ISO instant, or null.
 * @param from - Inclusive lower bound as `YYYY-MM-DD`, or undefined for no bound.
 * @param to - Inclusive upper bound as `YYYY-MM-DD`, or undefined for no bound.
 * @returns True when the service should appear under this period filter.
 */
export function withinServicePeriod(
  performedAt: string | null,
  from?: string,
  to?: string,
): boolean {
  if (from === undefined && to === undefined) {
    return true;
  }
  const key = servicePeriodKey(performedAt);
  if (key === null) {
    return false;
  }
  return (from === undefined || key >= from) && (to === undefined || key <= to);
}

/**
 * Whether a row matches the Serviços search box.
 *
 * Matches customer name, vehicle plate, and the Omie service identifier —
 * the three things a person arrives holding — case-insensitively on a partial
 * value. A service with no linked vehicle carries no plate and so can never
 * match a plate term; it stays findable by customer name and by period.
 *
 * @param row - Labelled unit service row.
 * @param term - Raw search term; blank matches everything.
 * @returns True when the row should survive the search filter.
 */
export function matchesServiceSearch(row: UnitServiceRow, term: string | undefined): boolean {
  const needle = (term ?? "").trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return [row.customerName, row.vehiclePlate, row.omieId].some(
    (value) => value !== null && value.toLowerCase().includes(needle),
  );
}

/** Position in the `performedAt` descending, null-last ordering. */
export type ServiceCursor = { performedAt: string | null; id: string };

/**
 * Encodes a row's position so the next page can resume after it.
 *
 * @param row - Row that ended the page; only `performedAt` and `id` are read.
 * @returns Opaque cursor string; undated rows encode an empty date part.
 */
export function encodeServiceCursor(row: { performedAt: string | null; id: string }): string {
  return `${row.performedAt ?? ""}|${row.id}`;
}

/**
 * Decodes a cursor produced by {@link encodeServiceCursor}.
 *
 * @param cursor - Cursor string from a previous page.
 * @returns The position, or null when the cursor is malformed.
 */
export function decodeServiceCursor(cursor: string): ServiceCursor | null {
  const at = cursor.indexOf("|");
  if (at < 0) {
    return null;
  }
  const performedAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  return id === "" ? null : { performedAt: performedAt === "" ? null : performedAt, id };
}

/**
 * Whether a row sorts strictly after a cursor under `performedAt` descending, null-last, `id` ascending.
 *
 * Two branches, because the sort column is nullable: inside the dated group a
 * row follows when its date is older, or equal with a larger id; once the
 * cursor sits in the undated group only larger ids follow. Collapsing these
 * into one comparison is what makes a page repeat or skip a row.
 *
 * @param row - Candidate row.
 * @param cursor - Position the previous page ended on.
 * @returns True when the row belongs to a later page.
 */
export function isAfterServiceCursor(
  row: { performedAt: string | null; id: string },
  cursor: ServiceCursor,
): boolean {
  if (cursor.performedAt === null) {
    return row.performedAt === null && row.id > cursor.id;
  }
  if (row.performedAt === null) {
    return true;
  }
  if (row.performedAt === cursor.performedAt) {
    return row.id > cursor.id;
  }
  return row.performedAt < cursor.performedAt;
}

/**
 * Orders labelled rows the way every page of the Serviços ledger is ordered.
 *
 * @param rows - Labelled unit service rows.
 * @returns A new array: newest `performedAt` first, undated rows last, ties by ascending `id`.
 */
export function sortUnitServiceRows(rows: UnitServiceRow[]): UnitServiceRow[] {
  return [...rows].sort((a, b) => {
    if (a.performedAt !== b.performedAt) {
      if (a.performedAt === null) {
        return 1;
      }
      if (b.performedAt === null) {
        return -1;
      }
      return b.performedAt.localeCompare(a.performedAt);
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Cuts an ordered, already-filtered row set down to one page.
 *
 * One place for the page boundary, so no caller can cut a page differently.
 *
 * @param ordered - Rows at or after the cursor, filtered and in ledger order.
 * @param limit - Page size; rows beyond it set `hasMore`.
 * @param matching - Every row matching the query ignoring the cursor, for the totals; defaults to `ordered`.
 * @returns The page, whether more rows match, the continuation, and the totals over `matching`.
 */
export function pageUnitServiceRows(
  ordered: UnitServiceRow[],
  limit: number,
  matching: UnitServiceRow[] = ordered,
): UnitServicePage {
  const rows = ordered.slice(0, limit);
  const hasMore = ordered.length > limit;
  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursor: hasMore && last ? encodeServiceCursor(last) : null,
    totalCount: matching.length,
    totalAmount: matching.reduce((sum, row) => sum + (row.amount ?? 0), 0),
  };
}

/**
 * One vehicle return, as the Serviços filter needs to see it.
 *
 * Carries the STORED day rather than anything derived from the service, because
 * `returnDate` is editable and Follow-up reads the stored one.
 */
export type ServiceReturnRow = {
  /** The service this return was dated from — the vehicle's most recent dated one. */
  sourceServiceId: string;
  /** `OPEN` | `ARCHIVED` | `SUPERSEDED`, straight from the row. */
  status: string;
  /** The stored day, `YYYY-MM-DD` in America/Sao_Paulo. */
  returnDate: string;
};

/**
 * Whether a stored return is one the Serviços filter may match on.
 *
 * Decided 2026-09-04: Serviços is the listing where nothing disappears, so an
 * ARCHIVED return still matches even though Follow-up hides it from the queue.
 * SUPERSEDED must not, for a structural reason rather than a preference — a
 * superseded return belongs to an OLDER service, and matching it would list an
 * overdue car once per past oil change, breaking "a service that is not its
 * vehicle's most recent SHALL NOT match".
 */
function isFilterableReturn(status: string): boolean {
  // Named rather than excluding SUPERSEDED, so a status added later is left OUT
  // until someone decides it belongs. A filter that silently gains a row tells
  // the operator to chase a car that is not due; one that silently loses a row
  // is a gap they can see. Wrong in the safer direction.
  return status === "OPEN" || status === "ARCHIVED";
}

/**
 * Return state per service id, for the rows the filter may match.
 *
 * @param returns - Every return of the vehicles in scope.
 * @param today - Today's calendar day, `YYYY-MM-DD` in America/Sao_Paulo.
 * @param horizon - Last day counted as approaching, normally today + 14.
 * @returns A lookup from source service id to its return state. A service with
 *   no entry is one the filter can never match, which is every service that is
 *   not the one its vehicle's live return was dated from.
 */
export function returnStateByService(
  returns: ServiceReturnRow[],
  today: string,
  horizon: string,
): Map<string, ReturnState> {
  const byService = new Map<string, ReturnState>();
  for (const row of returns) {
    if (!isFilterableReturn(row.status)) {
      continue;
    }
    const state = classifyReturnDate(row.returnDate, today, horizon);
    if (state) {
      byService.set(row.sourceServiceId, state);
    }
  }
  return byService;
}

/**
 * Applies the whole unit listing contract to a labelled row set already scoped to the unit.
 *
 * @param all - Every labelled row in the unit.
 * @param query - Parsed `GET /services` query.
 * @param returnStates - Return state per source service id, from
 *   {@link returnStateByService}. Empty means no service can match the
 *   return-state filter, which is correct for a store that holds no returns.
 * @returns One ordered, filtered page with its continuation.
 */
export function selectUnitServicePage(
  all: UnitServiceRow[],
  query: UnitServiceQuery,
  returnStates: Map<string, ReturnState> = new Map(),
): UnitServicePage {
  const cursor = query.cursor === undefined ? null : decodeServiceCursor(query.cursor);
  // Totals describe the whole match, so they are taken before the cursor cut —
  // otherwise page two would report a smaller ledger than page one.
  const matching = sortUnitServiceRows(all).filter(
    (row) =>
      withinServicePeriod(row.performedAt, query.from, query.to) &&
      matchesServiceSearch(row, query.search) &&
      // Composes with the other two: a request carrying several filters returns
      // only services satisfying all of them.
      (query.returnState === undefined || returnStates.get(row.id) === query.returnState),
  );
  const afterCursor =
    cursor === null ? matching : matching.filter((row) => isAfterServiceCursor(row, cursor));
  return pageUnitServiceRows(
    afterCursor,
    query.limit ?? DEFAULT_UNIT_SERVICE_LIMIT,
    matching,
  );
}
