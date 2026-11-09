/**
 * The customers module: the cadastro — customers, their vehicles, the per-field
 * sync with Omie, and the reconciliation pendings. The only file the composition
 * roots import.
 *
 * `createHttpPlugin()` mounts the twelve cadastro routes, moved from
 * `apps/api/src/cadastro/routes.ts` (4B). The cadastro logic itself is the engine
 * in `contracts/cadastro-engine` (absorbed from `@select-lub/omie` in 5.1b); this
 * module owns it, the store it runs on (`contracts/cadastro-store`, every call in
 * `db.tx("customers", …)`), and the routes around it. The write-back
 * to Omie stays synchronous (ruling Q1a), through the adapter `createHttpPlugin` is
 * given — held in its closure, one per app, never the process-wide ERP port (W2-C6).
 *
 * Other modules reach it through `contracts/`: the ERP pull through
 * `import-from-erp`, prefill through `apply-prefill-suggestion`, the quote's engine pick
 * through `correct-vehicle-version`, and anyone may
 * subscribe to `customer-changed` and `vehicle-changed` (no subscriber yet).
 */
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import { route as createConversationVehicleRoute } from "./create-conversation-vehicle/index.js";
import { route as createCustomerVehicleRoute } from "./create-customer-vehicle/index.js";
import { route as getConversationCustomerRoute } from "./get-conversation-customer/index.js";
import { route as getVehicleErpSyncRoute } from "./get-vehicle-erp-sync/index.js";
import { route as linkConversationCustomerRoute } from "./link-conversation-customer/index.js";
import { route as listConversationVehiclesRoute } from "./list-conversation-vehicles/index.js";
import { route as listCustomerPendingsRoute } from "./list-customer-pendings/index.js";
import { route as listCustomerVehiclesRoute } from "./list-customer-vehicles/index.js";
import { route as listUnitPendingsRoute } from "./list-unit-pendings/index.js";
import { route as resolvePendingRoute } from "./resolve-pending/index.js";
import { route as updateCustomerRoute } from "./update-customer/index.js";
import { route as updateVehicleRoute } from "./update-vehicle/index.js";
import type { CustomerPorts } from "./internal/ports.js";

export {
  applyPrefillSuggestion,
  type ApplyPrefillSuggestionInput,
  type ApplyPrefillSuggestionResult,
} from "./contracts/apply-prefill-suggestion.js";
export {
  correctVehicleVersion,
  versionWithEngine,
  VEHICLE_VERSION_MAX_LENGTH,
  type CorrectVehicleVersionResult,
} from "./contracts/correct-vehicle-version.js";
export type { CustomerPorts } from "./internal/ports.js";
export { createCadastroStore } from "./contracts/cadastro-store/index.js";
export { templateValuesFrom } from "./contracts/template-values.js";
export type { CadastroStore } from "./contracts/cadastro-store/port.js";
// For apps/api's cadastro live tests, which drive the engine against Postgres.
export { applyCrmEdit, ingestOmieSnapshot } from "./contracts/cadastro-engine/index.js";
export { customerChanged, type CustomerChanged } from "./contracts/customer-changed.js";
export { createCadastroImportStore } from "./contracts/import-from-erp.js";
export { vehicleChanged, type VehicleChanged } from "./contracts/vehicle-changed.js";

/**
 * The customers module's routes.
 *
 * @param ports - The Omie adapter the six routes that read or push to Omie use,
 *   held in this closure, one per app.
 * @returns A plugin that mounts the twelve cadastro slices. They read the database
 *   from `request.server.db` and Omie through `ports`.
 */
export function createHttpPlugin(ports: CustomerPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "customers", "update-customer", updateCustomerRoute(ports));
    registerSlice(app, "customers", "list-customer-pendings", listCustomerPendingsRoute);
    registerSlice(app, "customers", "resolve-pending", resolvePendingRoute(ports));
    registerSlice(app, "customers", "list-unit-pendings", listUnitPendingsRoute);
    registerSlice(app, "customers", "list-customer-vehicles", listCustomerVehiclesRoute);
    registerSlice(app, "customers", "create-customer-vehicle", createCustomerVehicleRoute);
    registerSlice(app, "customers", "update-vehicle", updateVehicleRoute(ports));
    registerSlice(app, "customers", "get-vehicle-erp-sync", getVehicleErpSyncRoute);
    registerSlice(app, "customers", "list-conversation-vehicles", listConversationVehiclesRoute(ports));
    registerSlice(app, "customers", "get-conversation-customer", getConversationCustomerRoute(ports));
    registerSlice(app, "customers", "link-conversation-customer", linkConversationCustomerRoute(ports));
    registerSlice(app, "customers", "create-conversation-vehicle", createConversationVehicleRoute);
  };
}
