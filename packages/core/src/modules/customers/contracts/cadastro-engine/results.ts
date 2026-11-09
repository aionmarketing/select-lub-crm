/**
 * The status unions the engine's edit entry points return.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import type { CustomerRecord, VehicleRecord } from "../cadastro-store/port.js";

/** Outcome of a customer field edit, including Omie availability and unit/link guards. */
export type ApplyCrmEditResult =
  | { status: "ok"; customer: CustomerRecord }
  | { status: "not_found" }
  | { status: "unit_mismatch" }
  | { status: "not_linked" }
  | { status: "omie_unavailable"; customer: CustomerRecord };

/** Outcome of a vehicle field edit, including Omie availability and unit/link guards. */
export type ApplyVehicleEditResult =
  | { status: "ok"; vehicle: VehicleRecord }
  | { status: "not_found" }
  | { status: "unit_mismatch" }
  | { status: "not_linked" }
  | { status: "omie_unavailable"; vehicle: VehicleRecord };
