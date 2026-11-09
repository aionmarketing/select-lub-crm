/**
 * The ERP port over today's Omie adapter, and the adapter itself.
 *
 * Wave 5.1b absorbed `@select-lub/omie`: its transport half — the adapter port,
 * the HTTP adapter, the fake, the wire mapping, and the mock Omie source with
 * the TIDSCI dataset — lives in `erp-mock/`, and this file is its barrel. The
 * cadastro half went to the modules that own it: the engine and the store port
 * to `customers/contracts`, the pull to `erp/run-pull`. Nothing here imports a
 * module; the kernel is the bottom.
 */
import { createOmieAdapter } from "./erp-mock/create-adapter.js";
import type { ErpPort } from "./erp.js";

export type {
  IntegrationErrorInput,
  IntegrationErrorSink,
  OmieAdapter,
  OmieListedClient,
  OmieListPage,
  OmiePutResult,
  OmieSyncPort,
} from "./erp-mock/adapter.js";
export {
  createOmieAdapter,
  omieCredentialsConfigured,
  omieMockOptIn,
  resolveOmieAccess,
  type OmieAccessKind,
} from "./erp-mock/create-adapter.js";
export { createFakeOmie } from "./erp-mock/fake.js";
export {
  BRAZIL_CODIGO_PAIS,
  CONTEUDO_MAX,
  CRM_ONLY_KEYS,
  isVehicleField,
  SHARED_FIELD_KEYS,
  VEHICLE_FIELD_KEYS,
} from "./erp-mock/fields.js";
export { createHttpOmieAdapter, OMIE_CLIENTS_URL } from "./erp-mock/http.js";
export {
  countryFromWire,
  countryToWire,
  emptySnapshot,
  readSnapshotField,
  stringifyCrmValue,
  toWire,
  type CrmFieldValue,
  type OmieClientSnapshot,
} from "./erp-mock/map.js";
export {
  mockOmieDataset,
  type MockCatalogProduct,
  type MockDuplicatePair,
  type MockOmieClient,
  type MockServiceOrder,
  type MockServiceOrderItem,
  type MockVehicleIdentifier,
} from "./erp-mock/mock/dataset.js";
export { createMockOmie, prefixMockOmieIds, type MockOmieSource } from "./erp-mock/mock/source.js";
export { TidsciDatasetMissingError } from "./erp-mock/mock/tidsci/load.js";
export { unitIdForNewTidsciCustomer } from "./erp-mock/mock/tidsci/unit.js";
export { digitsOnly, sanitizeOmieText } from "./erp-mock/sanitize.js";

/**
 * Builds the ERP port from the Omie adapter.
 *
 * @returns A port backed by `createOmieAdapter()`, which reads the same
 *   environment it does today (mock or live, per `OMIE_*`).
 */
export function createErpFromOmie(): ErpPort {
  return { adapter: createOmieAdapter() };
}
