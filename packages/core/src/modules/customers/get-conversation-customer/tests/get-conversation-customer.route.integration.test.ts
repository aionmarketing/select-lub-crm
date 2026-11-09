/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/cadastro.test.ts (adopt-modular-vertical-slices 4B);
 *   runs under module_customers.
 *
 * SUT: `GET /conversations/:id/customer` over HTTP — this slice's route, mounted
 *   alone on the kernel app by `buildSliceApp`, over the test's rolling-back
 *   transaction, with the caller stated rather than resolved by apps/api's auth
 *   hook. The Omie adapter is `createFakeOmie`, passed to the route.
 *
 *   Changed with the move: the "pending until resolve" case used to resolve the
 *   pending through a second route, `POST .../reconciliation-pendings/resolve`. A
 *   slice's tests mount only their own route, so it now resolves with the engine's
 *   `resolvePending` — the call that route makes — on the same store and fake.
 *
 *   No test here can reach the live Evolution instance: the slice app builds no
 *   conversations store and no channel probe at all.
 *
 *   The original file's other cases: see `update-customer.route.integration.test.ts`.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync (conversation-customer GET).
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (from the original file)
 *   1. **A conversation belonged to a unit directly.** Every conversation case
 *      used the memory store's `seedConversation({ unitId })`, a flat column
 *      Postgres does not have: `conversation` reaches its unit only through
 *      `whatsapp_connection`. This is the concept PR #89's bug lived in. Every
 *      conversation here hangs off a real connection in the unit.
 *
 * Axes
 *   A4 conversation customer — unresolved / pending then resolved / Omie drift /
 *     failReads degrade / unlinked skip
 *
 * Sampled-cell
 *   conversation unresolved             | A4 null     | customer null | a Cliente
 *   conversation pending until resolve  | A4 then     | 1 then 0 | stays 1
 *   GET shows drifted Omie name         | A4 drift    | Maria Drifted | stored Ana
 *   GET failReads keeps stored name     | A4 fail     | 200 Ana | 503/empty
 *   GET unlinked does not call Omie     | A4 skip     | getCalls 0 | adapter.get
 *
 * Decision / branch map (get-conversation-customer/index.ts)
 *   conversation customer resolved      T pending-until it; F unresolved it
 *   refresh omieId set                  T drift/fail its; F unlinked skip it
 *   refresh ingest throw                T failReads it; F drift it
 *   `if (!unitId)` — contract-hidden: apps/api's hook answers 403/401 first
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { ingestOmieSnapshot, resolvePending } from "../../contracts/cadastro-engine/index.js";
import { conversationCustomerSchema } from "../../contracts/http.js";
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
 * Seeds a unit, its WhatsApp connection, the attendant, and one customer with a
 * vehicle, passes the Omie fake to the route, then mounts this slice.
 *
 * The connection is not scenery: a `conversation` reaches its unit only through
 * `whatsapp_connection`, so without one no conversation can be in the unit.
 *
 * @param tx - The test transaction.
 * @param options - `omieId` (default `"omie-http-1"`; `null` for an unlinked customer).
 * @returns The app, ids, the Omie fake and the cadastro store.
 */
async function seedApp(tx: DbClient, options: { omieId?: string | null } = {}) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const fake = createFakeOmie();
  const omieId = options.omieId === undefined ? "omie-http-1" : options.omieId;

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

  if (omieId) {
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
  }

  const db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "customers", "get-conversation-customer", route({ omieAdapter: fake })),
    caller: { userId: user.id, unitId: unit.id },
  });
  return {
    app,
    unit,
    userId: user.id,
    connection,
    customerId: customer.id,
    fake,
    cadastro: createCadastroStore(db),
  };
}

type Ctx = Awaited<ReturnType<typeof seedApp>>;

/**
 * Drives the customer's postal code into a two-sided conflict: CRM moved it and
 * Omie moved it the other way, so the ingest opens a pending.
 *
 * @param tx - The test transaction.
 * @param ctx - A context from {@link seedApp} with a linked customer.
 */
async function openPostalCodeConflict(tx: DbClient, ctx: Ctx): Promise<void> {
  const customer = (await ctx.cadastro.getCustomer(ctx.customerId))!;
  customer.postalCode = "CRMCEP12";
  await ctx.cadastro.saveCustomer(customer);
  await tx.customerFieldSync.update({
    where: { customerId_fieldKey: { customerId: ctx.customerId, fieldKey: "postalCode" } },
    data: { localVersion: 2 },
  });
  ctx.fake.seed("omie-http-1", { ...(await ctx.fake.get("omie-http-1"))!, cep: "OMIECEP1" });
  await ingestOmieSnapshot(ctx.cadastro, ctx.fake, ctx.customerId);
}

/**
 * A conversation in the unit, linked to the seeded customer.
 *
 * @param tx - The test transaction.
 * @param ctx - A context from {@link seedApp}.
 * @returns The conversation.
 */
async function linkedConversation(tx: DbClient, ctx: Ctx) {
  const conversation = await seedConversation(tx, { connectionId: ctx.connection.id });
  await tx.conversation.update({
    where: { id: conversation.id },
    data: { customerId: ctx.customerId },
  });
  return conversation;
}

describeWithDatabase("GET /conversations/:id/customer", () => {
  const db = () => prisma as PrismaClient;

  it("returns a null customer for an unresolved conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      const conversation = await seedConversation(tx, {
        connectionId: ctx.connection.id,
        chatKey: "11000000000",
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/customer`,
      });

      expect(response.statusCode).toBe(200);
      expect(conversationCustomerSchema.parse(response.json())).toEqual({
        customer: null,
        pendings: [],
      });
      await ctx.app.close();
    }));

  it("returns the drifted Omie name on conversation customer GET", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      const conversation = await linkedConversation(tx, ctx);
      ctx.fake.seed("omie-http-1", {
        ...(await ctx.fake.get("omie-http-1"))!,
        razao_social: "Maria Drifted",
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/customer`,
      });

      expect(response.statusCode).toBe(200);
      expect(conversationCustomerSchema.parse(response.json()).customer?.name).toBe(
        "Maria Drifted",
      );
      await ctx.app.close();
    }));

  it("returns the stored customer when Omie reads fail on conversation customer GET", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      const conversation = await linkedConversation(tx, ctx);
      ctx.fake.failReads();

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/customer`,
      });

      expect(response.statusCode).toBe(200);
      const parsed = conversationCustomerSchema.parse(response.json());
      expect(parsed.customer?.name).toBe("Ana");
      expect(parsed.customer?.id).toBe(ctx.customerId);
      await ctx.app.close();
    }));

  it("does not call Omie when the conversation customer has no omieId", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx, { omieId: null });
      const conversation = await linkedConversation(tx, ctx);
      let getCalls = 0;
      const originalGet = ctx.fake.get.bind(ctx.fake);
      ctx.fake.get = async (omieId) => {
        getCalls += 1;
        return originalGet(omieId);
      };

      const response = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/customer`,
      });

      expect(response.statusCode).toBe(200);
      expect(conversationCustomerSchema.parse(response.json()).customer?.name).toBe("Ana");
      expect(getCalls).toBe(0);
      await ctx.app.close();
    }));

  it("includes an open pending on conversation customer GET until resolve", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedApp(tx);
      const conversation = await linkedConversation(tx, ctx);
      await openPostalCodeConflict(tx, ctx);

      const before = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/customer`,
      });
      expect(before.statusCode).toBe(200);
      const parsed = conversationCustomerSchema.parse(before.json());
      expect(parsed.customer?.id).toBe(ctx.customerId);
      expect(parsed.pendings).toHaveLength(1);

      // Was `POST /customers/:id/reconciliation-pendings/resolve` with choice omie;
      // that route's own call, on the same store and fake.
      await resolvePending(ctx.cadastro, ctx.fake, {
        customerId: ctx.customerId,
        unitId: ctx.unit.id,
        fieldKey: "postalCode",
        vehicleId: null,
        choice: "omie",
        actorId: ctx.userId,
      });

      const after = await ctx.app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/customer`,
      });
      expect(conversationCustomerSchema.parse(after.json()).pendings).toEqual([]);
      await ctx.app.close();
    }));
});
