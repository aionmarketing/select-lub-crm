/**
 * The two compatibility caches, keyed by the same make/year/model/version
 * identity: the verified oil spec (`motul_compatibility`) and the Tecfil filter
 * fitment (`tecfil_compatibility`). Both are insert-only, and a read returns the
 * latest row whose identity matches under Motul's normalisation.
 */
import { motulIdentitiesMatch } from "../../../../kernel/clients/motul/index.js";
import type { DbClient } from "@select-lub/core/db";
import type { TecfilCompatibility } from "../../contracts/http.js";
import {
  iso,
  readClassification,
  readFillCondition,
  readFillKind,
  readGrades,
  type DecimalLike,
} from "./column-readers.js";
import { readGradeSources, writeGradeSources } from "./grade-sources.js";
import type { CachedCompatibility, OilQuoteStore, VehicleIdentity } from "./store.js";

function toCacheDto(row: {
  id: string;
  make: string;
  year: number;
  model: string;
  version: string;
  viscosities: unknown;
  viscosity: string;
  classification: string;
  fillLiters: DecimalLike | null;
  fillKind: string | null;
  fillCondition: string | null;
  unusableFillLiters: DecimalLike | null;
  sourcePublisher: string | null;
  sourceDocument: string | null;
  sourcePage: string | null;
  sourceAuthority: number | null;
  sourceUrl: string | null;
  sourceClassification: string | null;
  sourceExcerpt: string | null;
  gradeSources: unknown;
  consultedAt: Date;
  rawPayload: unknown;
}): CachedCompatibility {
  const liters = row.fillLiters == null ? null : row.fillLiters.toNumber();
  const viscosityGrades = readGrades(row.viscosities, row.viscosity);
  const primary = {
    sourcePublisher: row.sourcePublisher ?? "",
    sourceDocument: row.sourceDocument ?? "",
    sourcePage: row.sourcePage ?? "",
    sourceAuthority: row.sourceAuthority ?? null,
    sourceUrl: row.sourceUrl ?? null,
    // Narrowed on read rather than trusted: the column is plain TEXT, so a value written
    // by an older or hand-edited row must not smuggle a class the contract closed.
    sourceClassification: readClassification(row.sourceClassification),
    sourceExcerpt: row.sourceExcerpt ?? null,
  };
  return {
    id: row.id,
    make: row.make,
    year: row.year,
    model: row.model,
    version: row.version,
    viscosityGrades,
    viscosity: row.viscosity,
    classification: row.classification,
    fillLiters: liters,
    // A row that lost one half of the pair is read as "capacity not verified" rather
    // than as liters of an unknown legend, which the contract rejects outright.
    fillKind: liters == null ? null : readFillKind(row.fillKind),
    ...readFillCondition(liters, row.fillKind, row.fillCondition, row.unusableFillLiters == null ? null : row.unusableFillLiters.toNumber()),
    consultedAt: iso(row.consultedAt),
    rawPayload: row.rawPayload ?? null,
    ...primary,
    ...readGradeSources(row.id, row.gradeSources, viscosityGrades, liters != null, primary),
  };
}

function toTecfilCacheDto(row: {
  id: string;
  make: string;
  year: number;
  model: string;
  version: string;
  manufacturerLabel: string;
  vehicleLabel: string;
  engineLabel: string | null;
  matchedBy: unknown;
  oilFilters: unknown;
  fuelFilters: unknown;
  consultedAt: Date;
  rawPayload: unknown;
}): TecfilCompatibility {
  return {
    id: row.id,
    make: row.make,
    year: row.year,
    model: row.model,
    version: row.version,
    application: {
      manufacturer: row.manufacturerLabel,
      vehicle: row.vehicleLabel,
      engine: row.engineLabel,
    },
    matchedBy: row.matchedBy as TecfilCompatibility["matchedBy"],
    oilFilters: row.oilFilters as TecfilCompatibility["oilFilters"],
    fuelFilters: row.fuelFilters as TecfilCompatibility["fuelFilters"],
    consultedAt: iso(row.consultedAt),
    rawPayload: row.rawPayload ?? null,
  };
}

/**
 * @param prisma - The client the quote runs on.
 * @returns The compatibility-cache half of {@link OilQuoteStore}.
 */
export function compatibilityCaches(
  prisma: DbClient,
): Pick<
  OilQuoteStore,
  | "latestCompatibility"
  | "insertCompatibility"
  | "latestTecfilCompatibility"
  | "insertTecfilCompatibility"
> {
  return {
    async latestCompatibility(identity: VehicleIdentity) {
      const rows = await prisma.motulCompatibility.findMany({
        where: { year: identity.year },
      });
      const matches = rows
        .map(toCacheDto)
        .filter((row) =>
          motulIdentitiesMatch(
            { make: row.make, year: row.year, model: row.model, version: row.version },
            identity,
          ),
        );
      matches.sort((a, b) => b.consultedAt.localeCompare(a.consultedAt));
      return matches[0] ?? null;
    },
    async insertCompatibility(row) {
      const saved = await prisma.motulCompatibility.create({
        data: {
          make: row.make,
          year: row.year,
          model: row.model,
          version: row.version,
          viscosities: row.viscosityGrades,
          viscosity: row.viscosity,
          classification: row.classification,
          fillLiters: row.fillLiters,
          fillKind: row.fillKind,
          fillCondition: row.fillCondition ?? null,
          unusableFillLiters: row.unusableFillLiters ?? null,
          sourcePublisher: row.sourcePublisher,
          sourceDocument: row.sourceDocument,
          sourcePage: row.sourcePage,
          sourceAuthority: row.sourceAuthority ?? null,
          sourceUrl: row.sourceUrl ?? null,
          sourceClassification: row.sourceClassification ?? null,
          sourceExcerpt: row.sourceExcerpt ?? null,
          gradeSources: writeGradeSources(row.gradeSources, row.litersSource) ?? undefined,
          consultedAt: new Date(row.consultedAt),
          rawPayload: row.rawPayload === null ? undefined : (row.rawPayload as object),
        },
      });
      return toCacheDto(saved);
    },
    async latestTecfilCompatibility(identity: VehicleIdentity) {
      const rows = await prisma.tecfilCompatibility.findMany({
        where: { year: identity.year },
      });
      const matches = rows
        .map(toTecfilCacheDto)
        .filter((row) =>
          motulIdentitiesMatch(
            { make: row.make, year: row.year, model: row.model, version: row.version },
            identity,
          ),
        );
      matches.sort((a, b) => b.consultedAt.localeCompare(a.consultedAt));
      return matches[0] ?? null;
    },
    async insertTecfilCompatibility(row) {
      const saved = await prisma.tecfilCompatibility.create({
        data: {
          make: row.make,
          year: row.year,
          model: row.model,
          version: row.version,
          manufacturerLabel: row.application.manufacturer,
          vehicleLabel: row.application.vehicle,
          engineLabel: row.application.engine,
          matchedBy: row.matchedBy,
          oilFilters: row.oilFilters,
          fuelFilters: row.fuelFilters,
          consultedAt: new Date(row.consultedAt),
          rawPayload: row.rawPayload === null ? undefined : (row.rawPayload as object),
        },
      });
      return toTecfilCacheDto(saved);
    },
  };
}
