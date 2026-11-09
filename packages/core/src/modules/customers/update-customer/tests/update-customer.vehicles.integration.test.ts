/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `PATCH /customers/:id` case — a customer-level plate edit reaches the titular
 * only — assertions unchanged. The full design of the old suite — its fake-only
 * notes, the other cases and where each went — is in
 * update-vehicle/tests/update-vehicle.vehicles.integration.test.ts.
 *
 * SUT: `PATCH /customers/:id` (the `update-customer` slice) with a `plate` in
 *   the body, on a customer with two vehicles, and the cadastro store behind it.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. Omie stays a `createFakeOmie`, passed to the route.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md (omie-sync: the customer's
 * plate is the titular vehicle's).
 *
 * Outputs: O1 200; O3 titular vs extra plates
 *
 * Sampled-cell
 *   PATCH customer plate titular only  | omie-sync| extra plate flips
 *
 * Out of scope: the rest of `applyCrmEdit` (update-customer.engine and
 *   update-customer.field-sync).
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";
import { route } from "../index.js";

/** The Omie characteristic the plate travels in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";

/**
 * Seeds a unit, its WhatsApp connection, the attendant, a linked customer with
 * a titular and an extra vehicle, passes the Omie fake to the route, and
 * mounts the slice on the test transaction.
 *
 * @param tx - The test transaction.
 * @returns The app, the ids, and the cadastro store.
 */
async function seedLinked(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  await seedConnection(tx, { unitId: unit.id });
  const fake = createFakeOmie();
  const omieId = "omie-veh-1";

  const customer = await tx.customer.create({
    data: { name: "Ana", omieId, unitId: unit.id, origin: "manual", status: "active" },
    select: { id: true },
  });
  const vehOld = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      plate: "TITULAR1",
      origin: "omie",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  const vehNew = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      plate: "EXTRA001",
      origin: "omie",
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    },
    select: { id: true },
  });

  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    caracteristicas: [{ campo: PLATE_CAMPO, conteudo: "TITULAR1" }],
  });
  // In step with Omie: local and external both at 1 and both reconciled, so
  // the next CRM edit is a clean "CRM ahead" push rather than a conflict.
  await tx.vehicleFieldSync.create({
    data: {
      vehicleId: vehOld.id,
      fieldKey: "plate",
      origin: "CRM",
      localVersion: 1,
      externalVersion: 1,
      syncedLocalVersion: 1,
      syncedExternalVersion: 1,
      lastOmieWire: "TITULAR1",
    },
  });

  const db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "customers", "update-customer", route({ omieAdapter: fake })),
    caller: { userId: user.id, unitId: unit.id },
  });
  return {
    app,
    customerId: customer.id,
    vehOld: vehOld.id,
    vehNew: vehNew.id,
    cadastro: createCadastroStore(db),
  };
}

describeWithDatabase("customer-scoped vehicle HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("PATCH /customers/:id plate updates the titular only", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/customers/${ctx.customerId}`,
        payload: { plate: "ONLYTITL" },
      });

      expect(response.statusCode).toBe(200);
      expect((await ctx.cadastro.getVehicle(ctx.vehOld))?.plate).toBe("ONLYTITL");
      expect((await ctx.cadastro.getVehicle(ctx.vehNew))?.plate).toBe("EXTRA001");
      await ctx.app.close();
    }));
});
