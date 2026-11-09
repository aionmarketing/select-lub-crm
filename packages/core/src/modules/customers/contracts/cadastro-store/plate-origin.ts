/**
 * Per-vehicle plate-sourced origin on `VehicleFieldSync`. Whoever writes the
 * field owns the origin: a confirmed lookup writes `PLACA`, any other write
 * writes `CRM`.
 *
 * Moved from `apps/api/src/cadastro/store.ts` and the end of `prisma.ts` (4B). It
 * sits beside the cadastro store on purpose: the two are the only writers of
 * `vehicle_field_sync`, each with its own `origin` vocabulary, and a change to
 * either is a change to both (see field-sync.ts).
 */
import type { DbClient } from "@select-lub/core/db";
import type { PlateSourcedFieldKey } from "../../../plate-lookup/contracts/http.js";
import type { Db } from "../../../../kernel/db.js";

/** Veículo keys a confirmed lookup may mark. `plate` and `odometerKm` are never marked. */
export const PLATE_SOURCED_FIELD_KEYS = ["make", "model", "version", "year"] as const satisfies readonly PlateSourcedFieldKey[];

/** Origin stored on `VehicleFieldSync` for a plate-confirmed or attendant-typed field. */
export type VehicleFieldWriteOrigin = "PLACA" | "CRM";

/** One field's provenance after a write. */
export type VehicleFieldOriginRow = {
  fieldKey: PlateSourcedFieldKey;
  origin: string;
  localVersion: number;
};

/**
 * Reads and writes plate provenance on the existing per-field sync row.
 *
 * There is no separate clear step: a `CRM` write is what drops the mark.
 */
export type VehiclePlateOriginStore = {
  /**
   * Upserts `VehicleFieldSync` for one of make/model/version/year, bumping
   * `localVersion` the same way a CRM edit does.
   *
   * @param vehicleId - CRM vehicle primary key.
   * @param fieldKey - One of the four plate-sourced keys; other keys are a no-op.
   * @param origin - `PLACA` for a confirmed lookup value, `CRM` for a typed or overridden value.
   * @param changedBy - Actor id, or `null` for a system write.
   */
  writeFieldOrigin(
    vehicleId: string,
    fieldKey: PlateSourcedFieldKey,
    origin: VehicleFieldWriteOrigin,
    changedBy: string | null,
  ): Promise<void>;
  /**
   * Returns the keys currently marked plate-sourced.
   *
   * @param vehicleId - CRM vehicle primary key.
   * @returns Sorted `make`/`model`/`version`/`year` keys whose origin is `PLACA`.
   */
  listPlateSourcedKeys(vehicleId: string): Promise<PlateSourcedFieldKey[]>;
  /**
   * Returns origin and localVersion for one of the four keys.
   *
   * @param vehicleId - CRM vehicle primary key.
   * @param fieldKey - Field to read.
   * @returns The row, or `null` before any write.
   */
  getFieldOrigin(
    vehicleId: string,
    fieldKey: PlateSourcedFieldKey,
  ): Promise<VehicleFieldOriginRow | null>;
};

/**
 * Postgres {@link VehiclePlateOriginStore} that writes `VehicleFieldSync.origin`.
 *
 * `toSync` still maps anything other than `OMIE_SYNC` to `CRM` for the Omie
 * engine; this store reads the column directly so `PLACA` is visible to prefill
 * and the vehicle form.
 *
 * @param prisma - Shared Prisma client from `@select-lub/core/db`.
 * @returns A {@link VehiclePlateOriginStore} backed by `vehicle_field_sync`.
 */
function createPrismaVehiclePlateOriginStore(
  prisma: DbClient,
): VehiclePlateOriginStore {
  const keys = ["make", "model", "version", "year"] as const;
  return {
    async writeFieldOrigin(vehicleId, fieldKey, origin, changedBy) {
      if (!(keys as readonly string[]).includes(fieldKey)) {
        return;
      }
      await prisma.vehicleFieldSync.upsert({
        where: { vehicleId_fieldKey: { vehicleId, fieldKey } },
        create: {
          vehicleId,
          fieldKey,
          origin,
          localVersion: 1,
          changedBy },
        update: {
          localVersion: { increment: 1 },
          origin,
          changedBy } });
    },
    async listPlateSourcedKeys(vehicleId) {
      const rows = await prisma.vehicleFieldSync.findMany({
        where: { vehicleId, origin: "PLACA", fieldKey: { in: [...keys] } },
        select: { fieldKey: true } });
      return rows
        .map((row) => row.fieldKey)
        .filter((fieldKey): fieldKey is (typeof keys)[number] =>
          (keys as readonly string[]).includes(fieldKey),
        )
        .sort();
    },
    async getFieldOrigin(vehicleId, fieldKey) {
      const row = await prisma.vehicleFieldSync.findUnique({
        where: { vehicleId_fieldKey: { vehicleId, fieldKey } },
        select: { fieldKey: true, origin: true, localVersion: true } });
      if (!row) {
        return null;
      }
      return {
        fieldKey,
        origin: row.origin,
        localVersion: row.localVersion };
    } };
}

/**
 * The plate-origin store, one `customers` transaction per call.
 *
 * Moved from `apps/api/src/cadastro/prisma.ts` (`createPrismaVehiclePlateOriginStore`)
 * with the body unchanged (4B). It writes the same `vehicle_field_sync` rows the
 * cadastro store's field-sync methods write, with its own origin vocabulary
 * (`PLACA` / `CRM`); both writers keep their vocabulary exactly as it was.
 *
 * @param db - The database handle.
 * @returns A {@link VehiclePlateOriginStore} whose writes run under `module_customers`.
 */
export function createPlateOriginStore(db: Db): VehiclePlateOriginStore {
  const on = (tx: DbClient) => createPrismaVehiclePlateOriginStore(tx);
  return {
    writeFieldOrigin: (...args) => db.tx("customers", (tx) => on(tx).writeFieldOrigin(...args)),
    listPlateSourcedKeys: (...args) => db.tx("customers", (tx) => on(tx).listPlateSourcedKeys(...args)),
    getFieldOrigin: (...args) => db.tx("customers", (tx) => on(tx).getFieldOrigin(...args)),
  };
}
