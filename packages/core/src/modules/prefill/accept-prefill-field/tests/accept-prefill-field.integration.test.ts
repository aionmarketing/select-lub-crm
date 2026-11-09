/**
 * Test design (testing-strategy) — prefill / accept-prefill-field,
 * `POST /conversations/:id/prefill/accept`
 *
 * Moved from `apps/api/src/cadastro.prefill.test.ts`, its six single-route
 * accept cases, assertions unchanged. Its seventh, "creates a customer and
 * titular vehicle on the first accept", reads the result back through
 * `GET /conversations/:id/vehicles`, another module's route, so it moved to
 * `apps/api/test/prefill.integration.test.ts`.
 *
 * Setup: the route is mounted alone through `buildSliceApp`, over
 * `createRoute({ omieAdapter })` with `createFakeOmie()` — Omie is an external
 * service, a port, never reached. The customer's field is written by
 * `customers`' `applyPrefillSuggestion`, for real, on the test transaction.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   1. A suggestion row needs the job that produced it, so the fixture creates a
 *      succeeded job first.
 *   2. Every id asserted on is a real row's, read back from the seed.
 *
 * Oracle: assistive-cadastro-prefill design.md Axis 4 + D6; specs/assistive-prefill
 *   accept persist.
 *
 * Axes: A1 omieId null / set; A2 field class — shared plate / shared name /
 *   CRM-only year; A3 suggestion membership — present / absent
 *
 * Sampled-cell
 *   unlinked accept plate    | A1 null A2 plate  | 200 plate set, put 0 | Omie put or plate missing
 *   linked accept name       | A1 set A2 name    | 200 put > 0          | put 0
 *   linked accept year       | A1 set A2 year    | 200 year set, put 0  | put > 0
 *   accept missing key       | A3 absent         | 409 cadastro unchanged | 200 write
 *   accept year no vehicle   | persist not_found | 404                  | 200 year set
 *   accept unknown conv      |                   | 404                  | 200
 *
 * Decision map: D1 conversation missing; D2 suggestion has field; D4 omieId set;
 *   D5 version/year branch; D11 persist not_found. D12 not_linked infeasible
 *   (applyPrefillSuggestion writes Omie only when omieId is set).
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
 * A conversation linked to a customer (Omie-linked when `omieId` is set) with a
 * titular vehicle unless `seedVehicle` is false, a suggestion behind a succeeded
 * job, and an attendant of the unit.
 */
async function seedPrefill(
  tx: DbClient,
  options?: { omieId?: string; seedVehicle?: boolean; suggestion?: Record<string, string | number> },
) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  const fake = createFakeOmie();
  const omieId = options?.omieId ?? null;
  const customer = await tx.customer.create({
    data: { name: omieId ? "Ana" : PHONE, omieId, unitId: unit.id, origin: "whatsapp", status: "active" },
    select: { id: true },
  });
  let vehicleId: string | null = null;
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
  await tx.conversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
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
  return {
    unitId: unit.id,
    userId: user.id,
    conversationId: conversation.id,
    customerId: customer.id,
    vehicleId,
    fake,
  };
}

async function accept(
  tx: DbClient,
  s: Awaited<ReturnType<typeof seedPrefill>>,
  conversationId: string,
  payload: { field: string; value: string | number },
) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "prefill", "accept-prefill-field", createRoute({ omieAdapter: s.fake })),
    caller: { unitId: s.unitId, userId: s.userId },
  });
  try {
    return await app.inject({ method: "POST", url: `/conversations/${conversationId}/prefill/accept`, payload });
  } finally {
    await app.close();
  }
}

describeWithDatabase("POST /conversations/:id/prefill/accept", () => {
  it("accepts an unlinked plate without writing Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { plate: "ABC1D23" } });

      const response = await accept(tx, s, s.conversationId, { field: "plate", value: "ABC1D23" });

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).fields?.plate).toBeUndefined();
      expect((await tx.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId! } })).plate).toBe("ABC1D23");
      expect(s.fake.putCount()).toBe(0);
    }));

  it("sends a linked name accept through applyCrmEdit", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { omieId: "omie-prefill", suggestion: { name: "Ana Souza" } });

      const response = await accept(tx, s, s.conversationId, { field: "name", value: "Ana Souza" });

      expect(response.statusCode).toBe(200);
      expect(s.fake.putCount()).toBeGreaterThan(0);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: s.customerId } })).name).toBe("Ana Souza");
    }));

  it("writes a linked year on the vehicle without Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { omieId: "omie-prefill", suggestion: { year: 2020 } });

      const response = await accept(tx, s, s.conversationId, { field: "year", value: 2020 });

      expect(response.statusCode).toBe(200);
      expect((await tx.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId! } })).year).toBe(2020);
      expect(s.fake.putCount()).toBe(0);
    }));

  it("returns 409 and writes nothing when the field is not on the suggestion", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { plate: "ABC1D23" } });

      const response = await accept(tx, s, s.conversationId, { field: "name", value: "Maria" });

      expect(response.statusCode).toBe(409);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: s.customerId } })).name).toBe(PHONE);
      expect((await tx.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId! } })).plate).toBeNull();
    }));

  it("returns 404 when accepting year and the customer has no vehicle", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { year: 2020 }, seedVehicle: false });

      const response = await accept(tx, s, s.conversationId, { field: "year", value: 2020 });

      expect(response.statusCode).toBe(404);
    }));

  it("returns 404 for accept on an unknown conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx);

      const response = await accept(tx, s, "missing", { field: "plate", value: "ABC1D23" });

      expect(response.statusCode).toBe(404);
    }));
});
