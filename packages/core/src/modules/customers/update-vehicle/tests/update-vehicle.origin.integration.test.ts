/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles-origin.test.ts` (adopt-modular-
 * vertical-slices 4B); runs under module_customers. This file keeps that suite's
 * two `PATCH /vehicles/:id` cases, assertions unchanged except as noted below.
 * The two `POST /customers/:id/vehicles` cases went to
 * create-customer-vehicle/tests/create-customer-vehicle.origin.integration.test.ts.
 *
 * NOT MECHANICAL: both cases created their vehicle through
 *   `POST /customers/:id/vehicles`, which is the `create-customer-vehicle`
 *   slice's route. A slice's tests mount only their own slice, so the vehicle is
 *   now created with the same writes that POST makes — the row through the
 *   cadastro store, then one plate-origin write per identity key in the body,
 *   `PLACA` for the listed ones — and the typed-patch case's precondition, which
 *   read the POST response's `plateSourcedKeys`, reads the same list through the
 *   plate-origin store the response is built from.
 *
 * SUT: the `plateSourcedKeys` round trip on `PATCH /vehicles/:id` (the
 *   `update-vehicle` slice), `originWritesFromVehicleBody`, and the cadastro and
 *   plate-origin stores.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. Omie is a `createFakeOmie`, passed to the route.
 *
 * Oracle: add-plate-lookup plate-lookup spec — a typed field is not marked; an
 * omitted patch key leaves its mark; odometerKm is never marked.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (required by route-tests-on-real-database)
 *   1. **The two stores are one table.** `buildMemoryApp` gave this suite a
 *      memory `CadastroStore` and a SEPARATE memory `VehiclePlateOriginStore`,
 *      with a comment conceding they had to be kept in RAM together because "a
 *      memory cadastro vehicle has no Postgres row, so Prisma origin writes
 *      would 500". On Postgres there is no pair: both ports read and write the
 *      same `vehicle_field_sync` row, keyed `(vehicle_id, field_key)`. The
 *      typed-patch case is therefore a genuinely different scenario here — the
 *      patch reaches the row TWICE, once through the sync port's `bumpLocal`
 *      (which `applyCrmEdit` calls for every shared key, linked to Omie or not)
 *      and once through `writeFieldOrigin`. Both set origin CRM, so the mark
 *      clears; the `localVersion` that ends up on the row is the assertion the
 *      fake could not make, and it is pinned below.
 *   2. **`cus-origin` was a Map key.** `vehicle.customer_id` and
 *      `customer.unit_id` are FKs, so the customer and its unit are real rows
 *      and the vehicle id is whatever Postgres assigned, not a literal.
 *   (Note 3, the list's order, concerns the create file.)
 *
 * Axes
 *   A1 write path — PATCH
 *   A2 plateSourcedKeys — listed make / omitted
 *   A3 patched key — a shared identity field / odometerKm only
 *
 * Outputs: O1 200 `vehicleSchema.plateSourcedKeys`;
 *   O3 the `vehicle_field_sync` row both ports share
 *
 * Sampled-cell
 *   PATCH typed model                   | A1 patch A3 shared  | ["make"] | still PLACA on model
 *   PATCH odometer only                 | A1 patch A3 odo     | ["make"] still | cleared
 *
 * Decision map (update-vehicle/index.ts + originWritesFromVehicleBody)
 *   hasOwn identity key  T: the typed-patch it; F: the odometer it
 *   sourced listed       F: the typed-patch it
 *   `!keys.includes(fieldKey)` in the origin adapter
 *     T: the odometer it reaches it — the origin port drops both the write and
 *        the read, while the SYNC port still creates the row (see the corrected
 *        assertion below)
 *     F: every other write
 *
 * CORRECTED DURING MIGRATION, per the change's standard that a test failing on
 *   the real adapter was wrong: the odometer case first asserted that no
 *   `vehicle_field_sync` row exists for `odometerKm`, and Postgres returned one
 *   with `origin: "CRM"`. Not a defect, and the two halves are both right.
 *   `applyCrmEdit` bumps the local version of EVERY shared key, and the
 *   odometer is shared with Omie, so the row must exist; the origin adapter's
 *   `keys` list excludes it because a plate lookup never returns an odometer,
 *   so it can never be marked. The assertion now states that pair outright,
 *   which is a stronger claim than the absence it replaced.
 *
 * Out of scope: Conversas UI; provider HTTP (no test here reaches a provider).
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie } from "../../../../kernel/clients/erp-mock.js";
import type { PlateSourcedFieldKey } from "../../../plate-lookup/contracts/http.js";
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
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";
import { createPlateOriginStore } from "../../contracts/cadastro-store/plate-origin.js";
import { vehicleSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/**
 * Creates the unit, the attendant and one unlinked customer, and mounts the
 * slice on the test transaction.
 *
 * The customer carries no `omieId`, so `decideField` returns before any Omie
 * call: this suite is about origin marks, not synchronisation.
 *
 * @param tx - The test transaction.
 * @returns The app, the customer's id, the caller's id, and both stores.
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
    plugin: (a) => registerSlice(a, "customers", "update-vehicle", route({ omieAdapter: createFakeOmie() })),
    caller: { userId: user.id, unitId: unit.id },
  });
  return {
    app,
    customerId: customer.id,
    userId: user.id,
    cadastro: createCadastroStore(db),
    origins: createPlateOriginStore(db),
  };
}

/**
 * The writes `POST /customers/:id/vehicles` makes for a body carrying `make`
 * (and `model`, when given) with `sourced` listed as plate-sourced: the CRM-origin
 * row, then one origin write per identity key in the body, `PLACA` when listed.
 *
 * @param ctx - From {@link seedCustomer}.
 * @param fields - The identity values the create body carried.
 * @param sourced - The body's `plateSourcedKeys`.
 * @returns The new vehicle's id.
 */
async function createVehicleAsPost(
  ctx: Awaited<ReturnType<typeof seedCustomer>>,
  fields: { make: string; model?: string },
  sourced: readonly PlateSourcedFieldKey[],
): Promise<string> {
  const stamp = new Date().toISOString();
  const id = randomUUID();
  await ctx.cadastro.createVehicle({
    id,
    customerId: ctx.customerId,
    omieId: null,
    plate: null,
    make: fields.make,
    model: fields.model ?? null,
    version: null,
    year: null,
    odometerKm: null,
    origin: "crm",
    createdAt: stamp,
    updatedAt: stamp,
  });
  for (const key of ["make", "model"] as const) {
    if (fields[key] === undefined) continue;
    await ctx.origins.writeFieldOrigin(id, key, sourced.includes(key) ? "PLACA" : "CRM", ctx.userId);
  }
  return id;
}

describeWithDatabase("vehicle plateSourcedKeys HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("clears a mark on a typed patch and leaves an omitted key marked", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedCustomer(tx);
      const { app } = ctx;

      const id = await createVehicleAsPost(ctx, { make: "VW", model: "Gol" }, ["make", "model"]);
      // Precondition: both keys really were marked, so the single-key result
      // below is the patch clearing one and not a create that marked one.
      expect(await ctx.origins.listPlateSourcedKeys(id)).toEqual(["make", "model"]);

      const patched = await app.inject({
        method: "PATCH",
        url: `/vehicles/${id}`,
        payload: { model: "Golf" },
      });

      expect(patched.statusCode).toBe(200);
      expect(vehicleSchema.parse(patched.json()).plateSourcedKeys).toEqual(["make"]);

      // What the fake's two separate stores could not show: the patch reached
      // ONE row twice — `applyCrmEdit`'s `bumpLocal` and then
      // `writeFieldOrigin` — so `model`'s version advanced twice off a create
      // that had already set it once, while `make`, untouched by this patch,
      // stayed where the create left it.
      const rows = await tx.vehicleFieldSync.findMany({
        where: { vehicleId: id, fieldKey: { in: ["make", "model"] } },
        select: { fieldKey: true, origin: true, localVersion: true },
        orderBy: { fieldKey: "asc" },
      });
      expect(rows).toEqual([
        { fieldKey: "make", origin: "PLACA", localVersion: 1 },
        { fieldKey: "model", origin: "CRM", localVersion: 3 },
      ]);
      await app.close();
    }));

  it("does not clear plate-sourced marks when only odometerKm is patched", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedCustomer(tx);
      const { app } = ctx;

      const id = await createVehicleAsPost(ctx, { make: "VW" }, ["make"]);

      const patched = await app.inject({
        method: "PATCH",
        url: `/vehicles/${id}`,
        payload: { odometerKm: 12_000 },
      });

      expect(patched.statusCode).toBe(200);
      expect(vehicleSchema.parse(patched.json()).plateSourcedKeys).toEqual(["make"]);

      // `odometerKm` DOES get a sync row — `applyCrmEdit` bumps every shared
      // key, and the odometer is shared with Omie — but the origin port refuses
      // both to write and to read that key, so the row can never carry a plate
      // mark. Two ports, one table, deliberately different vocabularies. The
      // fake's separate stores made the row's existence unobservable from here.
      const odo = await tx.vehicleFieldSync.findUniqueOrThrow({
        where: { vehicleId_fieldKey: { vehicleId: id, fieldKey: "odometerKm" } },
        select: { origin: true, localVersion: true },
      });
      expect(odo).toEqual({ origin: "CRM", localVersion: 1 });
      await app.close();
    }));
});
