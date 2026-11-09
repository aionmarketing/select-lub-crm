/**
 * The services module's public surface: what another module, `apps/api` or
 * `apps/worker` may call. Reached from outside the package as
 * `@select-lub/core/modules/services/contracts`.
 *
 * - `return-state`: the one classification of a stored return date, read by
 *   Follow-up and by the Serviços filter.
 * - `archive-vehicle-return`: the two writes `scheduling`'s archive routes make.
 * - `reconcile-vehicle-returns` and `import-from-erp`: what `erp`'s pull calls.
 * - `http`: the wire shapes of the five routes.
 */
export {
  classifyReturnDate,
  followUpReturnWindow,
  type ReturnState,
} from "./return-state.js";
export { archiveVehicleReturn, unarchiveVehicleReturn, VehicleReturnAlreadyOpenError } from "./archive-vehicle-return.js";
export {
  reconcileVehicleReturns,
  reconcileVehicleReturnsAfterImport,
  type ReconcileVehicleReturnsResult,
} from "./reconcile-vehicle-returns.js";
export { createServiceImportStore, type ServiceImportStore } from "./import-from-erp.js";
export * from "./http.js";
