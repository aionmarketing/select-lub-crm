/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `POST /customers/:id/vehicles` case, assertions unchanged. The full design of
 * the old suite — its fake-only notes, the other cases and where each went —
 * is in update-vehicle/tests/update-vehicle.vehicles.integration.test.ts. The
 * old suite's other POST case, the foreign-unit 403, is the auth hook's and
 * stayed in `apps/api`.
 *
 * SUT: `POST /customers/:id/vehicles` (the `create-customer-vehicle` slice) and
 *   the cadastro store behind it.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. The setup still builds a `createFakeOmie`, as the
 *   old suite's seed did, but this route never reaches Omie and takes no adapter.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md and
 * specs/customer-vehicles HTTP.
 *
 * Outputs: O1 201; O4 the row the route wrote
 *
 * Sampled-cell
 *   POST second vehicle 201            | create   | still one row
 *
 * Decision map (create-customer-vehicle/index.ts)
 *   D1 customer/unit missing      F the create it; T not reached here — the old
 *     suite had no create-404 case (its foreign-unit POST was the hook's 403)
 *   `if (!unitId)` — contract-hidden: in production the auth hook answers first
 *
 * Out of scope: plateSourcedKeys marks (create-customer-vehicle.origin).
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
import { vehicleSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/** The Omie characteristic the plate travels in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";

/**
 * Seeds a unit, its WhatsApp connection, the attendant, a linked customer and
 * its titular vehicle, builds the Omie fake, and mounts the
 * slice on the test transaction.
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
  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    caracteristicas: [{ campo: PLATE_CAMPO, conteudo: "TITULAR1" }],
  });
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
    plugin: (a) => registerSlice(a, "customers", "create-customer-vehicle", route),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, customerId: customer.id, vehOld: vehOld.id, cadastro: createCadastroStore(db) };
}

describeWithDatabase("customer-scoped vehicle HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("creates a second vehicle with origin crm", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);

      const response = await ctx.app.inject({
        method: "POST",
        url: `/customers/${ctx.customerId}/vehicles`,
        payload: { plate: "ABC1D23" },
      });

      expect(response.statusCode).toBe(201);
      const created = vehicleSchema.parse(response.json());
      expect(created.plate).toBe("ABC1D23");
      expect(created.origin).toBe("crm");
      expect(created.id).not.toBe(ctx.vehOld);
      expect(await ctx.cadastro.listVehicles(ctx.customerId)).toHaveLength(2);
      await ctx.app.close();
    }));
});
