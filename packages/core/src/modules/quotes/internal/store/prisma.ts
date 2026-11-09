/**
 * Postgres-backed {@link OilQuoteStore}, assembled from one file per topic:
 * the catalog, the two compatibility caches, the source-research ledgers, the
 * stored manual readings, and quote writes. Each runs on whatever client it is handed, so under
 * `db.tx("quotes", …)` every query carries the `quotes` role.
 */
import type { DbClient } from "@select-lub/core/db";
import { catalogQueries } from "./catalog.js";
import { compatibilityCaches } from "./compatibility-caches.js";
import { manualReadings } from "./manual-readings.js";
import { quoteWrites } from "./quote-writes.js";
import { sourceResearch } from "./source-research.js";
import type { OilQuoteStore } from "./store.js";

/**
 * Reads catalog, both compatibility caches, and quote rows via Prisma.
 *
 * @param prisma - The client the quote runs on — a transaction under the
 *   `quotes` role in a slice, the rolling-back test transaction under the harness.
 * @returns The full {@link OilQuoteStore}.
 */
export function createPrismaOilQuoteStore(prisma: DbClient): OilQuoteStore {
  return {
    ...catalogQueries(prisma),
    ...compatibilityCaches(prisma),
    ...sourceResearch(prisma),
    ...manualReadings(prisma),
    ...quoteWrites(prisma),
  };
}
