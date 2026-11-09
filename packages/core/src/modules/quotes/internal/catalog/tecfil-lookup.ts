/**
 * Tecfil fitment port used by quote-options (injected so route tests never hit the network).
 *
 * Wraps `resolveFilters` from the Tecfil client (`kernel/clients/tecfil`) and translates its package-local shapes
 * into the shared CompatibilidadeTecfil vocabulary, so `options.ts` can cache and read the
 * result without importing Tecfil wire types.
 */
import { resolveFilters, type ResolveFiltersResult } from "../../../../kernel/clients/tecfil/index.js";
import type { TecfilCompatibility } from "../../contracts/http.js";
import { createTecfilOptionPicker } from "./tecfil-option-picker.js";
import type { UsageMeter } from "../model-calls/meter.js";
import type { VehicleIdentity } from "../store/store.js";

/** The cacheable half of a Tecfil answer: the application used, how it matched, and the candidates per type. */
export type TecfilFitment = Pick<
  TecfilCompatibility,
  "application" | "matchedBy" | "oilFilters" | "fuelFilters"
>;

/**
 * Outcome of a Tecfil fitment lookup.
 *
 * A resolved application is always `ok`, including when Tecfil lists no filter of one or
 * both types — an empty candidate list is a real answer worth caching, and the empty slot
 * is derived downstream. Task 3.3 named a fourth `no_fitment` outcome; it collapses into
 * `ok` for that reason (coordinator ruling, 2026-09-05).
 */
export type TecfilFitmentLookupResult =
  | { status: "ok"; fitment: TecfilFitment }
  | { status: "unmatched"; field: "manufacturer" | "vehicle" | "engine" | "year" }
  | { status: "unavailable" };

/** Looks up the oil-filter and fuel-filter fitment for a vehicle identity. */
export type TecfilFitmentLookup = (
  identity: VehicleIdentity,
) => Promise<TecfilFitmentLookupResult>;

/**
 * Translates one resolver candidate into the cached shape: the package names a part
 * `partNumber` / `productCode` and its equivalents `partNumber`, while the cache contract
 * names them `tecfilNumber` / `tecfilProductCode` and `number`. `sourceColumns` is a
 * diagnostic of the live grid and is not cached.
 */
function toCachedCandidates(
  candidates: Extract<ResolveFiltersResult, { status: "ok" }>["fitment"]["oilFilters"],
): TecfilFitment["oilFilters"] {
  return candidates.map((candidate) => ({
    tecfilNumber: candidate.partNumber,
    tecfilProductCode: candidate.productCode,
    description: candidate.description,
    crossReferences: candidate.crossReferences.map((reference) => ({
      brand: reference.brand,
      number: reference.partNumber,
    })),
  }));
}

/**
 * Maps a `resolveFilters` outcome to the port's vocabulary.
 *
 * @param result - Whatever `resolveFilters` returned; it never throws.
 * @returns `ok` with the cacheable fitment; `unmatched` with the field for both `needs`
 * (an identity field the CRM left empty) and `unmatched` (a value Tecfil's list has no
 * entry for), since the quote treats them the same way; `unavailable` when Tecfil failed.
 */
export function toFitmentLookupResult(
  result: ResolveFiltersResult,
): TecfilFitmentLookupResult {
  if (result.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (result.status === "needs" || result.status === "unmatched") {
    return { status: "unmatched", field: result.field };
  }
  const { fitment } = result;
  return {
    status: "ok",
    fitment: {
      application: {
        manufacturer: fitment.manufacturerLabel,
        vehicle: fitment.vehicleLabel,
        engine: fitment.engineLabel,
      },
      matchedBy: fitment.matchedBy,
      oilFilters: toCachedCandidates(fitment.oilFilters),
      fuelFilters: toCachedCandidates(fitment.fuelFilters),
    },
  };
}

/** A research run's Tecfil answer, and whether the option picker failed on the way (D12). */
export type ResearchTecfilAnswer = { result: TecfilFitmentLookupResult; pickerFailed: boolean };

/** The Tecfil port a research run uses. */
export type ResearchTecfilLookup = (identity: VehicleIdentity) => Promise<ResearchTecfilAnswer>;

/**
 * The research run's Tecfil lookup (background-oil-research D9, D12): `resolveFilters` with a
 * picker metered on the run's meter (outside the cap), bounded by the run's signal, and told
 * apart when it fails — so an `unmatched` that followed a picker failure is retried as
 * `unavailable`, never cached as a genuine no-match. The Tecfil client is unchanged; its own 8 s
 * GETs are not threaded (D9).
 *
 * @param options.meter - The run's meter.
 * @param options.signal - The run's signal.
 */
export function createResearchTecfilLookup(options: { meter?: UsageMeter; signal?: AbortSignal } = {}): ResearchTecfilLookup {
  return async (identity) => {
    let pickerFailed = false;
    const pickOption = createTecfilOptionPicker({
      ...(options.meter ? { meter: options.meter } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onFailure: () => {
        pickerFailed = true;
      },
    });
    const result = await resolveFilters(
      { make: identity.make, year: String(identity.year), model: identity.model, version: identity.version },
      { pickOption },
    );
    return { result: toFitmentLookupResult(result), pickerFailed };
  };
}

/**
 * Production Tecfil lookup: `resolveFilters` with the LLM option picker injected.
 *
 * The picker is created per call so a key added to the environment after boot still takes
 * effect, and it degrades to no pick when `OPENAI_API_KEY` is absent.
 */
export const productionTecfilLookup: TecfilFitmentLookup = async (identity) => {
  const result = await resolveFilters(
    {
      make: identity.make,
      year: String(identity.year),
      model: identity.model,
      version: identity.version,
    },
    { pickOption: createTecfilOptionPicker() },
  );
  return toFitmentLookupResult(result);
};
