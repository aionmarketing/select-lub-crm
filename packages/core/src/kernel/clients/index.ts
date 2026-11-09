/** Every third-party port, its production adapter, and its fake. */
export { bindErp, erp, type ErpPort } from "./erp.js";
export { createErpFromOmie } from "./erp-mock.js";
/** The Omie adapter, its fake and the mock dataset, for code outside core (apps, db seed). */
export * as omie from "./erp-mock.js";
export { bindPlacas, placas, createProductionPlacas, resetPlacas } from "./placas/binding.js";
export type { PlateProvider } from "./placas/index.js";
// The three HTTP clients, moved in from `packages/{motul,tecfil,placas}` (wave
// 5.1a). The plate adapters are `placasProviders` because `placas` is the port
// getter above.
export * as motul from "./motul/index.js";
export * as tecfil from "./tecfil/index.js";
export * as placasProviders from "./placas/index.js";
