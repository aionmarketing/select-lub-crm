/**
 * Builds the vehicle row a create request writes.
 *
 * Moved from `apps/api/src/http/cadastro-link.ts` (`vehicleFromCreate`) with the
 * body unchanged (4B).
 */
import { randomUUID } from "node:crypto";
import type { VehicleRecord } from "../contracts/cadastro-store/port.js";
import type { VehicleCreateBody } from "../contracts/http.js";

/**
 * Builds a CRM-origin vehicle row from a create-body (new id and timestamps).
 *
 * @param customerId - Owner customer id
 * @param body - Create payload; omitted fields stay null
 */
export function vehicleFromCreate(customerId: string, body: VehicleCreateBody): VehicleRecord {
  const stamp = new Date().toISOString();
  return {
    id: randomUUID(),
    customerId,
    omieId: null,
    plate: body.plate ?? null,
    make: body.make ?? null,
    model: body.model ?? null,
    version: body.version ?? null,
    year: body.year ?? null,
    odometerKm: body.odometerKm ?? null,
    origin: "crm",
    createdAt: stamp,
    updatedAt: stamp,
  };
}
