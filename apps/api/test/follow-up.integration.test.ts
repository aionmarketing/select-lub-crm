/**
 * Test design (testing-strategy) — `GET /follow-ups` on the real database
 *
 * Moved from `apps/api/src/follow-up.route.test.ts` (4A), assertions unchanged.
 * These five cases stay on the whole app: the counts-only read compared with
 * the list read (two routes); the 403 from the auth hook; and three close/reopen
 * cases that read the queue back through `GET /follow-ups`. The other nine are
 * the list-follow-ups (8) and close-follow-up (1) slices' own tests. The two
 * fixtures moved to `@select-lub/core/testing` as `seedFollowUpScenario` and
 * `seedClosableFollowUp`; here their member user is `TEST_USER_ID`, the id the
 * fake `getUser` resolves.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; every row is created
 * inside the test's transaction and rolled back with it. The app is built with
 * `buildApp({ db: tx })`, so the Prisma follow-up store and its snapshot loader
 * are what answers. `getUser` stays faked — it is Supabase JWT verification, an
 * external port, not a store (design D4).
 *
 * Oracle: follow-up-screen spec — GET /follow-ups is unit-scoped; 403 when the
 * caller is not a member of the header's loja; a quote answered by any later
 * inbound leaves; two quotes in one conversation collapse to the newer; the
 * vencido/aproximando split at today..today+14; já-agendada reminders flagged
 * without hiding; aguardando cleared by a later outbound; an inbound with no
 * `shouldReply` ignored; counts equal the listed lengths.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (three; this file's proof)
 *
 * F1 — Unit scoping was asserted against dead code. `createMemoryFollowUpStore`
 *   took a pre-built `FollowUpSnapshot`, so the only scoping the old file could
 *   exercise was `aggregate.ts`'s `quote.unitId !== unitId` and
 *   `conversation.unitId === unitId` guards, fed by a flat `unitId` the test
 *   wrote onto each row. The database has no such column: a quote's loja is
 *   reached as oilQuote -> conversation -> whatsappConnection -> unitId, and
 *   `loadFollowUpSnapshot` filters there, in SQL, then stamps its own `unitId`
 *   parameter onto every row it returns. Both in-aggregate guards are therefore
 *   unreachable on the Prisma path. The old `q-b`/`unit-b` case proved a filter
 *   that never runs in production. It is replaced here by a second loja with its
 *   own connection, conversation and quote, which tests the join itself.
 *
 * F2 — `plannedReminderCount: 2` and `nextReminderAt` were literals. The fake
 *   accepted them as given. The loader derives both from
 *   reminderMessages -> scheduledMessages, keeping only rows with status
 *   SCHEDULED **and `scheduledAt > now`**. The old fixture's `2026-09-04`
 *   instant is in the past today, so the same rows on the real adapter yield
 *   count 0 and `nextReminderAt: null` — the assertion held only because the
 *   fake never applied the filter. Reminder moments here are seeded in the
 *   future relative to the run, the count is read back from rows the test
 *   created, and a dedicated case moves them behind the clock.
 *
 * F3 — The clock was injectable only on the fake. `createMemoryFollowUpStore`
 *   took `{ now: NOW }` pinned at 2026-08-31; `createPrismaFollowUpStore` calls
 *   `new Date()` and offers no seam. The old fixture's `2026-09-13` return,
 *   asserted as aproximando, is vencido on any run after 2026-09-13. Return
 *   dates here are offsets from the run's own clock, far enough from the
 *   boundary (-10 and +7 against a today..today+14 window) that the
 *   America/Sao_Paulo conversion cannot flip them.
 *
 * Axes
 *   A1 loja — the caller's / another loja's rows (scoped out) / another loja in
 *      the header (403)
 *   A2 quote — unanswered / answered by a later inbound / two collapsing
 *   A3 return — vencido / aproximando / with reminders / without / past moment
 *   A4 aguardando — pending / cleared by a later outbound / inbound unlabeled
 *   A5 read shape — the full result / the counts-only read
 *
 * Outputs
 *   O1 200 FollowUpResult, only this loja's entries; O2 403;
 *   O3 counts equal to the list read's lengths
 *
 * Decision map (the list-follow-ups slice)
 *   query.closed === "1"  covered in the close/reopen block below
 *   !unitId               contract-hidden — registerAuthHook 403s first, which
 *                         is what the two 403 cases observe
 *
 * Out of scope: the anchor semantics themselves
 *   (packages/core/test/conversations-follow-up-aggregate.test.ts); the calendar
 *   BVA extras (conversations-follow-up-returns.test.ts); the closed-entry writes
 *   (conversations-follow-up-closed.live.test.ts).
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedClosableFollowUp,
  seedFollowUpScenario,
  withTestTransaction,
} from "@select-lub/core/testing";
import { followUpOptionalCountsSchema, followUpResultSchema } from "@select-lub/shared-types";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

function headers(unitId: string) {
  return { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
}

async function appOn(tx: DbClient) {
  return buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
  });
}

async function readFollowUps(
  app: Awaited<ReturnType<typeof appOn>>,
  unitId: string,
  closed = false,
) {
  const response = await app.inject({
    method: "GET",
    url: closed ? "/follow-ups?closed=1" : "/follow-ups",
    headers: headers(unitId),
  });
  expect(response.statusCode).toBe(200);
  return followUpResultSchema.parse(JSON.parse(response.body));
}

describeWithDatabase("GET /follow-ups", () => {
  const db = () => prisma as PrismaClient;

  it("gives the same counts through the counts-only read", () =>
    withTestTransaction(db(), async (tx) => {
      const fixture = await seedFollowUpScenario(tx, TEST_USER_ID);
      const app = await appOn(tx);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/follow-up-counts",
          headers: headers(fixture.unitId),
        });
        expect(response.statusCode).toBe(200);
        const counts = followUpOptionalCountsSchema.parse(JSON.parse(response.body));
        const full = await readFollowUps(app, fixture.unitId);

        // Not "both happen to be 1 today" — the whole object, against the lengths
        // the list read actually returned. The two are one aggregation, so a
        // predicate moved in `aggregate.ts` moves both or neither.
        expect(counts).toEqual(full.counts);
        expect(counts).toEqual({
          unansweredQuotes: full.unansweredQuotes.length,
          overdueReturns: full.overdueReturns.length,
          upcomingReturns: full.upcomingReturns.length,
          waitingReply: full.waitingReply.length,
        });
      } finally {
        await app.close();
      }
    }));

  it("refuses both reads for a loja the user does not belong to", () =>
    withTestTransaction(db(), async (tx) => {
      const fixture = await seedFollowUpScenario(tx, TEST_USER_ID);
      const app = await appOn(tx);
      try {
        for (const url of ["/follow-ups", "/follow-up-counts"]) {
          const response = await app.inject({
            method: "GET",
            url,
            headers: headers(fixture.otherUnitId),
          });
          // Same scoping on both: a cheap badge must not be a way around it.
          expect(response.statusCode).toBe(403);
        }
      } finally {
        await app.close();
      }
    }));
});

/**
 * Test design (testing-strategy) — the close/reopen half, on the real database
 *
 * Setup: its own transaction per case, because these cases WRITE; the closed
 * rows go through `closeFollowUpEntry`/`listClosedFollowUpEntries` in
 * the conversations module (`internal/follow-up-closed.ts`) and roll back with
 * the test.
 *
 * Oracle: follow-up (align-shipped-ui-to-revised-canvas delta) — "a closed entry
 *   SHALL be absent from its section and from that section's count until the
 *   underlying condition changes"; "closing SHALL be reversible from the screen
 *   while it is in effect, and the screen SHALL offer a way to see the entries
 *   currently closed in a section"; "closing SHALL be scoped to the entry and
 *   its section, not to the customer or conversation as a whole".
 *
 * FAKE-ONLY ASSERTIONS SURFACED (two)
 *
 * F4 — "a second close is the same statement" was a property of the fake's Map.
 *   On Postgres the same claim rests on `FollowUpClosedEntry`'s unique key
 *   (section, conversation_id, anchor), which `closeFollowUpEntry` upserts
 *   against; the fake deduped by overwriting a map key, which holds whatever the
 *   real key is. The case is kept and now exercises the real constraint, and
 *   counts the rows underneath so "one row" is asserted and not assumed.
 *
 *   Worth stating because the harness makes it load-bearing: the write is an
 *   upsert, so the second close raises no unique violation. Had it been a plain
 *   insert, the violation would abort the enclosing test transaction and every
 *   read after it in this case would fail on the abort rather than on its own
 *   merits, since Prisma's interactive transaction exposes no savepoint
 *   (design D2). The reads that follow the second close are therefore also the
 *   evidence that no violation occurred.
 *
 * F5 — The old fixture was contradictory, and only the fake could hold it. It
 *   put ONE conversation in both sections by giving it an unanswered quote at
 *   2026-08-20 and a pending inbound at 2026-08-27 — an inbound seven days
 *   AFTER the quote. On the real loader both facts come from the same `message`
 *   table: `inbounds` (the quote-answered predicate) and `conversations[].messages`
 *   (the aguardando predicate) are two reads of those same rows, so a later
 *   inbound answers the quote and the entry the test then closed was never in
 *   the section. It only survived on the fake because its snapshot carried
 *   `inbounds` and `conversations[].messages` as two independent arrays, and the
 *   fixture filled one and not the other. Found by the precondition read added
 *   here, which returned `[]`. Corrected to real behaviour by seeding the
 *   inbound BEFORE the quote, which leaves both sections populated honestly:
 *   nothing outbound follows the inbound, so aguardando still holds.
 *
 * Axes: A1 route close/reopen; A2 ownership own/other loja; A3 read queue/closed;
 *   A4 repetition first/second close
 * Outputs: O1 200, gone from list AND count; O2 200, back; O3 the closed read
 *   lists exactly what the queue dropped; O4 404 for an unowned conversation
 *
 * Decision map (the close-follow-up and reopen-follow-up slices)
 *   action === "close"      T the close its; F the reopen it
 *   result === "not_found"  T close-follow-up's other-loja it; F every it here
 *   !unitId || !userId      contract-hidden — the auth hook 403s first
 *
 * Out of scope: the anchor semantics (aggregate.test.ts).
 */
describeWithDatabase("closing a Follow-up entry", () => {
  const db = () => prisma as PrismaClient;

  it("takes the entry out of its section and its count, and lists it as closed", () =>
    withTestTransaction(db(), async (tx) => {
      const fixture = await seedClosableFollowUp(tx, TEST_USER_ID);
      const app = await appOn(tx);
      try {
        // Precondition: the entry is in its section before anything closes it.
        const before = await readFollowUps(app, fixture.unitId);
        expect(before.unansweredQuotes.map((row) => row.quoteId)).toEqual([fixture.quoteId]);

        const response = await app.inject({
          method: "POST",
          url: "/follow-ups/close",
          headers: headers(fixture.unitId),
          payload: {
            section: "unansweredQuotes",
            conversationId: fixture.conversationId,
            anchor: fixture.quoteId,
          },
        });
        expect(response.statusCode).toBe(200);

        const queue = await readFollowUps(app, fixture.unitId);
        expect(queue.unansweredQuotes).toEqual([]);
        expect(queue.counts.unansweredQuotes).toBe(0);
        // Same conversation, other section: closing is scoped to the entry.
        expect(queue.waitingReply.map((row) => row.conversationId)).toEqual([
          fixture.conversationId,
        ]);

        const closed = await readFollowUps(app, fixture.unitId, true);
        expect(closed.unansweredQuotes.map((row) => row.quoteId)).toEqual([fixture.quoteId]);
        expect(closed.unansweredQuotes[0]?.closed?.anchor).toBe(fixture.quoteId);
      } finally {
        await app.close();
      }
    }));

  it("treats a second close of the same entry as the same statement", () =>
    withTestTransaction(db(), async (tx) => {
      const fixture = await seedClosableFollowUp(tx, TEST_USER_ID);
      const app = await appOn(tx);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await app.inject({
            method: "POST",
            url: "/follow-ups/close",
            headers: headers(fixture.unitId),
            payload: {
              section: "unansweredQuotes",
              conversationId: fixture.conversationId,
              anchor: fixture.quoteId,
            },
          });
          // The second one meets the unique key, not a fresh Map slot (F4).
          expect(response.statusCode).toBe(200);
        }

        const closed = await readFollowUps(app, fixture.unitId, true);
        expect(closed.unansweredQuotes).toHaveLength(1);
        // And one row underneath, not two: the dedupe is the constraint.
        expect(
          await tx.followUpClosedEntry.count({
            where: { conversationId: fixture.conversationId, section: "unansweredQuotes" },
          }),
        ).toBe(1);
      } finally {
        await app.close();
      }
    }));

  it("puts the entry back on reopen", () =>
    withTestTransaction(db(), async (tx) => {
      const fixture = await seedClosableFollowUp(tx, TEST_USER_ID);
      const app = await appOn(tx);
      try {
        const payload = {
          section: "unansweredQuotes",
          conversationId: fixture.conversationId,
          anchor: fixture.quoteId,
        };
        await app.inject({
          method: "POST",
          url: "/follow-ups/close",
          headers: headers(fixture.unitId),
          payload,
        });
        // Precondition: it really is closed before reopen is asked for.
        expect((await readFollowUps(app, fixture.unitId)).unansweredQuotes).toEqual([]);

        const response = await app.inject({
          method: "POST",
          url: "/follow-ups/reopen",
          headers: headers(fixture.unitId),
          payload,
        });
        expect(response.statusCode).toBe(200);

        expect(
          (await readFollowUps(app, fixture.unitId)).unansweredQuotes.map((row) => row.quoteId),
        ).toEqual([fixture.quoteId]);
        expect((await readFollowUps(app, fixture.unitId, true)).unansweredQuotes).toEqual([]);
      } finally {
        await app.close();
      }
    }));

});
