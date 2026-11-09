/**
 * The vehicle a quote is about, if — and only if — the caller's unit may see it.
 *
 * A vehicle has no unit of its own; it belongs to its owning customer's unit.
 * Both quote routes answer 404 for a vehicle that does not exist and for one
 * whose owner is in another unit, alike, so the response confirms nothing about
 * a vehicle outside the caller's unit.
 *
 * A foreign READ of `vehicle` and `customer`, which `ownership.json` makes
 * readable by every module, so it needs no contract from `customers` and runs on
 * the quote's own `quotes` transaction. It replaces the two `cadastroStore` reads
 * (`getVehicle`, then `getCustomer`) the old routes made, and returns the same
 * DTO the old routes built with `vehicleToDto`.
 */
import type { DbClient } from "@select-lub/core/db";
import { vehicleToDto } from "../../../customers/contracts/cadastro-dto.js";
import type { Vehicle } from "../../../customers/contracts/http.js";

/** The vehicle as a quote needs it, and the customer a quote is written against. */
export type VehicleInUnit = { vehicle: Vehicle; customerId: string };

/**
 * @param tx - The quote's transaction client.
 * @param vehicleId - The vehicle id from the path.
 * @param unitId - The unit the request is scoped to.
 * @returns The vehicle and its owner's id, or `null` when the vehicle is missing or
 *   its owner is not in `unitId`.
 */
export async function findVehicleInUnit(
  tx: DbClient,
  vehicleId: string,
  unitId: string,
): Promise<VehicleInUnit | null> {
  const row = await tx.vehicle.findUnique({
    where: { id: vehicleId },
    include: { customer: { select: { unitId: true } } },
  });
  if (!row || row.customer.unitId !== unitId) {
    return null;
  }
  return {
    vehicle: vehicleToDto({
      id: row.id,
      customerId: row.customerId,
      omieId: row.omieId,
      plate: row.plate,
      make: row.make,
      model: row.model,
      version: row.version,
      year: row.year,
      odometerKm: row.odometerKm,
      origin: row.origin,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
    customerId: row.customerId,
  };
}
