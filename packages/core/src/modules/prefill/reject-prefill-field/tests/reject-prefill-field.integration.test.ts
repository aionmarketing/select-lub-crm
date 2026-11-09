/**
 * Test design (testing-strategy) — prefill / reject-prefill-field,
 * `POST /conversations/:id/prefill/reject`
 *
 * Moved from `apps/api/src/cadastro.prefill.test.ts`, its two reject cases,
 * assertions unchanged. The route is mounted alone through `buildSliceApp`.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   1. A suggestion row needs the job that produced it, so the fixture creates a
 *      succeeded job first.
 *   2. The customer and vehicle are real rows; the ids asserted on are read back
 *      from what the seed created, never literals the test chose.
 *
 * Oracle: assistive-cadastro-prefill design.md D6 — reject drops the key and
 *   writes no cadastro.
 *
 * Axes: A3 suggestion membership — key present / absent
 *
 * Sampled-cell
 *   reject plate          | A3 present | 200, plate dropped, vehicle plate kept | vehicle plate flipped
 *   reject missing field  | A3 absent  | 200, plate kept                       | plate stripped
 *
 * Decision map: D9 reject has field — T reject plate; F reject missing field.
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
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
import { route } from "../index.js";

const PHONE = "11988887777";

const db = () => prisma as PrismaClient;

/**
 * A conversation linked to a customer with a titular vehicle at `plate`, a
 * suggestion behind a succeeded job, and an attendant of the unit.
 */
async function seedPrefill(tx: DbClient, options: { plate?: string; suggestion: Record<string, string> }) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  const customer = await tx.customer.create({
    data: { name: PHONE, unitId: unit.id, origin: "whatsapp", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: options.plate ?? null, origin: "whatsapp" },
    select: { id: true },
  });
  await tx.conversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
  const job = await tx.cadastroPrefillJob.create({
    data: { conversationId: conversation.id, status: "succeeded" },
    select: { id: true },
  });
  await tx.cadastroPrefillSuggestion.create({
    data: { conversationId: conversation.id, fields: options.suggestion, jobId: job.id, extractedAt: new Date() },
  });
  const user = await seedUser(tx, { units: [unit.id] });
  return { unitId: unit.id, userId: user.id, conversationId: conversation.id, vehicleId: vehicle.id };
}

async function reject(tx: DbClient, s: { unitId: string; userId: string; conversationId: string }, field: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "prefill", "reject-prefill-field", route),
    caller: { unitId: s.unitId, userId: s.userId },
  });
  try {
    return await app.inject({
      method: "POST",
      url: `/conversations/${s.conversationId}/prefill/reject`,
      payload: { field },
    });
  } finally {
    await app.close();
  }
}

/** The stored suggestion fields, or undefined when no row exists. */
async function suggestionFields(tx: DbClient, conversationId: string) {
  const row = await tx.cadastroPrefillSuggestion.findUnique({ where: { conversationId }, select: { fields: true } });
  return row ? (row.fields as Record<string, unknown>) : undefined;
}

describeWithDatabase("POST /conversations/:id/prefill/reject", () => {
  it("rejects a plate without writing cadastro", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { plate: "KEEP1234", suggestion: { plate: "ABC1D23" } });

      const response = await reject(tx, s, "plate");

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).fields?.plate).toBeUndefined();
      expect((await tx.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId } })).plate).toBe("KEEP1234");
      expect((await suggestionFields(tx, s.conversationId))?.plate).toBeUndefined();
    }));

  it("leaves the suggestion unchanged when reject names a field that is not pending", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { plate: "ABC1D23" } });

      const response = await reject(tx, s, "name");

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).fields?.plate).toBe("ABC1D23");
      expect((await suggestionFields(tx, s.conversationId))?.plate).toBe("ABC1D23");
    }));
});
