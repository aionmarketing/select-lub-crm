/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles-origin.test.ts` (adopt-modular-
 * vertical-slices 4B); runs under module_customers. This file keeps that suite's
 * two `POST /customers/:id/vehicles` cases. The two PATCH cases went to
 * update-vehicle/tests/update-vehicle.origin.integration.test.ts, which carries
 * the old suite's full fake-only notes and its corrected-during-migration note.
 *
 * NOT MECHANICAL: the second case read its "a later GET agrees" half through
 *   `GET /customers/:id/vehicles`, which is the `list-customer-vehicles` slice's
 *   route. A slice's tests mount only their own slice, so that half now reads
 *   the same mark through the plate-origin store — the store the list route
 *   builds `plateSourcedKeys` from — and asserts the same value.
 *
 * SUT: the `plateSourcedKeys` round trip on `POST /customers/:id/vehicles`
 *   (the `create-customer-vehicle` slice), `originWritesFromVehicleBody`, and
 *   the cadastro and plate-origin stores.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. This route never reaches Omie
 *   and takes no adapter.
 *
 * Oracle: add-plate-lookup plate-lookup spec — confirmed lookup values are
 * marked plate-sourced on save; a typed field is not.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE — note 2 of the old suite applies:
 *   `cus-origin` was a Map key; the customer and its unit are real rows and the
 *   vehicle id is whatever Postgres assigned. Note 3 (the list's order) is why
 *   the old GET half matched by id; the store read below is by id already.
 *
 * Axes
 *   A1 write path — POST create
 *   A2 plateSourcedKeys — none / listed make / extra year
 *
 * Outputs: O1 201 `vehicleSchema.plateSourcedKeys`; O2 the stored mark agrees
 *
 * Sampled-cell
 *   POST no keys listed                 | A1 create A2 none   | [] | invented keys
 *   POST listed make, unwritten year    | A1 create A2 listed | ["make"] | ["make","year"]
 *
 * Decision map (create-customer-vehicle/index.ts + originWritesFromVehicleBody)
 *   hasOwn identity key  T: both its
 *   sourced listed       T: the make it; F: the no-keys it
 *
 * Out of scope: Conversas UI; provider HTTP (no test here reaches a provider).
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createPlateOriginStore } from "../../contracts/cadastro-store/plate-origin.js";
import { vehicleSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/**
 * Creates the unit, the attendant and one unlinked customer, and mounts the
 * slice on the test transaction.
 *
 * The customer carries no `omieId`: this suite is about origin marks, not
 * synchronisation.
 *
 * @param tx - The test transaction.
 * @returns The app, the unit, the customer's id and the plate-origin store.
 */
async function seedCustomer(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({
    data: { name: "Ana", unitId: unit.id, omieId: null, origin: "manual", status: "active" },
    select: { id: true },
  });
  const db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "customers", "create-customer-vehicle", route),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, unit, customerId: customer.id, origins: createPlateOriginStore(db) };
}

describeWithDatabase("vehicle plateSourcedKeys HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("returns an empty plateSourcedKeys list for a vehicle with no origin writes", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, customerId } = await seedCustomer(tx);

      const created = await app.inject({
        method: "POST",
        url: `/customers/${customerId}/vehicles`,
        payload: { plate: "ABC1D23", make: "VW" },
      });

      expect(created.statusCode).toBe(201);
      expect(vehicleSchema.parse(created.json()).plateSourcedKeys).toEqual([]);
      await app.close();
    }));

  it("marks listed create keys PLACA and ignores a listed key that was not written", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, customerId, origins } = await seedCustomer(tx);

      const created = await app.inject({
        method: "POST",
        url: `/customers/${customerId}/vehicles`,
        payload: { make: "VW", model: "Gol", plateSourcedKeys: ["make", "year"] },
      });

      expect(created.statusCode).toBe(201);
      const body = vehicleSchema.parse(created.json());
      // `year` was listed as plate-sourced but never sent, so it is neither set
      // nor marked: a mark is a statement about a value that was written.
      expect(body.plateSourcedKeys).toEqual(["make"]);
      expect(body.make).toBe("VW");
      expect(body.year).toBeNull();

      // The stored mark agrees — read through the plate-origin store, which is
      // what `GET /customers/:id/vehicles` builds `plateSourcedKeys` from (that
      // route is another slice's; see NOT MECHANICAL above).
      expect(await origins.listPlateSourcedKeys(body.id)).toEqual(["make"]);
      await app.close();
    }));
});
