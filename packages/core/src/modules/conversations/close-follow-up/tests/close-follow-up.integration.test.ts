/**
 * Test design (testing-strategy) — conversations / close-follow-up
 *
 * Module role: `module_conversations`. The loja check and the upsert of
 * `follow_up_closed_entry` each run in their own `db.tx("conversations", …)`.
 *
 * Moved from `apps/api/src/follow-up.route.test.ts` (4A), assertions unchanged:
 * "answers 404 for a conversation the loja does not own". Its positive control
 * — closing the loja's own entry writes one row — is new with the move; the
 * original's other close cases read the queue back through `GET /follow-ups`
 * and stay on the whole app in `apps/api/test/follow-up.integration.test.ts`.
 *
 * SUT: `POST /follow-ups/close`, through `buildSliceApp` with this slice's
 *   route only, inside one rolling-back transaction.
 *
 * Oracle: follow-up spec — closing is scoped to the entry and its section; a
 *   conversation outside the caller's loja answers as a missing one.
 *
 * Decision map
 *   conversation not the loja's  T other-loja it (404, no row); F own entry (200, one row)
 */
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  insertFollowUpThread,
  runInTransactionOnTx,
  seedClosableFollowUp,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("POST /follow-ups/close", () => {
  it("answers 404 for a conversation the loja does not own", () =>
    withTestTransaction(db(), async (tx) => {
      const fixture = await seedClosableFollowUp(tx);
      // A real conversation, on a real connection, in a loja the caller is not a
      // member of: the ownership gate is the join, so the row has to exist for
      // the case to mean anything.
      const otherUnit = await seedUnit(tx);
      const otherConnection = await seedConnection(tx, { unitId: otherUnit.id });
      const elsewhere = await insertFollowUpThread(tx, otherConnection.id, "Elsewhere");
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "close-follow-up", route),
        caller: { userId: fixture.userId, unitId: fixture.unitId },
      });
      try {
        // Positive control, new with the move: the loja's own entry closes, one row.
        const own = await app.inject({
          method: "POST",
          url: "/follow-ups/close",
          payload: { section: "unansweredQuotes", conversationId: fixture.conversationId, anchor: fixture.quoteId },
        });
        expect(own.statusCode).toBe(200);
        expect(await tx.followUpClosedEntry.count({ where: { conversationId: fixture.conversationId } })).toBe(1);

        const response = await app.inject({
          method: "POST",
          url: "/follow-ups/close",
          payload: { section: "unansweredQuotes", conversationId: elsewhere.conversationId, anchor: "q-9" },
        });

        // 404 and not 403: a 403 would confirm the row exists to someone who
        // cannot see it.
        expect(response.statusCode).toBe(404);
        // And nothing was written for it.
        expect(await tx.followUpClosedEntry.count({ where: { conversationId: elsewhere.conversationId } })).toBe(0);
      } finally {
        await app.close();
      }
    }));
});
