/**
 * The query behind the Serviços ledger: one unit's services with their customer
 * and vehicle, bounded coarsely by period and filtered by the search box in SQL,
 * then cut to the exact page in memory.
 *
 * Moved from `apps/api/src/services/prisma.ts` (`listUnitPage`), body unchanged
 * but for the client's name, when the services routes became this module's
 * slices (adopt-modular-vertical-slices 3C). `customer`, `vehicle` and
 * `vehicle_return` are joined or read here; `customer` and `vehicle` are
 * `customers`' tables, read as foreign reads.
 */
import type { DbClient } from "../../../kernel/db.js";
import type { UnitServicePage, UnitServiceQuery } from "../contracts/http.js";
import { followUpReturnWindow } from "../contracts/return-state.js";
import { toUnitRowDto } from "../internal/service-dto.js";
import { returnStateByService, selectUnitServicePage } from "../internal/unit-listing.js";

/**
 * Widens a `YYYY-MM-DD` bound by a day so a São Paulo calendar day is never
 * clipped by a UTC comparison. The exact boundary is applied in memory by
 * `selectUnitServicePage`; this only keeps the query from reading the whole
 * table.
 */
function coarseBound(day: string, offsetDays: number): Date {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + offsetDays);
  return at;
}

/**
 * Reads one page of a unit's ledger.
 *
 * @param tx - A client under `module_services`.
 * @param unitId - Loja whose services to return.
 * @param query - Parsed `GET /services` query; an empty object means unbounded,
 *   unsearched, first page.
 * @returns One page in `performedAt` descending order (undated last), whether
 *   more match, and the continuation.
 */
export async function queryUnitServicePage(
  tx: DbClient,
  unitId: string,
  query: UnitServiceQuery,
): Promise<UnitServicePage> {
  // One query, relations included: the round trips no longer grow with the
  // unit's history. The period is bounded coarsely here and exactly in
  // `selectUnitServicePage`, because the São Paulo calendar boundary is not
  // expressible in a Prisma `where` without raw SQL — and a second copy of
  // that arithmetic is what would drift from the reports buckets.
  const where: Record<string, unknown> = { unitId };
  if (query.from !== undefined || query.to !== undefined) {
    const performedAt: Record<string, Date> = {};
    if (query.from !== undefined) {
      performedAt.gte = coarseBound(query.from, -1);
    }
    if (query.to !== undefined) {
      performedAt.lte = coarseBound(query.to, 2);
    }
    where.performedAt = performedAt;
  }
  if (query.search !== undefined) {
    where.OR = [
      { customer: { name: { contains: query.search, mode: "insensitive" } } },
      { vehicle: { plate: { contains: query.search, mode: "insensitive" } } },
      { omieId: { contains: query.search, mode: "insensitive" } },
    ];
  }
  const rows = await tx.service.findMany({
    where,
    include: { items: true, customer: true, vehicle: true },
  });
  // Loaded only when the filter is actually used: the join costs nothing on
  // the unfiltered ledger, which is the common request.
  const window = followUpReturnWindow(new Date());
  const returnStates =
    query.returnState === undefined
      ? new Map()
      : returnStateByService(
          (
            await tx.vehicleReturn.findMany({
              where: { sourceService: { unitId } },
              select: { sourceServiceId: true, status: true, returnDate: true },
            })
          ).map((row) => ({
            sourceServiceId: row.sourceServiceId,
            status: row.status,
            // A `@db.Date` comes back as UTC midnight, so its calendar day
            // is its UTC day; reading it in São Paulo would be the day before.
            returnDate: row.returnDate.toISOString().slice(0, 10),
          })),
          window.today,
          window.horizon,
        );
  return selectUnitServicePage(rows.map(toUnitRowDto), query, returnStates);
}
