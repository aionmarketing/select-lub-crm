/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `GET /conversations/:id/vehicles` cases, assertions unchanged. The full design
 * of the old suite — the other cases and where each went — is in
 * update-vehicle/tests/update-vehicle.vehicles.integration.test.ts. The old
 * suite's conversation-list shape case (`GET /conversations`) is not a
 * customers route and stayed in `apps/api`.
 *
 * SUT: `GET /conversations/:id/vehicles` (the `list-conversation-vehicles`
 *   slice): the conversation read through the conversations module's
 *   `getCadastroLink` contract, and the cadastro store.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. Omie stays a `createFakeOmie`, passed to the route:
 *   this route refreshes a linked customer from it before listing.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md Axis 4 and
 * specs/customer-vehicles conversation-scoped routes.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (required by route-tests-on-real-database)
 *   1. **A conversation belonged to a unit directly.** Every
 *      conversation-scoped case here called `seedConversation({ unitId })` on
 *      the memory store, which held a flat `unitId` column. Postgres has no
 *      such column: `conversation` is scoped to a unit only through
 *      `whatsapp_connection`, and `getCadastroLink` filters on
 *      `whatsappConnection: { unitId }`. This is precisely the concept PR #89's
 *      bug lived in and which the fake could not represent — the reason this
 *      change exists. Every conversation here now hangs off a real connection
 *      in the unit, so these cases exercise the join for the first time.
 *   2. **The phone-resolution case was resolving against a field the adapter
 *      does not read.** The fake's conversation carried a `phone`; the contract
 *      derives the phone from `chatKey` and matches it against
 *      `customer_phone.normalized` scoped by `customer: { unitId } `. The
 *      seeded chat key and the customer's phone row are now the same value
 *      because the adapter requires it, not because the fake stored two fields
 *      that happened to agree.
 *
 * Axis 4 conversation GET resolve classes
 *
 * Outputs: O1 200/404; the listed customerId and vehicles
 *
 * Sampled-cell
 *   GET conversation customerId        | Axis 4   | missing cars
 *   GET phone match                    | Axis 4   | customerId null
 *   GET unresolved empty               | Axis 4   | 404
 *   GET unknown conversation 404       | Axis 4   | 200
 *   GET other unit's connection 404    | Axis 4   | 200
 *
 * Decision map (list-conversation-vehicles/index.ts)
 *   D2 conversation missing       T the two 404 its; F resolve
 *   D3 customer resolved          T the two list its; F GET empty
 *   `if (!unitId)` — contract-hidden: in production the auth hook answers first
 *
 * Out of scope: rail UI; the POST on the same path (create-conversation-vehicle).
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
import { conversationVehiclesSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/** The Omie characteristic the plate travels in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";

/**
 * Seeds a unit, its WhatsApp connection, the attendant, a customer and its
 * vehicles, passes the Omie fake to the route, and mounts the slice on the
 * test transaction.
 *
 * The connection is not optional scenery: `conversation` reaches its unit only
 * through `whatsapp_connection`, so without one a conversation cannot be in the
 * unit at all.
 *
 * @param tx - The test transaction.
 * @param options - `extra` to add a second, non-titular vehicle.
 * @returns The app, the unit, the connection, and the customer's id.
 */
async function seedLinked(tx: DbClient, options: { extra?: boolean } = {}) {
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
  if (options.extra) {
    await tx.vehicle.create({
      data: {
        customerId: customer.id,
        plate: "EXTRA001",
        origin: "omie",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
      select: { id: true },
    });
  }

  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    caracteristicas: [{ campo: PLATE_CAMPO, conteudo: "TITULAR1" }],
  });
  // In step with Omie: local and external both at 1 and both reconciled, so the
  // refresh this route runs finds nothing to change.
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

  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (a) => registerSlice(a, "customers", "list-conversation-vehicles", route({ omieAdapter: fake })),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, unit, connection, customerId: customer.id };
}

describeWithDatabase("conversation-scoped vehicle HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("lists vehicles when conversation.customerId is set", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx, { extra: true });
      const conversation = await seedConversation(tx, { connectionId: ctx.connection.id });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: ctx.customerId },
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/vehicles`,
      });

      expect(response.statusCode).toBe(200);
      const body = conversationVehiclesSchema.parse(response.json());
      expect(body.customerId).toBe(ctx.customerId);
      expect(body.vehicles).toHaveLength(2);
      await ctx.app.close();
    }));

  it("resolves the customer by phone when customerId is unset", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);
      // The adapter derives the conversation's phone from its chat key, so the
      // two values below have to be the same one — on the fake they were two
      // independent fields that merely agreed.
      const phone = "11988887777";
      await tx.customerPhone.create({
        data: { customerId: ctx.customerId, raw: phone, normalized: phone, isPrimary: true },
      });
      const conversation = await seedConversation(tx, {
        connectionId: ctx.connection.id,
        chatKey: phone,
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/vehicles`,
      });

      expect(response.statusCode).toBe(200);
      const body = conversationVehiclesSchema.parse(response.json());
      expect(body.customerId).toBe(ctx.customerId);
      expect(body.vehicles).toHaveLength(1);
      await ctx.app.close();
    }));

  it("returns an empty list when no customer is resolved", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);
      const conversation = await seedConversation(tx, {
        connectionId: ctx.connection.id,
        chatKey: "11000000000",
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/vehicles`,
      });

      expect(response.statusCode).toBe(200);
      expect(conversationVehiclesSchema.parse(response.json())).toEqual({
        customerId: null,
        vehicles: [],
      });
      await ctx.app.close();
    }));

  it("returns 404 for an unknown conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);

      const response = await ctx.app.inject({
        method: "GET",
        url: "/conversations/missing/vehicles",
      });

      expect(response.statusCode).toBe(404);
      await ctx.app.close();
    }));

  it("returns 404 for a conversation on a connection in another unit", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);
      // The positive control for the join: same shape as the resolved case
      // above, differing only in which unit owns the CONNECTION. On the fake,
      // whose conversation carried a flat unitId, this case could not be built.
      const other = await seedUnit(tx);
      const foreign = await seedConnection(tx, { unitId: other.id });
      const conversation = await seedConversation(tx, { connectionId: foreign.id });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: ctx.customerId },
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/vehicles`,
      });

      expect(response.statusCode).toBe(404);
      await ctx.app.close();
    }));
});
