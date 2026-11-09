/**
 * Test design (testing-strategy) — prefill / accept-all-prefill,
 * `POST /conversations/:id/prefill/accept-all`
 *
 * Moved from `apps/api/src/cadastro.prefill.test.ts`, its seven accept-all
 * cases, assertions unchanged.
 *
 * Setup: the route is mounted alone through `buildSliceApp`, over
 * `createRoute({ omieAdapter })` with `createFakeOmie()`. Each field is written
 * by `customers`' `applyPrefillSuggestion`, for real, on the test transaction.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   1. A suggestion row needs the job that produced it, so the fixture creates a
 *      succeeded job first.
 *   2. Every id asserted on is a real row's, read back from the seed.
 *   4. "No WhatsApp message was sent" reads `outbox_message` scoped to the
 *      conversation. Nothing on this route can enqueue — the slice app mounts no
 *      conversations route and no channel — so the count is a regression guard
 *      against accept-all ever growing a send, not a probe of a live channel.
 *
 * Oracle: assistive-cadastro-prefill design.md D6 — accept-all is Aceitar clicked
 *   top to bottom, in the closed v1 order; the first refusal stops the walk.
 *
 * Axes: A1 omieId null / set; A5 customer resolve — linked / create on first accept;
 *   pending — keys / none; a later field's persist — ok / not_found
 *
 * Sampled-cell
 *   linked, name + plate        | 200 both written, suggestion empty, 0 outbox | a field left
 *   unlinked, name + model      | 200 one customer created, vehicle model      | two customers
 *   no pending                  | 200 empty, customer untouched                | a write
 *   no vehicle, name + plate    | 404, name kept, plate still pending           | name rolled back
 *   omieId null                 | put 0                                         | put > 0
 *   omieId set, name + year     | put > 0, name and year written                | put 0
 *   unknown conversation        | 404                                           | 200
 *
 * Decision map: D1 conversation missing; D3 customer resolved — T linked, F create;
 *   D4 omieId set; D11 persist not_found stops the walk.
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { prefillSuggestionSchema } from "../../contracts/http.js";
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
} from "@select-lub/core/testing";
import { createRoute } from "../index.js";

/** The chat key every conversation here is reachable at; the customer's phone. */
const PHONE = "11988887777";

const db = () => prisma as PrismaClient;

/**
 * A conversation, linked to a customer unless `customerId: null` (Omie-linked
 * when `omieId` is set, with a titular vehicle unless `seedVehicle` is false), a
 * suggestion behind a succeeded job, and an attendant of the unit.
 */
async function seedPrefill(
  tx: DbClient,
  options?: {
    omieId?: string;
    customerId?: null;
    seedVehicle?: boolean;
    suggestion?: Record<string, string | number>;
  },
) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  const fake = createFakeOmie();
  const omieId = options?.omieId ?? null;
  let customerId: string | null = null;
  let vehicleId: string | null = null;
  if (options?.customerId !== null) {
    const customer = await tx.customer.create({
      data: { name: omieId ? "Ana" : PHONE, omieId, unitId: unit.id, origin: "whatsapp", status: "active" },
      select: { id: true },
    });
    customerId = customer.id;
    if (options?.seedVehicle !== false) {
      const vehicle = await tx.vehicle.create({
        data: { customerId: customer.id, plate: null, origin: "whatsapp" },
        select: { id: true },
      });
      vehicleId = vehicle.id;
    }
    if (omieId) {
      fake.seed(omieId, { ...emptySnapshot(), razao_social: "Ana" });
    }
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
  const user = await seedUser(tx, { units: [unit.id] });
  return { unitId: unit.id, userId: user.id, conversationId: conversation.id, customerId, vehicleId, fake };
}

async function acceptAll(tx: DbClient, s: Awaited<ReturnType<typeof seedPrefill>>, conversationId: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "prefill", "accept-all-prefill", createRoute({ omieAdapter: s.fake })),
    caller: { unitId: s.unitId, userId: s.userId },
  });
  try {
    return await app.inject({ method: "POST", url: `/conversations/${conversationId}/prefill/accept-all` });
  } finally {
    await app.close();
  }
}

/** The stored suggestion fields, or undefined when no row exists. */
async function suggestionFields(tx: DbClient, conversationId: string) {
  const row = await tx.cadastroPrefillSuggestion.findUnique({ where: { conversationId }, select: { fields: true } });
  return row ? (row.fields as Record<string, unknown>) : undefined;
}

describeWithDatabase("POST /conversations/:id/prefill/accept-all", () => {
  it("accept-all persists every pending field and empties the suggestion", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { name: "Ana Souza", plate: "ABC1D23" } });

      const response = await acceptAll(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).fields).toBeUndefined();
      expect((await tx.customer.findUniqueOrThrow({ where: { id: s.customerId! } })).name).toBe("Ana Souza");
      expect((await tx.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId! } })).plate).toBe("ABC1D23");
      expect(await tx.outboxMessage.count({ where: { conversationId: s.conversationId } })).toBe(0);
    }));

  it("accept-all on an unlinked conversation creates local cadastro once", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { customerId: null, suggestion: { name: "Ana Souza", model: "Civic" } });

      const response = await acceptAll(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).fields).toBeUndefined();
      // Scoped to this unit: listUnlinkedMatchCandidates is database-wide.
      const created = await tx.customer.findMany({ where: { unitId: s.unitId, omieId: null } });
      expect(created).toHaveLength(1);
      expect(created[0]?.name).toBe("Ana Souza");
      const vehicle = await tx.vehicle.findFirstOrThrow({ where: { customerId: created[0]!.id } });
      expect(vehicle.model).toBe("Civic");
    }));

  it("accept-all with no pending suggestion is a no-op", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx);

      const response = await acceptAll(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).status).toBe("empty");
      expect((await tx.customer.findUniqueOrThrow({ where: { id: s.customerId! } })).name).toBe(PHONE);
      expect(await tx.outboxMessage.count({ where: { conversationId: s.conversationId } })).toBe(0);
    }));

  it("accept-all keeps earlier fields when a later persist fails", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { name: "Ana Souza", plate: "ABC1D23" }, seedVehicle: false });

      const response = await acceptAll(tx, s, s.conversationId);

      expect(response.statusCode).toBe(404);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: s.customerId! } })).name).toBe("Ana Souza");
      const fields = await suggestionFields(tx, s.conversationId);
      expect(fields?.plate).toBe("ABC1D23");
      expect(fields?.name).toBeUndefined();
    }));

  it("accept-all does not write Omie when the customer has no omieId", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { name: "Ana Souza", plate: "ABC1D23" } });

      const response = await acceptAll(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(s.fake.putCount()).toBe(0);
      expect(await tx.outboxMessage.count({ where: { conversationId: s.conversationId } })).toBe(0);
    }));

  it("accept-all sends shared fields through applyCrmEdit when omieId is set", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { omieId: "omie-prefill", suggestion: { name: "Ana Souza", year: 2020 } });

      const response = await acceptAll(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(s.fake.putCount()).toBeGreaterThan(0);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: s.customerId! } })).name).toBe("Ana Souza");
      expect((await tx.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId! } })).year).toBe(2020);
    }));

  it("returns 404 for accept-all on an unknown conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx);

      const response = await acceptAll(tx, s, "missing");

      expect(response.statusCode).toBe(404);
    }));
});
