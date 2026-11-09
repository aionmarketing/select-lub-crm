/**
 * Test design (testing-strategy) — prefill at the composition root
 *
 * WHY THIS FILE IS IN apps/api AND NOT IN A SLICE
 *   Each case here drives two routes, or a route prefill does not own: the first
 *   accept is read back through `GET /conversations/:id/vehicles`; the unlinked
 *   shared-field edit is `customers`' `PATCH /customers/:id`; the switch cases
 *   read the switch back through `GET /conversations/:id/prefill`. A slice's
 *   tests mount that slice's route alone, so these run through the real
 *   `buildApp`, behind the real auth hook, one file per module (W2-C9).
 *
 * Moved from `apps/api/src/cadastro.prefill.test.ts`, four cases, assertions
 *   unchanged: "creates a customer and titular vehicle on the first accept",
 *   "persists PATCH /customers/:id for unlinked shared fields without Omie",
 *   "turns the extraction switch on and stamps the watermark", "turns the
 *   extraction switch back off". Its other 27 cases moved to the six route
 *   slices. It had no hook case.
 *
 * Setup: Fastify inject against the real app on one rolling-back transaction
 *   per test. Omie is the injected `clients.omie.createFakeOmie()`; the channel probe is
 *   pinned CONNECTED through `buildApp`'s `channelConnected` port, so nothing
 *   here reaches Evolution; `getUser` is the fake.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   2. The customer id in the `PATCH /customers/:id` URL is a real row's, read
 *      back from the seed, never a literal.
 *
 * Oracle: assistive-cadastro-prefill design.md Axis 4 + D6; prefill-switch —
 *   turning the switch on stamps the watermark, so silence already past is not
 *   extracted.
 *
 * Sampled-cell
 *   first accept creates  | A5 create | customerId + model, name null, phone copied | phone copied into name
 *   PATCH unlinked shared |           | 200 persisted, put 0                         | 409
 *   PATCH on then GET     | A6 on     | 200 true + watermark; GET true               | stays false
 *   PATCH off then GET    | A6 off    | 200 false; GET false                         | stays true
 *
 * Out of scope: each route's own answers (the slices' tests).
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { clients } from "@select-lub/core";
import { prefillSuggestionSchema } from "@select-lub/shared-types";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

/** The chat key every conversation here is reachable at; the customer's phone. */
const PHONE = "11988887777";

const db = () => prisma as PrismaClient;

function auth(unitId: string) {
  return { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
}

function jsonAuth(unitId: string) {
  return { ...auth(unitId), "content-type": "application/json" };
}

/**
 * A conversation in its own unit, linked to a customer with a titular vehicle
 * unless `customerId: null`, an optional suggestion behind a succeeded job, the
 * caller's membership, and the app on the transaction.
 */
async function seedPrefill(
  tx: DbClient,
  options?: { customerId?: null; suggestion?: Record<string, string | number> },
) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  const fake = clients.omie.createFakeOmie();
  let customerId: string | null = null;
  if (options?.customerId !== null) {
    const customer = await tx.customer.create({
      data: { name: PHONE, omieId: null, unitId: unit.id, origin: "whatsapp", status: "active" },
      select: { id: true },
    });
    customerId = customer.id;
    await tx.vehicle.create({ data: { customerId: customer.id, plate: null, origin: "whatsapp" } });
    await tx.conversation.update({ where: { id: conversation.id }, data: { customerId } });
  }
  if (options?.suggestion) {
    const job = await tx.cadastroPrefillJob.create({
      data: { conversationId: conversation.id, status: "succeeded" },
      select: { id: true },
    });
    await tx.cadastroPrefillSuggestion.create({
      data: { conversationId: conversation.id, fields: options.suggestion, jobId: job.id, extractedAt: new Date() },
    });
  }
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
  const app = await buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
    omieAdapter: fake,
    channelConnected: async () => true,
  });
  return { app, unitId: unit.id, conversationId: conversation.id, customerId, fake };
}

describeWithDatabase("prefill through the real app", () => {
  it("creates a customer and titular vehicle on the first accept", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, unitId, conversationId } = await seedPrefill(tx, {
        customerId: null,
        suggestion: { model: "Civic" },
      });

      const response = await app.inject({
        method: "POST",
        url: `/conversations/${conversationId}/prefill/accept`,
        headers: jsonAuth(unitId),
        payload: { field: "model", value: "Civic" },
      });

      expect(response.statusCode).toBe(200);
      const vehicles = await app.inject({
        method: "GET",
        url: `/conversations/${conversationId}/vehicles`,
        headers: auth(unitId),
      });
      expect(vehicles.statusCode).toBe(200);
      const body = vehicles.json() as {
        customerId: string | null;
        vehicles: { model: string | null }[];
      };
      expect(body.customerId).toBeTruthy();
      expect(body.vehicles[0]?.model).toBe("Civic");
      const created = await tx.customer.findUniqueOrThrow({
        where: { id: body.customerId! },
        include: { phones: true },
      });
      expect(created.origin).toBe("whatsapp");
      expect(created.name).toBeNull();
      expect(created.phones.find((row) => row.isPrimary)?.normalized).toBe(PHONE);
      const storedVehicle = await tx.vehicle.findFirstOrThrow({
        where: { customerId: body.customerId! },
      });
      expect(storedVehicle.origin).toBe("whatsapp");
      expect(storedVehicle.model).toBe("Civic");
    }));

  it("persists PATCH /customers/:id for unlinked shared fields without Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, unitId, customerId, fake } = await seedPrefill(tx);

      const response = await app.inject({
        method: "PATCH",
        url: `/customers/${customerId}`,
        headers: jsonAuth(unitId),
        payload: { name: "Maria" },
      });

      expect(response.statusCode).toBe(200);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: customerId! } })).name).toBe("Maria");
      expect(fake.putCount()).toBe(0);
    }));

  it("turns the extraction switch on and stamps the watermark", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, unitId, conversationId } = await seedPrefill(tx);
      expect(
        (await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } })).lastPrefillWindowClosedAt,
      ).toBeNull();

      const patched = await app.inject({
        method: "PATCH",
        url: `/conversations/${conversationId}/prefill/extract-enabled`,
        headers: jsonAuth(unitId),
        payload: { extractEnabled: true },
      });

      expect(patched.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(patched.json()).extractEnabled).toBe(true);
      expect(
        (await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } })).lastPrefillWindowClosedAt,
      ).toBeInstanceOf(Date);

      const got = await app.inject({
        method: "GET",
        url: `/conversations/${conversationId}/prefill`,
        headers: auth(unitId),
      });
      expect(prefillSuggestionSchema.parse(got.json()).extractEnabled).toBe(true);
    }));

  it("turns the extraction switch back off", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, unitId, conversationId } = await seedPrefill(tx);
      await tx.conversation.update({
        where: { id: conversationId },
        data: { prefillExtractEnabled: true },
      });

      const patched = await app.inject({
        method: "PATCH",
        url: `/conversations/${conversationId}/prefill/extract-enabled`,
        headers: jsonAuth(unitId),
        payload: { extractEnabled: false },
      });

      expect(patched.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(patched.json()).extractEnabled).toBe(false);

      const got = await app.inject({
        method: "GET",
        url: `/conversations/${conversationId}/prefill`,
        headers: auth(unitId),
      });
      expect(prefillSuggestionSchema.parse(got.json()).extractEnabled).toBe(false);
    }));
});
