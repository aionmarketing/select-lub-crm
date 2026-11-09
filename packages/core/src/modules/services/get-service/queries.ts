/**
 * The read behind the Serviços detail region: one service with its items,
 * customer, vehicle and persisted quote attribution, plus that vehicle's other
 * services.
 *
 * Moved from `apps/api/src/services/prisma.ts` (`getUnitServiceDetail`), body
 * unchanged but for the client's name, and its row type from `services/store.ts`
 * (adopt-modular-vertical-slices 3C). `service_quote_attribution` (reports') and
 * `oil_quote` (quotes') are read, never written: the attribution is Relatórios'.
 */
import type { ServiceQuoteAttribution, UnitServiceRow } from "../contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import type { Service } from "../contracts/http.js";
import { iso, sortServices, toServiceDto, toUnitRowDto } from "../internal/service-dto.js";

/**
 * One service in full, as the store reads it.
 *
 * `attributedQuote` is the persisted `ServiceQuoteAttribution` row that the
 * Relatórios attribution pass writes — read, never recomputed. Recomputing it
 * here would be the second implementation of the 30-day rule that would
 * disagree with the funnel the day someone changes the window.
 */
export type UnitServiceDetailRow = {
  row: UnitServiceRow;
  vehicleHistory: Service[];
  attributedQuote: ServiceQuoteAttribution | null;
};

/**
 * Reads one service in full.
 *
 * @param tx - A client under `module_services`.
 * @param id - Service row id.
 * @returns The labelled row plus that vehicle's other services (newest first,
 *   excluding this one), or `null` when no row exists.
 */
export async function queryServiceDetail(
  tx: DbClient,
  id: string,
): Promise<UnitServiceDetailRow | null> {
  const row = await tx.service.findUnique({
    where: { id },
    include: {
      items: true,
      customer: true,
      vehicle: true,
      quoteAttributions: { include: { quote: true } },
    },
  });
  if (!row) {
    return null;
  }
  // Read, never recomputed: the Relatórios attribution pass owns the rule.
  const attribution = row.quoteAttributions[0] ?? null;
  const history = row.vehicleId
    ? await tx.service.findMany({
        where: { vehicleId: row.vehicleId, id: { not: row.id } },
        include: { items: true },
      })
    : [];
  return {
    row: toUnitRowDto(row),
    vehicleHistory: sortServices(history.map(toServiceDto)),
    attributedQuote:
      attribution === null
        ? null
        : {
            quoteId: attribution.quoteId,
            sentAt: iso(attribution.quote.createdAt),
            ruleVersion: attribution.ruleVersion,
          },
  };
}
