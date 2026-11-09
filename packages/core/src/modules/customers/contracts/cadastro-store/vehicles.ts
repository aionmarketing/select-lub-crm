/**
 * Vehicle reads and writes of the cadastro store, and a vehicle's Omie sync state.
 *
 * Moved from `apps/api/src/cadastro/prisma.ts` with bodies unchanged.
 */
import type { DbClient } from "@select-lub/core/db";
import type { CadastroStore } from "./port.js";
import { buildVehicleOmieSync } from "../http.omie-sync.js";
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";
import { toSync, toVehicle } from "./rows.js";

/** The vehicle methods of the cadastro store. */
export type VehicleMethods = Pick<
  CadastroStore,
  "getVehicleForCustomer" | "listVehicles" | "getVehicle" | "createVehicle" | "saveVehicle" | "getVehicleOmieSync"
>;

/**
 * The vehicle methods, over one client.
 *
 * @param prisma - The `customers` transaction the call runs in.
 * @returns The methods, with their bodies as the API's store had them.
 */
export function vehicleMethods(prisma: DbClient): VehicleMethods {
  return {
    async getVehicleForCustomer(customerId) {
      const row = await prisma.vehicle.findFirst({
        where: { customerId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      return row ? toVehicle(row) : null;
    },
    async listVehicles(customerId) {
      const rows = await prisma.vehicle.findMany({
        where: { customerId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      return rows.map(toVehicle);
    },
    async getVehicle(id) {
      const row = await prisma.vehicle.findUnique({ where: { id } });
      return row ? toVehicle(row) : null;
    },
    async createVehicle(vehicle) {
      await prisma.vehicle.create({
        data: {
          id: vehicle.id,
          customerId: vehicle.customerId,
          omieId: vehicle.omieId,
          plate: vehicle.plate,
          make: vehicle.make,
          model: vehicle.model,
          version: vehicle.version,
          year: vehicle.year,
          odometerKm: vehicle.odometerKm,
          origin: vehicle.origin,
          createdAt: new Date(vehicle.createdAt) } });
    },
    async saveVehicle(vehicle) {
      await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: {
          omieId: vehicle.omieId,
          plate: vehicle.plate,
          make: vehicle.make,
          model: vehicle.model,
          version: vehicle.version,
          year: vehicle.year,
          odometerKm: vehicle.odometerKm,
          origin: vehicle.origin } });
    },
    async getVehicleOmieSync(vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { id: true, omieId: true } });
      if (!vehicle) {
        return null;
      }
      const [syncRows, openPendings] = await Promise.all([
        prisma.vehicleFieldSync.findMany({ where: { vehicleId } }),
        prisma.vehicleReconciliationPending.findMany({
          where: { vehicleId, status: "open" } }),
      ]);
      // The ranking lives in the shared pure function, so Postgres and the
      // memory fake cannot report different states for the same rows.
      return buildVehicleOmieSync(
        vehicle,
        syncRows.map(toSync),
        openPendings.map((row) => ({
          fieldKey: row.fieldKey as OmieSharedFieldKey,
          crmValue: row.crmValue,
          omieValue: row.omieValue })),
      );
    },
  };
}
