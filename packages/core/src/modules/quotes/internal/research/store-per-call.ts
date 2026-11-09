/**
 * The store whose every call is its own short `db.tx("quotes", …)` (moved from
 * `get-quote-options` so the research runner shares it; background-oil-research D9).
 *
 * A quote or a research run interleaves store calls with provider calls. In production `db.tx`
 * is a Prisma interactive transaction with a 5 s timeout, so a transaction spanning a model call
 * would expire mid-run; one transaction per store call never spans one.
 */
import type { Db } from "../../../../kernel/db.js";
import { createPrismaOilQuoteStore } from "../store/prisma.js";
import type { OilQuoteStore } from "../store/store.js";

/**
 * @param db - The database handle.
 * @returns A store safe to hand to code that interleaves queries with provider calls.
 */
export function storePerCall(db: Db): OilQuoteStore {
  const run = <T>(fn: (store: OilQuoteStore) => Promise<T>) => db.tx("quotes", (tx) => fn(createPrismaOilQuoteStore(tx)));
  return {
    listCatalog: () => run((s) => s.listCatalog()),
    getCatalogItem: (id) => run((s) => s.getCatalogItem(id)),
    latestCompatibility: (identity) => run((s) => s.latestCompatibility(identity)),
    insertCompatibility: (row) => run((s) => s.insertCompatibility(row)),
    latestTecfilCompatibility: (identity) => run((s) => s.latestTecfilCompatibility(identity)),
    insertTecfilCompatibility: (row) => run((s) => s.insertTecfilCompatibility(row)),
    insertSourceCandidates: (rows) => run((s) => s.insertSourceCandidates(rows)),
    listSourceCandidates: (identity) => run((s) => s.listSourceCandidates(identity)),
    recordSearchMiss: (row) => run((s) => s.recordSearchMiss(row)),
    latestSearchMiss: (identity) => run((s) => s.latestSearchMiss(identity)),
    listManualReadings: (identity) => run((s) => s.listManualReadings(identity)),
    createQuote: (input) => run((s) => s.createQuote(input)),
  };
}
