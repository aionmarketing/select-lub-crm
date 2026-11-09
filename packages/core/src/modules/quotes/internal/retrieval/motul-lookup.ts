/**
 * Motul lookup port used by quote-options (injected so route tests never hit the network).
 */
import { resolveOil, type FlatRecommendation } from "../../../../kernel/clients/motul/index.js";
import type { VehicleIdentity } from "../store/store.js";

/** Outcome of a Motul spec lookup for quote-options. */
export type MotulSpecLookupResult =
  | { status: "ok"; viscosity: string; classification: string }
  | { status: "no_spec" }
  | { status: "unavailable" };

/** Looks up viscosity + classification for a vehicle identity. */
export type MotulSpecLookup = (identity: VehicleIdentity) => Promise<MotulSpecLookupResult>;

const VISCOSITY = /(\d+W-?\d+)/i;

/**
 * Pulls engine viscosity (from a Motul product name) and classification (`spec`) out of a flattened recommendation.
 * @param recommendation - `resolveOil` ok payload.
 * @returns Both strings, or `null` when the motor part has no usable product.
 */
export function specFromFlatRecommendation(recommendation: FlatRecommendation) {
  const motor =
    recommendation.parts.Motor ??
    recommendation.parts.motor ??
    Object.entries(recommendation.parts).find(([key]) => key.toLowerCase() === "motor")?.[1];
  const products = motor?.products ?? motor?.byCondition?.[0]?.products ?? [];
  const product = products[0];
  if (!product) {
    return null;
  }
  const viscosity = product.name.match(VISCOSITY)?.[1];
  const classification = product.spec?.trim();
  if (!viscosity || !classification) {
    return null;
  }
  return { viscosity, classification };
}

/**
 * Production Motul lookup wrapping `resolveOil` with no extra HTTP of its own.
 *
 * `displacementCc` and `fuel` on the identity are ignored here: Motul's catalog
 * is keyed on brand/year/model/submodel, and this wrapper does not invent a
 * match from displacement or fuel.
 */
export const productionMotulLookup: MotulSpecLookup = async (identity) => {
  const result = await resolveOil({
    brand: identity.make,
    year: String(identity.year),
    model: identity.model,
    submodel: identity.version,
  });
  if (result.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (result.status !== "ok") {
    return { status: "no_spec" };
  }
  const spec = specFromFlatRecommendation(result.recommendation);
  if (!spec) {
    return { status: "no_spec" };
  }
  return { status: "ok", ...spec };
};
