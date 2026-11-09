/**
 * What the spec search found and what it failed to find: documents it saw and
 * deliberately did not read (`oil_source_candidate`), and searches that came
 * back with nothing usable (`oil_spec_search_miss`). Both are insert-only
 * ledgers, so what was visible when stays legible.
 */
import { motulIdentitiesMatch } from "../../../../kernel/clients/motul/index.js";
import type { DbClient } from "@select-lub/core/db";
import type { SearchMissRow, SourceCandidateRow } from "../../contracts/http.js";
import type { OilQuoteStore, VehicleIdentity } from "./store.js";

/** Prisma candidate row as the shared contract sees it: dates as ISO, nullables preserved. */
function toCandidateDto(row: {
  id: string;
  make: string;
  year: number;
  model: string;
  version: string;
  url: string;
  publisher: string;
  classification: string;
  tier: number;
  discoveredVia: string | null;
  label: string | null;
  selectionReason: string | null;
  foundAt: Date;
}): SourceCandidateRow {
  return {
    id: row.id,
    make: row.make,
    year: row.year,
    model: row.model,
    version: row.version,
    url: row.url,
    publisher: row.publisher,
    // The column is TEXT so an older row cannot break the read; the contract narrows it.
    classification: row.classification as SourceCandidateRow["classification"],
    tier: row.tier as SourceCandidateRow["tier"],
    discoveredVia: row.discoveredVia,
    label: row.label,
    selectionReason: row.selectionReason,
    foundAt: row.foundAt.toISOString(),
  };
}

/** Prisma miss row as the shared contract sees it. */
function toMissDto(row: {
  id: string;
  make: string;
  year: number;
  model: string;
  version: string;
  reason: string;
  searchedAt: Date;
}): SearchMissRow {
  return {
    id: row.id,
    make: row.make,
    year: row.year,
    model: row.model,
    version: row.version,
    reason: row.reason,
    searchedAt: row.searchedAt.toISOString(),
  };
}

/**
 * @param prisma - The client the quote runs on.
 * @returns The source-research half of {@link OilQuoteStore}.
 */
export function sourceResearch(
  prisma: DbClient,
): Pick<
  OilQuoteStore,
  "insertSourceCandidates" | "listSourceCandidates" | "recordSearchMiss" | "latestSearchMiss"
> {
  return {
    async insertSourceCandidates(rows) {
      if (rows.length === 0) {
        return [];
      }
      // createManyAndReturn, not createMany: the caller is handed the stored rows with the
      // ids the ledger assigned, and the whole batch lands in one statement.
      const saved = await prisma.oilSourceCandidate.createManyAndReturn({
        data: rows.map((row) => ({
          make: row.make,
          year: row.year,
          model: row.model,
          version: row.version,
          url: row.url,
          publisher: row.publisher,
          classification: row.classification,
          tier: row.tier,
          discoveredVia: row.discoveredVia ?? null,
          label: row.label ?? null,
          selectionReason: row.selectionReason ?? null,
          foundAt: new Date(row.foundAt),
        })),
      });
      return saved.map(toCandidateDto);
    },
    async listSourceCandidates(identity: VehicleIdentity) {
      const rows = await prisma.oilSourceCandidate.findMany({ where: { year: identity.year } });
      const matches = rows
        .map(toCandidateDto)
        .filter((row) =>
          motulIdentitiesMatch(
            { make: row.make, year: row.year, model: row.model, version: row.version },
            identity,
          ),
        );
      matches.sort((a, b) => b.foundAt.localeCompare(a.foundAt));
      return matches;
    },
    async recordSearchMiss(row) {
      const saved = await prisma.oilSpecSearchMiss.create({
        data: {
          make: row.make,
          year: row.year,
          model: row.model,
          version: row.version,
          reason: row.reason,
          searchedAt: new Date(row.searchedAt),
        },
      });
      return toMissDto(saved);
    },
    async latestSearchMiss(identity: VehicleIdentity) {
      const rows = await prisma.oilSpecSearchMiss.findMany({ where: { year: identity.year } });
      const matches = rows
        .map(toMissDto)
        .filter((row) =>
          motulIdentitiesMatch(
            { make: row.make, year: row.year, model: row.model, version: row.version },
            identity,
          ),
        );
      matches.sort((a, b) => b.searchedAt.localeCompare(a.searchedAt));
      return matches[0] ?? null;
    },
  };
}
