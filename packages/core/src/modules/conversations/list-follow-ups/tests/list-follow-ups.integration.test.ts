/**
 * Test design (testing-strategy) — conversations / list-follow-ups
 *
 * Module role: `module_conversations`. The four snapshot reads, the inbound and
 * outbound reads and the closed-entry read each run in their own
 * `db.tx("conversations", …)`; `oil_quote`, `vehicle_return`, `customer` and
 * `scheduled_message` are read under it (`readableBy "*"`).
 *
 * Moved from `apps/api/src/follow-up.route.test.ts` (4A), assertions unchanged:
 * eight of its "GET /follow-ups" cases. The counts-only comparison reads two
 * routes and the 403 is the auth hook's; both stay on the whole app in
 * `apps/api/test/follow-up.integration.test.ts`, with the three close/reopen
 * cases that read the queue back. The fixture is `seedFollowUpScenario` in
 * `@select-lub/core/testing`, moved from the same file.
 *
 * SUT: `GET /follow-ups`, through `buildSliceApp` with this slice's route only,
 *   inside one rolling-back transaction.
 *
 * Oracle: follow-up-screen spec — GET /follow-ups is unit-scoped; a quote
 *   answered by any later inbound leaves; two quotes in one conversation collapse
 *   to the newer; the vencido/aproximando split at today..today+14; já-agendada
 *   reminders flagged without hiding; aguardando cleared by a later outbound; an
 *   inbound with no `shouldReply` ignored; counts equal the listed lengths.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (from the original file)
 *   F1 — a quote's loja is reached as oilQuote -> conversation ->
 *     whatsappConnection -> unitId, in SQL; the second loja tests the join.
 *   F2 — `plannedReminders` is derived from SCHEDULED rows with
 *     `scheduledAt > now`; a dedicated case moves them behind the clock.
 *   F3 — the clock is the run's own; dates are offsets from it.
 *
 * Axes
 *   A1 loja — the caller's / another loja's rows (scoped out)
 *   A2 quote — unanswered / answered by a later inbound / two collapsing
 *   A3 return — vencido / aproximando / with reminders / without / past moment
 *   A4 aguardando — pending / cleared by a later outbound / inbound unlabeled
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { followUpResultSchema } from "../../contracts/http.js";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  DAY_MS,
  describeWithDatabase,
  runInTransactionOnTx,
  seedFollowUpScenario,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

/** The scenario, and a read of the queue as its member user. */
async function scenario(tx: DbClient) {
  const fixture = await seedFollowUpScenario(tx);
  const read = async () => {
    const app = await buildSliceApp({
      db: createDb(tx, runInTransactionOnTx(tx)),
      plugin: (app) => registerSlice(app, "conversations", "list-follow-ups", route),
      caller: { userId: fixture.userId, unitId: fixture.unitId },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/follow-ups" });
      expect(response.statusCode).toBe(200);
      return followUpResultSchema.parse(JSON.parse(response.body));
    } finally {
      await app.close();
    }
  };
  return { fixture, read };
}

describeWithDatabase("GET /follow-ups", () => {
  it("returns only the current loja's entries, and counts that match them", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      const body = await read();

      expect(body.unansweredQuotes.map((row) => row.conversationId)).toEqual([fixture.quotesConversationId]);
      expect(body.overdueReturns.map((row) => row.customerId)).toEqual([fixture.overdueCustomerId]);
      expect(body.upcomingReturns.map((row) => row.customerId)).toEqual([fixture.upcomingCustomerId]);
      expect(body.waitingReply.map((row) => row.conversationId)).toEqual([fixture.waitingConversationId]);
      expect(body.counts.unansweredQuotes).toBe(body.unansweredQuotes.length);
      expect(body.counts.overdueReturns).toBe(body.overdueReturns.length);
      expect(body.counts.upcomingReturns).toBe(body.upcomingReturns.length);
      expect(body.counts.waitingReply).toBe(body.waitingReply.length);
    }));

  it("never lists a quote whose conversation hangs off another loja's connection", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      const body = await read();

      // The join, not a field: the other loja's quote is excluded because its
      // conversation's whatsappConnection belongs to another unit (F1).
      expect(body.unansweredQuotes.find((row) => row.conversationId === fixture.otherConversationId)).toBeUndefined();
      expect(body.waitingReply.find((row) => row.conversationId === fixture.otherConversationId)).toBeUndefined();
    }));

  it("drops a quote answered by any later inbound", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      const body = await read();

      expect(body.unansweredQuotes.find((row) => row.quoteId === fixture.answeredQuoteId)).toBeUndefined();
      expect(
        body.unansweredQuotes.find((row) => row.conversationId === fixture.answeredConversationId),
      ).toBeUndefined();
    }));

  it("collapses two unanswered quotes in one thread to the newer one", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      const body = await read();

      const entry = body.unansweredQuotes.find((row) => row.conversationId === fixture.quotesConversationId);
      expect(entry?.quoteId).toBe(fixture.newerQuoteId);
      expect(body.unansweredQuotes.map((row) => row.quoteId)).not.toContain(fixture.olderQuoteId);
    }));

  it("splits vencido and aproximando at the calendar window", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      const body = await read();

      expect(body.overdueReturns[0]?.vehicles[0]?.returnDate).toBe(fixture.overdueReturnDate);
      expect(body.upcomingReturns[0]?.vehicle.returnDate).toBe(fixture.upcomingReturnDate);
      expect(body.overdueReturns.find((row) => row.customerId === fixture.upcomingCustomerId)).toBeUndefined();
      expect(body.upcomingReturns.find((row) => row.customerId === fixture.overdueCustomerId)).toBeUndefined();
    }));

  it("counts only the reminder moments still ahead, and omits the summary when there are none", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      const body = await read();

      // Derived from the two SCHEDULED rows this test created, ordered by
      // instant — the loader keeps `scheduledAt > now` only (F2).
      expect(body.overdueReturns[0]?.vehicles[0]?.plannedReminders).toEqual({
        count: 2,
        nextAt: fixture.firstMomentIso,
      });
      // Absent, not zero — "none planned" and "two planned" are different claims.
      expect(body.upcomingReturns[0]?.vehicle.plannedReminders).toBeUndefined();
    }));

  it("ignores a reminder moment that has already passed", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      // Precondition: the same rows are counted while they are ahead.
      const before = await read();
      expect(before.overdueReturns[0]?.vehicles[0]?.plannedReminders?.count).toBe(2);

      // Moved behind the clock: a moment nobody will fire must not be promised to
      // the customer (F2). Each row gets its own past instant — a partial unique
      // index covers (return_reminder_message_id, scheduled_at). Scoped to THIS
      // test's return: the worktree database also holds the demo seed (design D9).
      const moments = await tx.scheduledMessage.findMany({
        where: { status: "SCHEDULED", returnReminderMessage: { vehicleReturnId: fixture.overdueReturnId } },
        select: { id: true },
        orderBy: { scheduledAt: "asc" },
      });
      expect(moments).toHaveLength(2);
      for (const [index, moment] of moments.entries()) {
        await tx.scheduledMessage.update({
          where: { id: moment.id },
          data: { scheduledAt: new Date(Date.now() - (index + 1) * DAY_MS) },
        });
      }

      const body = await read();
      expect(body.overdueReturns[0]?.vehicles[0]?.plannedReminders).toBeUndefined();
    }));

  it("clears aguardando after a later outbound and ignores an unlabeled inbound", () =>
    withTestTransaction(db(), async (tx) => {
      const { fixture, read } = await scenario(tx);
      const body = await read();

      const listed = body.waitingReply.map((row) => row.conversationId);
      expect(listed).toEqual([fixture.waitingConversationId]);
      expect(listed).not.toContain(fixture.clearedConversationId);
      expect(listed).not.toContain(fixture.unlabeledConversationId);
    }));
});
