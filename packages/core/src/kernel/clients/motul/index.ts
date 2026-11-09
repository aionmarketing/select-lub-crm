/**
 * Public entry point for the Motul client (`kernel/clients/motul`, moved from `packages/motul` in wave 5.1a) — HTTP client, wire types, flattening, and oil resolver.
 */

export {
  getVehicleBrands,
  getVehicleModels,
  getSubModels,
  getOilRecommendation,
  MotulError,
  resetMotulBreaker,
  MOTUL_DEFAULT_BASE_URL,
} from "./client.js";

export { flattenRecommendation } from "./flatten.js";
export { pickEngineFillLiters, pickDryFillLiters, parseCapacityLiters } from "./pick-fill.js";
export type { FillKind, PickedFill } from "./pick-fill.js";
export type {
  FlatCapacity,
  FlatProduct,
  FlatConditionVariant,
  FlatCategoryPart,
  FlatRecommendation,
} from "./flatten.js";

export {
  resolveOil,
  normalizeMotulName,
  motulIdentitiesMatch,
} from "./resolver.js";
export type { ResolveOilResult, ResolveField } from "./resolver.js";

export type {
  VehicleBrand,
  VehicleModel,
  SubModel,
  MotulRecommendation,
} from "./wire.js";
