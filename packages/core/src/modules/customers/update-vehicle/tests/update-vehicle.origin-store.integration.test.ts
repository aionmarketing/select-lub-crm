/**
 * Test design (testing-strategy)
 *
 * SUT: `createPrismaVehiclePlateOriginStore` — the only implementation, now
 *   that the memory fake is gone (openspec change route-tests-on-real-database,
 *   wave 2B).
 *
 * Moved from `apps/api/src/cadastro/origin.test.ts` (adopt-modular-vertical-slices
 *   4B): the SUT is now `createPlateOriginStore(db)` in
 *   `contracts/cadastro-store/plate-origin.ts` (same body), the cadastro store
 *   `createCadastroStore(db)`, and both run every call under `module_customers`.
 *   `toSync`, cited as prisma.ts:126 below, is now in `contracts/cadastro-store/rows.ts`.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`. Every write goes to the
 *   real `vehicle_field_sync` table inside the test transaction and rolls back,
 *   which replaces the old file's `afterAll` delete of the customer and vehicle
 *   it created (that cleanup ran only when the suite reached the end).
 *
 * Spec: plate-sourced mark on make/model/version/year; a typed field and
 * odometerKm are never marked; the writer sets origin, with no separate clear.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (required by the change)
 *   1. **A vehicle id that is not a vehicle.** Every memory case wrote against
 *      the literal `"veh-1"` / `"veh-same"`. `vehicle_field_sync.vehicle_id` is
 *      a non-null FK to `vehicle` with `onDelete: Cascade`, so a write for an
 *      id no vehicle carries raises a foreign-key violation rather than storing
 *      a row. On the fake it was a Map key, so the port looked usable without a
 *      vehicle existing at all. Every case now writes against a real row.
 *   2. **The origin store and the field-sync store share one table.** The fake
 *      kept plate origins in a Map of its own, entirely unrelated to the sync
 *      rows `CadastroStore.getSync` reads, so the two ports could not be
 *      observed interfering. On Postgres `writeFieldOrigin` upserts the SAME
 *      `vehicle_field_sync` row keyed by `(vehicle_id, field_key)` that
 *      `bumpLocal` increments: an origin write bumps the sync row's
 *      `localVersion`, and a CRM edit overwrites the origin the lookup wrote.
 *      The last case pins that, because it is a real coupling the fake hid and
 *      the two ports' documentation does not mention.
 *
 *      CORRECTED DURING MIGRATION, per the change's standard that a test which
 *      fails on the real adapter was wrong: that case first asserted
 *      `getSync(...).origin === "PLACA"` and failed with `"CRM"`. This is not a
 *      defect. The two ports share the `origin` column but not its vocabulary —
 *      the origin store writes PLACA/CRM, while `FieldSyncRow.origin` is the
 *      two-value `FieldOrigin` and `toSync` (prisma.ts:126) maps anything that
 *      is not OMIE_SYNC to CRM. The consequence, which the assertion now states
 *      outright, is that the sync engine cannot tell a plate-sourced field from
 *      a typed one, and an ordinary CRM edit to that field silently clears the
 *      plate mark. Neither half was observable on the fake, where the two ports
 *      kept unrelated Maps.
 *
 * Axes
 *   A1 origin write — PLACA / CRM
 *   A2 key — make / model / version / year
 *   A3 localVersion — first write 1 / second write 2
 *   A4 other port — the cadastro sync adapter reading the same row
 *
 * Outputs: O1 marked keys; O2 origin after an override; O3 localVersion;
 *   O4 the sync row the other port sees
 *
 * Decision map (createPrismaVehiclePlateOriginStore)
 *   `!keys.includes(fieldKey)` early return
 *     T — TYPE-HIDDEN, and newly so under this migration. The old file never
 *         sampled it either; a case was drafted here and `pnpm typecheck`
 *         rejected it, because `VehiclePlateOriginStore.writeFieldOrigin`'s
 *         `fieldKey` parameter is the union of exactly those four keys, so
 *         `odometerKm` cannot be passed without a cast. The guard is defensive
 *         against an untyped caller; a cast would assert behaviour in a state
 *         the contract forbids, so the branch is recorded rather than sampled.
 *     F — every `it`
 *   `listPlateSourcedKeys` filter/sort — the first and fourth `it`
 *   `getFieldOrigin` row absent / present — the first `it` covers both
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";
import { createPlateOriginStore } from "../../contracts/cadastro-store/plate-origin.js";

/**
 * The database handle over the test's transaction; each store call on it runs
 * in its own `db.tx("customers", …)`, so under `module_customers`.
 *
 * @param tx - The test transaction.
 * @returns The handle.
 */
function dbOn(tx: DbClient) {
  return createDb(tx, runInTransactionOnTx(tx));
}

/**
 * Creates a customer and one vehicle, because `vehicle_field_sync` is keyed by a
 * real vehicle id.
 *
 * @param tx - The test transaction.
 * @returns The vehicle's id.
 */
async function seedVehicle(tx: DbClient): Promise<string> {
  const unit = await seedUnit(tx);
  const customer = await tx.customer.create({
    data: { unitId: unit.id, origin: "crm", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, origin: "crm" },
    select: { id: true },
  });
  return vehicle.id;
}

describeWithDatabase("VehiclePlateOriginStore", () => {
  const db = () => prisma as PrismaClient;

  it("marks confirmed lookup fields PLACA and leaves a typed field unmarked", () =>
    withTestTransaction(db(), async (tx) => {
      const vehicleId = await seedVehicle(tx);
      const store = createPlateOriginStore(dbOn(tx));

      await store.writeFieldOrigin(vehicleId, "make", "PLACA", null);
      await store.writeFieldOrigin(vehicleId, "model", "PLACA", null);
      await store.writeFieldOrigin(vehicleId, "version", "CRM", null);

      expect(await store.listPlateSourcedKeys(vehicleId)).toEqual(["make", "model"]);
      expect(await store.getFieldOrigin(vehicleId, "make")).toMatchObject({
        origin: "PLACA",
        localVersion: 1,
      });
      expect(await store.getFieldOrigin(vehicleId, "version")).toMatchObject({
        origin: "CRM",
        localVersion: 1,
      });
      // `year` was never written, so it is absent rather than merely unmarked.
      expect(await store.getFieldOrigin(vehicleId, "year")).toBeNull();
    }));

  it("increments localVersion on a plate write the same way a later CRM write does", () =>
    withTestTransaction(db(), async (tx) => {
      const vehicleId = await seedVehicle(tx);
      const store = createPlateOriginStore(dbOn(tx));

      await store.writeFieldOrigin(vehicleId, "year", "PLACA", null);
      expect((await store.getFieldOrigin(vehicleId, "year"))?.localVersion).toBe(1);

      await store.writeFieldOrigin(vehicleId, "year", "CRM", null);
      expect(await store.getFieldOrigin(vehicleId, "year")).toMatchObject({
        origin: "CRM",
        localVersion: 2,
      });
    }));

  it("clears the mark on a CRM write with no separate clearing step", () =>
    withTestTransaction(db(), async (tx) => {
      const vehicleId = await seedVehicle(tx);
      const store = createPlateOriginStore(dbOn(tx));

      await store.writeFieldOrigin(vehicleId, "make", "PLACA", null);
      // Precondition: the mark was there to clear, so the empty list below is
      // not the empty list of a write that never landed.
      expect(await store.listPlateSourcedKeys(vehicleId)).toEqual(["make"]);

      await store.writeFieldOrigin(vehicleId, "make", "CRM", null);

      expect(await store.listPlateSourcedKeys(vehicleId)).toEqual([]);
      expect((await store.getFieldOrigin(vehicleId, "make"))?.origin).toBe("CRM");
    }));

  it("writes the same row the cadastro sync adapter reads, so the two ports share state", () =>
    withTestTransaction(db(), async (tx) => {
      const vehicleId = await seedVehicle(tx);
      const handle = dbOn(tx);
      const origins = createPlateOriginStore(handle);
      const cadastro = createCadastroStore(handle);

      await origins.writeFieldOrigin(vehicleId, "make", "PLACA", null);

      // The sync port sees the origin store's row — same table, same composite
      // key — but NOT its vocabulary: `FieldSyncRow.origin` is the two-value
      // `FieldOrigin`, and `toSync` (prisma.ts:126) collapses everything that is
      // not OMIE_SYNC to CRM. So a plate-sourced field is indistinguishable from
      // a typed one to the sync engine, while the origin port still reports
      // PLACA off the same row. Asserting both is what pins the shared row.
      const afterPlate = await cadastro.getSync({ vehicleId }, "make");
      expect(afterPlate).toMatchObject({ origin: "CRM", localVersion: 1 });
      expect(await origins.getFieldOrigin(vehicleId, "make")).toMatchObject({
        origin: "PLACA",
        localVersion: 1,
      });

      // And the reverse: a CRM edit through the sync port bumps the version the
      // origin port reports, and relabels the field as CRM-originated.
      await cadastro.bumpLocal({ vehicleId }, "make", null);

      expect(await origins.getFieldOrigin(vehicleId, "make")).toMatchObject({
        origin: "CRM",
        localVersion: 2,
      });
      expect(await origins.listPlateSourcedKeys(vehicleId)).toEqual([]);
    }));
});
