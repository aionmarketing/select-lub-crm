/**
 * Test design (testing-strategy) — prefill / get-prefill,
 * `GET /conversations/:id/prefill`
 *
 * Moved from `apps/api/src/cadastro.prefill.test.ts`, its eight GET cases,
 * assertions unchanged. The route is mounted alone through `buildSliceApp`; the
 * caller is a real `user` row with a membership in the conversation's unit, set
 * on the request the way the auth hook would.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   1. A suggestion row needs the job that produced it (`job_id` NOT NULL, FK),
 *      so every suggestion fixture creates a terminal job first: "pending"
 *      versus "extracting" turns on a job IN FLIGHT, not on one existing.
 *   3. A conversation's unit is its WhatsApp connection's, so "another unit's
 *      conversation" is a 404 from the real join, through a second unit.
 *
 * Oracle: assistive-cadastro-prefill design.md Axis 4 + D6 HTTP mapping.
 *
 * Axes: A4 GET status source — in-flight / keys / failed last job / none;
 *   A6 extractEnabled default false
 *
 * Sampled-cell
 *   GET extracting            | A4 in-flight       | status extracting | pending/empty
 *   GET pending               | A4 keys            | pending + plate   | empty
 *   GET empty                 | A4 none            | empty, switch off | pending invented
 *   GET failed                | A4 failed, no keys | failed            | pending
 *   GET unknown conversation  |                    | 404               | 200
 *   GET another unit          |                    | 404               | 200
 *   GET in-flight + keys      | A4 in-flight wins  | extracting        | pending
 *   GET suggestion {}         | A4 zero keys       | empty             | pending
 *
 * Decision map: D1 conversation missing; D6 in-flight; D7 keys; D8 last job failed;
 *   D13 extractEnabled default.
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

/** A conversation in its own unit, and an attendant of that unit. */
async function seedConversationInUnit(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  return { unitId: unit.id, conversationId: conversation.id };
}

/**
 * The shared fixture: a conversation, optionally a suggestion (behind a
 * succeeded job) and a job in `jobStatus`, and the attendant.
 */
async function seedPrefill(
  tx: DbClient,
  options?: { suggestion?: Record<string, string | number>; jobStatus?: "queued" | "failed" },
) {
  const { unitId, conversationId } = await seedConversationInUnit(tx);
  if (options?.suggestion) {
    const job = await tx.cadastroPrefillJob.create({
      data: { conversationId, status: "succeeded" },
      select: { id: true },
    });
    await tx.cadastroPrefillSuggestion.create({
      data: { conversationId, fields: options.suggestion, jobId: job.id, extractedAt: new Date() },
    });
  }
  if (options?.jobStatus) {
    await tx.cadastroPrefillJob.create({ data: { conversationId, status: options.jobStatus } });
  }
  const user = await seedUser(tx, { units: [unitId] });
  return { unitId, userId: user.id, conversationId };
}

async function get(tx: DbClient, caller: { unitId: string; userId: string }, conversationId: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "prefill", "get-prefill", route),
    caller,
  });
  try {
    return await app.inject({ method: "GET", url: `/conversations/${conversationId}/prefill` });
  } finally {
    await app.close();
  }
}

describeWithDatabase("GET /conversations/:id/prefill", () => {
  it("maps GET extracting when a job is in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { jobStatus: "queued" });

      const response = await get(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).status).toBe("extracting");
    }));

  it("maps GET pending when the suggestion has keys", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: { plate: "ABC1D23" } });

      const response = await get(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      const body = prefillSuggestionSchema.parse(response.json());
      expect(body.status).toBe("pending");
      expect(body.fields?.plate).toBe("ABC1D23");
    }));

  it("maps GET empty when there is no job and no keys", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx);

      const response = await get(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      const body = prefillSuggestionSchema.parse(response.json());
      expect(body.status).toBe("empty");
      expect(body.extractEnabled).toBe(false);
    }));

  it("maps GET failed when the last job failed and no keys remain", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { jobStatus: "failed" });

      const response = await get(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).status).toBe("failed");
    }));

  it("returns 404 for an unknown conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx);

      const response = await get(tx, s, "missing");

      expect(response.statusCode).toBe(404);
    }));

  it("returns 404 when GET prefill targets another unit's conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const caller = await seedUnit(tx);
      const other = await seedConversationInUnit(tx);
      const user = await seedUser(tx, { units: [caller.id] });

      const response = await get(tx, { unitId: caller.id, userId: user.id }, other.conversationId);

      expect(response.statusCode).toBe(404);
    }));

  it("maps GET extracting when keys exist but a job is in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { jobStatus: "queued", suggestion: { plate: "ABC1D23" } });

      const response = await get(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).status).toBe("extracting");
    }));

  it("maps GET empty when the suggestion object has zero keys", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, { suggestion: {} });

      const response = await get(tx, s, s.conversationId);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).status).toBe("empty");
    }));
});
