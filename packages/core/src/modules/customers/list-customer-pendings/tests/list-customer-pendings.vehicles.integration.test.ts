/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `GET /customers/:id/reconciliation-pendings` case — vehicle pendings narrow to
 * the titular — assertions unchanged. The full design of the old suite — its
 * fake-only notes, the other cases and where each went — is in
 * update-vehicle/tests/update-vehicle.vehicles.integration.test.ts.
 *
 * SUT: `GET /customers/:id/reconciliation-pendings` (the
 *   `list-customer-pendings` slice) and the cadastro store's
 *   `listOpenPendings` behind it.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. The pending is opened by `ingestOmieSnapshot` over the
 *   cadastro store and a `createFakeOmie`, as before.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md (pendings list the titular
 * vehicle's rows).
 *
 * Outputs: O1 200; the pending rows
 *
 * Sampled-cell
 *   GET pendings titular only          |          | extra pending invented
 *
 * Out of scope: resolving the pending (resolve-pending).
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { ingestOmieSnapshot } from "../../contracts/cadastro-engine/index.js";
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
 * a titular and an extra vehicle, builds the Omie fake, and
 * mounts the slice on the test transaction.
 *
 * @param tx - The test transaction.
 * @returns The app, the ids, the Omie fake, and the cadastro store.
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
  await tx.vehicle.create({
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
  // In step with Omie: local and external both at 1 and both reconciled.
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
    plugin: (a) => registerSlice(a, "customers", "list-customer-pendings", route),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, customerId: customer.id, vehOld: vehOld.id, fake, cadastro: createCadastroStore(db) };
}

describeWithDatabase("customer-scoped vehicle HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("GET pendings returns titular vehicle rows only", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);
      // CRM moved the titular's plate without pushing it...
      const vehicle = (await ctx.cadastro.getVehicle(ctx.vehOld))!;
      vehicle.plate = "CRMPLATE";
      await ctx.cadastro.saveVehicle(vehicle);
      await tx.vehicleFieldSync.update({
        where: { vehicleId_fieldKey: { vehicleId: ctx.vehOld, fieldKey: "plate" } },
        data: { localVersion: 2 },
      });
      // ...and Omie moved it the other way, so the ingest has to open a pending.
      ctx.fake.seed("omie-veh-1", {
        ...emptySnapshot(),
        razao_social: "Ana",
        caracteristicas: [{ campo: PLATE_CAMPO, conteudo: "OMIEPLATE" }],
      });
      await ingestOmieSnapshot(ctx.cadastro, ctx.fake, ctx.customerId);

      const listed = await ctx.app.inject({
        method: "GET",
        url: `/customers/${ctx.customerId}/reconciliation-pendings`,
      });

      expect(listed.statusCode).toBe(200);
      const rows = listed.json() as { vehicleId: string | null }[];
      // The extra car has no pending of its own, and `listOpenPendings` narrows
      // vehicle rows to the titular, so exactly one row comes back.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.vehicleId).toBe(ctx.vehOld);
      await ctx.app.close();
    }));
});
