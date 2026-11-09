/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/cadastro.test.ts (adopt-modular-vertical-slices 4B);
 *   runs under module_customers.
 *
 * SUT: `POST /conversations/:id/customer` over HTTP — this slice's route, mounted
 *   alone on the kernel app by `buildSliceApp`, over the test's rolling-back
 *   transaction, with the caller stated rather than resolved by apps/api's auth
 *   hook. The Omie adapter is `createFakeOmie`, passed to the route.
 *
 *   No test here can reach the live Evolution instance: the slice app builds no
 *   conversations store and no channel probe at all.
 *
 *   The original file's other cases: see `update-customer.route.integration.test.ts`.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync (conversation-customer POST).
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (from the original file)
 *   1. **A conversation belonged to a unit directly.** The memory store's
 *      `seedConversation({ unitId })` was a flat column Postgres does not have:
 *      `conversation` reaches its unit only through `whatsapp_connection`, and
 *      `getCadastroLink` filters on `whatsappConnection: { unitId }`. This is the
 *      concept PR #89's bug lived in. Every conversation here hangs off a real
 *      connection in the unit.
 *   2. **The phone a conversation resolves by is its `chatKey`.** The fake carried
 *      a separate `phone` field; the link returns `chatKey` as the phone and it is
 *      matched against `customer_phone.normalized`. The create-and-link case
 *      depends on the customer having NO phone row matching that chat key, which
 *      is a fact about two tables rather than about one Map.
 *
 * Axes
 *   A4 conversation customer — none yet / already linked
 *
 * Sampled-cell
 *   POST creates and links a Cliente    | A4          | 201 + link set | 409
 *   POST already linked                 | A4          | 409 | a second Cliente
 *
 * Decision / branch map (link-conversation-customer/index.ts)
 *   linked customer in the unit         T already-linked it; F creates it
 *   `if (!unitId)` — contract-hidden: apps/api's hook answers 403/401 first
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { customerSchema } from "../../contracts/http.js";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
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
import { route } from "../index.js";

/** The Omie characteristic the plate travels in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";
/** The customer's stored postal code, in step with Omie at the start of every case. */
const CEP = "01310100";

/**
 * Seeds a unit, its WhatsApp connection, the attendant, and one linked customer
 * with a vehicle, passes the Omie fake to the route, then mounts this slice.
 *
 * The connection is not scenery: a `conversation` reaches its unit only through
 * `whatsapp_connection`, so without one no conversation can be in the unit.
 *
 * @param tx - The test transaction.
 * @returns The app, ids, the connection and the cadastro store.
 */
async function seedApp(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const fake = createFakeOmie();
  const omieId = "omie-http-1";

  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      omieId,
      unitId: unit.id,
      postalCode: CEP,
      origin: "manual",
      status: "active",
    },
    select: { id: true },
  });
  await tx.vehicle.create({
    data: { customerId: customer.id, plate: "ABC1D23", origin: "manual" },
  });

  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    cep: CEP,
    caracteristicas: [{ campo: PLATE_CAMPO, conteudo: "ABC1D23" }],
  });
  // Both fields in step with Omie, so the first CRM edit is a clean push.
  await tx.customerFieldSync.createMany({
    data: (
      [
        ["name", "Ana"],
        ["postalCode", CEP],
      ] as const
    ).map(([fieldKey, wire]) => ({
      customerId: customer.id,
      fieldKey,
      origin: "CRM",
      localVersion: 1,
      externalVersion: 1,
      syncedLocalVersion: 1,
      syncedExternalVersion: 1,
      lastOmieWire: wire,
    })),
  });

  const db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "customers", "link-conversation-customer", route({ omieAdapter: fake })),
    caller: { userId: user.id, unitId: unit.id },
  });
  return {
    app,
    connection,
    customerId: customer.id,
    cadastro: createCadastroStore(db),
    jsonHeaders: { "content-type": "application/json" },
  };
}

describeWithDatabase("POST /conversations/:id/customer", () => {
  const db = () => prisma as PrismaClient;

  it("creates and links a customer when POST conversation customer has none yet", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      // A chat key no customer_phone row carries, so the route cannot resolve
      // by phone and must create. The seeded customer has no phone rows at all.
      const conversation = await seedConversation(tx, {
        connectionId: ctx.connection.id,
        chatKey: "11977772222",
      });

      const response = await ctx.app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/customer`,
        headers: ctx.jsonHeaders,
        payload: { name: "Ana Nova" },
      });

      expect(response.statusCode).toBe(201);
      const created = customerSchema.parse(response.json());
      expect(created.name).toBe("Ana Nova");
      expect(created.id).not.toBe(ctx.customerId);
      const linked = await tx.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        select: { customerId: true },
      });
      expect(linked.customerId).toBe(created.id);
      expect((await ctx.cadastro.getCustomer(created.id))?.name).toBe("Ana Nova");
      await ctx.app.close();
    }));

  it("returns 409 when POST conversation customer is already linked", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      const conversation = await seedConversation(tx, { connectionId: ctx.connection.id });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: ctx.customerId },
      });

      const response = await ctx.app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/customer`,
        headers: ctx.jsonHeaders,
        payload: { name: "Outro" },
      });

      expect(response.statusCode).toBe(409);
      await ctx.app.close();
    }));
});
