/**
 * Test design (testing-strategy)
 *
 * WHY THIS FILE IS IN apps/api AND NOT IN THE SLICE: its subject is the auth
 * hook (`packages/core/src/kernel/auth/hook.ts`, registered by `buildApp`) — the 403 when `X-Unit-Id` names a unit the
 * caller is not a member of. The reports slice's own tests mount it on the
 * kernel app with the caller STATED, which has no such hook, so this case would
 * pass there vacuously on a stand-in. It runs here, through the real `buildApp`,
 * the real hook, a real `user` row and real `user_unit` memberships
 * (adopt-modular-vertical-slices wave 2 ruling on hook cases).
 *
 * Setup: `buildApp({ db: tx, runInTransaction, getUser })` inside one
 * rolling-back transaction per test on the worktree database; the fake
 * `getUser` resolves `TEST_ACCESS_TOKEN` to `TEST_USER_ID`, whose memberships
 * are seeded rows. Everything is created inside the transaction.
 *
 * Moved from `apps/api/src/reports.route.test.ts` (2C): its one hook case, body
 * unchanged. Its other nine cases moved to
 * `packages/core/src/modules/reports/report-conversations/tests/`.
 *
 * Positive control, new: the same composition answers 200 for the caller's own
 * unit, so the 403 is the membership check refusing and not the route being
 * unreachable or the plugin unregistered.
 *
 * The unanswered-quote port, new: `app.ts` binds the reports module's
 * `unansweredQuotes` port to follow-up's `unansweredQuoteCount`. The slice's own
 * tests use a stub, so only this composition-level case pins the real binding.
 * Two quotes are seeded — one answered by a later inbound, one not — so a stub or
 * unbound port (0) and a port that counts every quote (2) both fail.
 *
 * Sampled-cell
 *   header names a unit the caller is not in | 403, no report body | 200 with another unit's numbers
 *   header names the caller's own unit        | 200 with its nova   | 403, or the route missing (404)
 *   one answered + one unanswered quote       | unansweredQuotes 1  | 0 (port stubbed or unbound), 2 (counts every quote)
 *
 * Out of scope: the report's contents (the slice's tests); 401 without a token
 *   (the hook's own suite, auth.test.ts).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { reportResultSchema } from "@select-lub/shared-types";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

const MATCHING = "periodStart=2026-08-01T00:00:00.000Z&periodEnd=2026-09-01T00:00:00.000Z";
const INBOUND_AT = new Date("2026-08-10T12:00:00.000Z");
const OUTBOUND_AT = new Date("2026-08-10T13:00:00.000Z");

const db = () => prisma as PrismaClient;

/** One answered nova on a connection. */
async function seedNova(tx: DbClient, connectionId: string): Promise<string> {
  const key = `5519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`;
  const row = await tx.conversation.create({
    data: {
      whatsappConnectionId: connectionId,
      remoteJid: `${key}@s.whatsapp.net`,
      chatKey: key,
      startedAt: INBOUND_AT,
      firstInboundAt: INBOUND_AT,
      firstOutboundAt: OUTBOUND_AT,
      lastMessageAt: OUTBOUND_AT,
    },
    select: { id: true },
  });
  return row.id;
}

/** The caller's unit, a connection in it, and the CRM user membership behind `TEST_ACCESS_TOKEN`. */
async function seedCallerUnit(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
  return { unitId: unit.id, connectionId: connection.id };
}

/**
 * Requests the report through the full composition: real hook, real plugin.
 *
 * @param tx - The test transaction.
 * @param unitId - Value for `X-Unit-Id`.
 * @param query - Query string after the period.
 * @returns The raw response.
 */
async function get(tx: DbClient, unitId: string, query: string) {
  const app = await buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
  });
  try {
    return await app.inject({
      method: "GET",
      url: `/reports/conversations?${query}`,
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
  } finally {
    await app.close();
  }
}

describeWithDatabase("GET /reports/conversations through apps/api's auth hook", () => {
  it("returns 403 when the header is a unit the user does not belong to", () =>
    withTestTransaction(db(), async (tx) => {
      await seedCallerUnit(tx);
      const foreignUnit = await seedUnit(tx);
      const foreignConnection = await seedConnection(tx, { unitId: foreignUnit.id });
      await seedNova(tx, foreignConnection.id);

      const response = await get(tx, foreignUnit.id, `${MATCHING}&granularity=day`);

      expect(response.statusCode).toBe(403);
      expect(JSON.stringify(response.json())).not.toContain("newConversationCount");
    }));

  it("returns 200 with the report when the header is the caller's own unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      await seedNova(tx, connectionId);

      const response = await get(tx, unitId, `${MATCHING}&granularity=day`);

      expect(response.statusCode).toBe(200);
      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.newConversationCount).toBe(1);
    }));

  it("reports follow-up's unanswered-quote count through the port app.ts binds", () =>
    withTestTransaction(db(), async (tx) => {
      const { unitId, connectionId } = await seedCallerUnit(tx);
      const customer = await tx.customer.create({
        data: { name: "Cliente", unitId, origin: "crm", status: "active" },
        select: { id: true },
      });
      const vehicle = await tx.vehicle.create({
        data: { customerId: customer.id, plate: "ABC1D23", origin: "crm" },
        select: { id: true },
      });
      const quoteAt = new Date("2026-08-11T12:00:00.000Z");
      /** A quote on its own conversation; `answered` adds an inbound after it. */
      async function quoteOn(answered: boolean) {
        const conversationId = await seedNova(tx, connectionId);
        await tx.oilQuote.create({
          data: {
            customerId: customer.id,
            vehicleId: vehicle.id,
            conversationId,
            generatedMessageText: "orçamento",
            createdByUserId: TEST_USER_ID,
            createdAt: quoteAt,
          },
        });
        if (answered) {
          await tx.message.create({
            data: {
              conversationId,
              externalMessageId: `t-msg-${randomUUID()}`,
              direction: "inbound",
              messageType: "text",
              providerTimestamp: new Date("2026-08-12T12:00:00.000Z"),
            },
          });
        }
      }
      await quoteOn(true);
      await quoteOn(false);

      const response = await get(tx, unitId, `${MATCHING}&granularity=day`);

      expect(response.statusCode).toBe(200);
      const body = reportResultSchema.parse(JSON.parse(response.body));
      expect(body.insights.secondary.unansweredQuotes).toBe(1);
    }));
});
