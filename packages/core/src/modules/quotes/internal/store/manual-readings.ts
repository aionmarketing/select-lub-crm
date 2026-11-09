/**
 * The quote's read of stored manual readings (ingest-harvested-manuals D6/D7): the verified
 * readings for an identity, each with its extraction, the page it cites and the passage it read.
 * A reading whose stored spec is unreadable is left out and logged, never trusted.
 */
import type { DbClient } from "@select-lub/core/db";
import { motulIdentitiesMatch } from "../../../../kernel/clients/motul/index.js";
import { parseStoredManualSpec, type StoredManualSpec } from "../manuals/read-for-identity.js";
import type { OilQuoteStore, VehicleIdentity } from "./store.js";

/** One verified reading, as a quote uses it. */
export type StoredManualReading = { url: string; citedPage: string; excerpt: string | null; spec: StoredManualSpec };

/**
 * @param prisma - The client the quote runs on.
 * @returns The manual-readings half of {@link OilQuoteStore}.
 */
export function manualReadings(prisma: DbClient): Pick<OilQuoteStore, "listManualReadings"> {
  return {
    async listManualReadings(identity: VehicleIdentity) {
      const rows = await prisma.oilManualReading.findMany({
        where: { year: identity.year, status: "verified" },
        orderBy: { readAt: "desc" },
        select: { id: true, url: true, make: true, year: true, model: true, version: true, spec: true, citedPage: true, excerpt: true },
      });
      const readings: StoredManualReading[] = [];
      for (const row of rows) {
        if (!motulIdentitiesMatch({ make: row.make, year: row.year, model: row.model, version: row.version }, identity)) continue;
        const spec = parseStoredManualSpec(row.spec);
        if (!spec || !row.citedPage) {
          console.warn("manual-reading", JSON.stringify({ id: row.id, url: row.url, outcome: "unreadable_spec" }));
          continue;
        }
        readings.push({ url: row.url, citedPage: row.citedPage, excerpt: row.excerpt, spec });
      }
      return readings;
    },
  };
}
