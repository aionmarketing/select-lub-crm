/**
 * `applyVehicleFieldEdit`: a vehicle edit — titular shared fields go through `applyCrmEdit`, the rest save locally.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import type { CustomerFieldEdit } from "../http.omie-sync.js";
import type { VehicleFieldEdit } from "../http.vehicle.js";
import type { OmieAdapter } from "../../../../kernel/clients/erp-mock.js";
import type { CadastroStore } from "../cadastro-store/port.js";
import { applyCrmEdit } from "./apply-crm-edit.js";
import type { ApplyVehicleEditResult } from "./results.js";
import { patchHasVehicleSharedKey, applyVehicleColumns } from "./values.js";

/**
 * Applies a vehicle patch — routes titular shared fields through `applyCrmEdit` and saves CRM-only columns locally.
 *
 * @param store - Cadastro persistence port.
 * @param adapter - Omie read/write port for titular shared fields.
 * @param input.vehicleId - CRM vehicle to edit.
 * @param input.unitId - Caller unit id; must match the owning customer's `unitId`.
 * @param input.patch - Vehicle field edit; shared keys on the titular vehicle go through customer sync.
 * @param input.actorId - Optional actor id forwarded to `applyCrmEdit`.
 * @returns `ok` with saved vehicle, `not_found`, `unit_mismatch`, or `omie_unavailable` when Omie fails on titular shared edits.
 */
export async function applyVehicleFieldEdit(
  store: CadastroStore,
  adapter: OmieAdapter,
  input: { vehicleId: string; unitId: string; patch: VehicleFieldEdit; actorId?: string },
): Promise<ApplyVehicleEditResult> {
  const vehicle = await store.getVehicle(input.vehicleId);
  if (!vehicle) {
    return { status: "not_found" };
  }
  const customer = await store.getCustomer(vehicle.customerId);
  if (!customer) {
    return { status: "not_found" };
  }
  if (customer.unitId !== input.unitId) {
    return { status: "unit_mismatch" };
  }

  const titular = await store.getVehicleForCustomer(customer.id);
  const isTitular = titular?.id === vehicle.id;
  const hasShared = patchHasVehicleSharedKey(input.patch);

  if (isTitular && hasShared) {
    const sharedPatch: CustomerFieldEdit = {};
    if (Object.hasOwn(input.patch, "plate")) {
      sharedPatch.plate = input.patch.plate;
    }
    if (Object.hasOwn(input.patch, "make")) {
      sharedPatch.make = input.patch.make;
    }
    if (Object.hasOwn(input.patch, "model")) {
      sharedPatch.model = input.patch.model;
    }
    if (Object.hasOwn(input.patch, "odometerKm")) {
      sharedPatch.odometerKm = input.patch.odometerKm;
    }
    const result = await applyCrmEdit(store, adapter, {
      customerId: customer.id,
      unitId: input.unitId,
      patch: sharedPatch,
      actorId: input.actorId,
    });
    if (result.status === "omie_unavailable") {
      const savedAfterFail = await store.getVehicle(input.vehicleId);
      if (!savedAfterFail) {
        return { status: "not_found" };
      }
      return { status: "omie_unavailable", vehicle: savedAfterFail };
    }
    if (result.status !== "ok") {
      return { status: result.status };
    }
  } else if (!isTitular) {
    applyVehicleColumns(vehicle, input.patch);
    await store.saveVehicle(vehicle);
  } else {
    applyVehicleColumns(vehicle, input.patch);
    await store.saveVehicle(vehicle);
  }

  if (isTitular && hasShared && (Object.hasOwn(input.patch, "version") || Object.hasOwn(input.patch, "year"))) {
    const row = await store.getVehicle(input.vehicleId);
    if (row) {
      if (Object.hasOwn(input.patch, "version")) {
        row.version = input.patch.version ?? null;
      }
      if (Object.hasOwn(input.patch, "year")) {
        row.year = input.patch.year ?? null;
      }
      await store.saveVehicle(row);
    }
  }

  const saved = await store.getVehicle(input.vehicleId);
  if (!saved) {
    return { status: "not_found" };
  }
  return { status: "ok", vehicle: saved };
}
