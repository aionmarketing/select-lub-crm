/**
 * The cadastro engine: the one place a customer's or vehicle's shared fields are
 * edited, reconciled with Omie, and pushed back. See `README.md` for who may call
 * which entry point.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged. It
 * lives under `contracts/`, not `internal/`, for the rule 4B's cadastro store
 * follows: a contract may not import `internal/`, and two contracts call the
 * engine — `apply-prefill-suggestion` here and erp's pull.
 */
export { applyCrmEdit } from "./apply-crm-edit.js";
export { ingestOmieSnapshot } from "./ingest.js";
export { persistPrefillAccept } from "./prefill.js";
export { resolvePending } from "./resolve-pending.js";
export type { ApplyCrmEditResult, ApplyVehicleEditResult } from "./results.js";
export { getBusinessValue } from "./values.js";
export { applyVehicleFieldEdit } from "./vehicle-edit.js";
