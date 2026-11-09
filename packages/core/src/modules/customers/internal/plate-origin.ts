/**
 * Maps a vehicle create/patch body onto `VehiclePlateOriginStore` writes and
 * attaches `plateSourcedKeys` on GET/create/patch responses.
 */
import { vehicleToDto } from "../contracts/cadastro-dto.js";
import type { VehicleRecord } from "../contracts/cadastro-store/port.js";
import type { PlateSourcedFieldKey } from "../../plate-lookup/contracts/http.js";
import type { Vehicle, VehicleCreateBody, VehicleFieldEdit } from "../contracts/http.js";
import {
  PLATE_SOURCED_FIELD_KEYS,
  type VehicleFieldWriteOrigin,
  type VehiclePlateOriginStore,
} from "../contracts/cadastro-store/plate-origin.js";

/** One origin write implied by a vehicle body. */
export type VehicleOriginWrite = {
  fieldKey: PlateSourcedFieldKey;
  origin: VehicleFieldWriteOrigin;
};

/**
 * Origin writes for identity keys present on this body. Omitted keys are left
 * alone. A listed `plateSourcedKeys` entry that was not written is ignored.
 *
 * @param body - Create or patch payload after zod parse.
 * @returns `PLACA` when the key is listed in `plateSourcedKeys`, otherwise `CRM`.
 */
export function originWritesFromVehicleBody(
  body: Pick<VehicleCreateBody & VehicleFieldEdit, "make" | "model" | "version" | "year" | "plateSourcedKeys">,
): VehicleOriginWrite[] {
  const sourced = new Set(body.plateSourcedKeys ?? []);
  const writes: VehicleOriginWrite[] = [];
  for (const fieldKey of PLATE_SOURCED_FIELD_KEYS) {
    if (!Object.hasOwn(body, fieldKey)) {
      continue;
    }
    writes.push({ fieldKey, origin: sourced.has(fieldKey) ? "PLACA" : "CRM" });
  }
  return writes;
}

/**
 * Drops `plateSourcedKeys` so the Omie engine only sees vehicle columns.
 *
 * @param body - Create or patch payload that may carry provenance.
 * @returns The same object without `plateSourcedKeys`.
 */
export function vehicleFieldPatch<T extends { plateSourcedKeys?: unknown }>(
  body: T,
): Omit<T, "plateSourcedKeys"> {
  const { plateSourcedKeys, ...patch } = body;
  void plateSourcedKeys;
  return patch;
}

/**
 * Persists origin writes for the identity keys present on this body.
 *
 * @param originStore - Per-vehicle `PLACA`/`CRM` port.
 * @param vehicleId - CRM vehicle primary key.
 * @param body - Create or patch payload after zod parse.
 * @param actorId - Attendant id, or `null` for a system write.
 */
export async function applyVehicleOriginWrites(
  originStore: VehiclePlateOriginStore,
  vehicleId: string,
  body: Pick<VehicleCreateBody & VehicleFieldEdit, "make" | "model" | "version" | "year" | "plateSourcedKeys">,
  actorId: string | null,
): Promise<void> {
  for (const write of originWritesFromVehicleBody(body)) {
    await originStore.writeFieldOrigin(vehicleId, write.fieldKey, write.origin, actorId);
  }
}

/**
 * Builds the public vehicle DTO with the keys currently marked plate-sourced.
 *
 * @param row - Stored vehicle row.
 * @param originStore - Per-vehicle origin port.
 * @returns API vehicle including `plateSourcedKeys` (empty when none are marked).
 */
export async function vehicleDtoWithOrigins(
  row: VehicleRecord,
  originStore: VehiclePlateOriginStore,
): Promise<Vehicle> {
  return vehicleToDto(row, await originStore.listPlateSourcedKeys(row.id));
}
