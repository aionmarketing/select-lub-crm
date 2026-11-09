/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `POST /conversations/:id/vehicles` cases, assertions unchanged. The full design
 * of the old suite — the other cases and where each went — is in
 * update-vehicle/tests/update-vehicle.vehicles.integration.test.ts; fake-only
 * notes 1 and 2 (a conversation reaches its unit only through its connection;
 * the phone is the chat key) are spelled out in
 * list-conversation-vehicles/tests/list-conversation-vehicles.vehicles.integration.test.ts
 * and hold here as well.
 *
 * SUT: `POST /conversations/:id/vehicles` (the `create-conversation-vehicle`
 *   slice): the conversation read through the conversations module's
 *   `getCadastroLink` contract, and the cadastro store.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. The setup still builds a `createFakeOmie`, as the
 *   old suite's seed did, but this route never reaches Omie and takes no adapter.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md Axis 4 and
 * specs/customer-vehicles conversation-scoped routes.
 *
 * Axis 4 conversation POST resolve classes
 *
 * Outputs: O1 201/409; O4 rows the route did or did not write
 *
 * Sampled-cell
 *   POST unresolved 409                | Axis 4   | Cliente created
 *   POST resolved second car           | Axis 4   | still one
 *
 * Decision map (create-conversation-vehicle/index.ts)
 *   D3 customer resolved          T the create it; F POST 409
 *   `if (!unitId)` — contract-hidden: in production the auth hook answers first
 *
 * Out of scope: rail UI; the GET on the same path (list-conversation-vehicles).
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
  seedConversation,
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
 * @returns The app, the unit, the connection, the customer's id, and the cadastro store.
 */
async function seedLinked(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
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
    plugin: (a) => registerSlice(a, "customers", "create-conversation-vehicle", route),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, unit, connection, customerId: customer.id, cadastro: createCadastroStore(db) };
}

describeWithDatabase("conversation-scoped vehicle HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("returns 409 and creates no Cliente when adding without a customer", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);
      const conversation = await seedConversation(tx, {
        connectionId: ctx.connection.id,
        chatKey: "11000000000",
      });
      const customersBefore = await tx.customer.count({ where: { unitId: ctx.unit.id } });

      const response = await ctx.app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/vehicles`,
        payload: { plate: "XYZ9A87" },
      });

      expect(response.statusCode).toBe(409);
      // A delta on the unit created in this transaction, so no other test's
      // customers can mask a row this one wrongly created.
      expect(await tx.customer.count({ where: { unitId: ctx.unit.id } })).toBe(customersBefore);
      expect(await ctx.cadastro.listVehicles(ctx.customerId)).toHaveLength(1);
      await ctx.app.close();
    }));

  it("creates a second vehicle on a resolved conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);
      const conversation = await seedConversation(tx, { connectionId: ctx.connection.id });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: ctx.customerId },
      });

      const response = await ctx.app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/vehicles`,
        payload: { plate: "XYZ9A87" },
      });

      expect(response.statusCode).toBe(201);
      expect(vehicleSchema.parse(response.json()).plate).toBe("XYZ9A87");
      expect(await ctx.cadastro.listVehicles(ctx.customerId)).toHaveLength(2);
      await ctx.app.close();
    }));
});
