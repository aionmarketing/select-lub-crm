/**
 * Stepwise Motul catalog resolver: walks brand → year → model → submodel, then fetches and flattens oil specs.
 */

import {
  getVehicleBrands,
  getVehicleModels,
  getSubModels,
  getOilRecommendation,
} from "./client.js";
import type { VehicleBrand } from "./wire.js";
import { flattenRecommendation } from "./flatten.js";
import type { FlatRecommendation } from "./flatten.js";

/** Identity field the resolver still needs or could not match against the Motul catalog. */
export type ResolveField = "brand" | "year" | "model" | "submodel";

/** Outcome of `resolveOil`: ask for a field, report no match, return flattened specs, or signal API failure. */
export type ResolveOilResult =
  | { status: "needs"; field: ResolveField; options: string[] }
  | { status: "unmatched"; field: ResolveField; options: string[] }
  | { status: "ok"; recommendation: FlatRecommendation }
  | { status: "unavailable" };

/**
 * Strips diacritics and non-alphanumeric characters, then uppercases for catalog name comparison.
 *
 * @param s - Display name from CRM or Motul (may include spaces, slashes, accents).
 * @returns Uppercase alphanumeric-only key; empty string when `s` has no letters or digits after normalization.
 */
export function normalizeMotulName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Returns whether two vehicle identities match after `normalizeMotulName` on make, model, and version.
 *
 * @param a - First identity with numeric `year` and string make/model/version.
 * @param b - Second identity compared field-wise to `a`.
 * @returns `true` when year matches and normalized make, model, and version strings are equal.
 */
export function motulIdentitiesMatch(
  a: { make: string; year: number; model: string; version: string },
  b: { make: string; year: number; model: string; version: string },
): boolean {
  return (
    a.year === b.year &&
    normalizeMotulName(a.make) === normalizeMotulName(b.make) &&
    normalizeMotulName(a.model) === normalizeMotulName(b.model) &&
    normalizeMotulName(a.version) === normalizeMotulName(b.version)
  );
}

function findByName<T extends { name: string }>(
  items: T[],
  query: string,
): T | undefined {
  return items.find((i) => normalizeMotulName(i.name) === normalizeMotulName(query));
}

const getAllCarBrands = (): Promise<VehicleBrand[]> => getVehicleBrands("CAR");

function messageToAgent(
  status: "needs" | "unmatched",
  field: ResolveField,
  options: string[] | { name: string }[],
): { status: "needs" | "unmatched"; field: ResolveField; options: string[] } {
  return {
    status,
    field,
    options: options.map((item) =>
      typeof item === "string" ? item : item.name,
    ),
  };
}

/**
 * Resolves partial vehicle identity against Motul catalog APIs and returns flattened oil specs on success.
 *
 * @param params.brand - Optional brand name to match against Motul `vehicle-brands`.
 * @param params.year - Optional year string; must be in the matched brand's `years` when brand is set.
 * @param params.model - Optional model name for the matched brand/year.
 * @param params.submodel - Optional submodel (vehicle type) name for the matched model.
 * @returns `needs` with catalog options when a field is missing; `unmatched` when a provided value is absent from options;
 *   `ok` with `FlatRecommendation` on success; `unavailable` when flattening yields no products or any Motul call throws.
 */
export async function resolveOil(params: {
  brand?: string;
  year?: string;
  model?: string;
  submodel?: string;
}): Promise<ResolveOilResult> {
  try {
    const validBrands = await getAllCarBrands();
    if (!params.brand) {
      return messageToAgent("needs", "brand", validBrands);
    }
    const matchedBrand = findByName(validBrands, params.brand);
    if (!matchedBrand) {
      return messageToAgent("unmatched", "brand", validBrands);
    }

    const validYears = matchedBrand.years;
    if (!params.year) {
      return messageToAgent("needs", "year", validYears);
    }
    if (!validYears.includes(params.year)) {
      return messageToAgent("unmatched", "year", validYears);
    }

    const validModels = await getVehicleModels(matchedBrand.id, params.year);
    if (!params.model) {
      return messageToAgent("needs", "model", validModels);
    }

    const matchedModel = findByName(validModels, params.model);
    if (!matchedModel) {
      return messageToAgent("unmatched", "model", validModels);
    }

    const validSubModels = await getSubModels(matchedModel.id);
    if (!params.submodel) {
      return messageToAgent("needs", "submodel", validSubModels);
    }

    const matchedSubModel = findByName(validSubModels, params.submodel);
    if (!matchedSubModel) {
      return messageToAgent("unmatched", "submodel", validSubModels);
    }

    const rawRecommendations = await getOilRecommendation(matchedSubModel.id);
    const recommendation = flattenRecommendation(
      rawRecommendations,
      matchedBrand.name,
    );

    if (!recommendation) {
      return { status: "unavailable" };
    }

    return { status: "ok", recommendation };
  } catch (err) {
    console.error("motul: resolve failed", err);
    return { status: "unavailable" };
  }
}
