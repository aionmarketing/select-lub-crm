/**
 * Public entry point for the plate clients (`kernel/clients/placas`, moved from `packages/placas` in wave 5.1a) — plate parsing, the provider port,
 * both HTTP adapters, the mock, and source selection.
 */

export { parsePlate } from "./plate.js";
export { absentPositiveInt, absentString } from "./absent.js";
export {
  collectBilledCalls,
  failedLookup,
  foundOrNotFound,
  hasAnyField,
} from "./port.js";
export type {
  BilledCall,
  LookupFailure,
  LookupResult,
  PlateFields,
  PlateProvider,
} from "./port.js";
export { stripOwnerIdentifyingKeys } from "./strip-owner.js";
export { PROVIDER_TIMEOUT_MS } from "./timeout.js";
export type { FetchLike } from "./timeout.js";
export {
  AGREGADOS_PROPRIA,
  AGREGADOS_PROPRIA_URL,
  createAgregadosPropriaAdapter,
} from "./agregados-propria.js";
export { API_PLACAS, createApiPlacasAdapter } from "./api-placas.js";
export { COMPOSED_PROVIDER, composePlateProviders } from "./compose.js";
export { mockPlacasDataset } from "./mock/dataset.js";
export { MOCK_PROVIDER, createMockPlateProvider } from "./mock/source.js";
export {
  createPlacasProvider,
  placasCredentialsConfigured,
  placasMockOptIn,
  resolvePlacasAccess,
} from "./create-adapter.js";
export type { PlacasAccessKind } from "./create-adapter.js";
