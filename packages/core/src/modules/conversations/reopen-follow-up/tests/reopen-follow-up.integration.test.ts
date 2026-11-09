/**
 * Test design (testing-strategy) — conversations / reopen-follow-up
 *
 * Module role: `module_conversations`. The loja check and the delete of the
 * closed row each run in their own `db.tx("conversations", …)`.
 *
 * New with the move (4A). The original file's reopen case reads the queue back
 * through `GET /follow-ups` and stays on the whole app in
 * `apps/api/test/follow-up.integration.test.ts`. This case is the slice's own:
 * the closed row goes, reopening what is not closed is still 200, and another
 * loja's conversation is 404 with its row left alone.
 *
 * SUT: `POST /follow-ups/reopen`, through `buildSliceApp` with this slice's
 *   route only, inside one rolling-back transaction.
 *
 * Oracle: follow-up spec — closing is reversible while in effect; reopening
 *   something not closed leaves it listed, which is what was asked for; a
 *   conversation outside the caller's loja answers as a missing one.
 *
 * Sampled-cell
 *   own closed entry     | 200, row gone        | row kept
 *   own, not closed      | 200                  | 404 or an error
 *   another loja's entry | 404, its row kept    | 200 and the row deleted
 */
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedClosableFollowUp,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("POST /follow-ups/reopen", () => {
  it("removes the loja's closed row, and leaves another loja's alone", () =>
    withTestTransaction(db(), async (tx) => {
      const mine = await seedClosableFollowUp(tx);
      const theirs = await seedClosableFollowUp(tx);
      const close = (fixture: typeof mine) =>
        tx.followUpClosedEntry.create({
          data: {
            section: "unansweredQuotes",
            unitId: fixture.unitId,
            conversationId: fixture.conversationId,
            anchor: fixture.quoteId,
            closedByUserId: fixture.userId,
          },
        });
      await close(mine);
      await close(theirs);
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "reopen-follow-up", route),
        caller: { userId: mine.userId, unitId: mine.unitId },
      });
      const reopen = (fixture: typeof mine) =>
        app.inject({
          method: "POST",
          url: "/follow-ups/reopen",
          payload: { section: "unansweredQuotes", conversationId: fixture.conversationId, anchor: fixture.quoteId },
        });
      const rows = (fixture: typeof mine) =>
        tx.followUpClosedEntry.count({ where: { conversationId: fixture.conversationId } });
      try {
        expect((await reopen(mine)).statusCode).toBe(200);
        expect(await rows(mine)).toBe(0);

        // Already open: the entry is listed, which is what reopening asked for.
        expect((await reopen(mine)).statusCode).toBe(200);

        expect((await reopen(theirs)).statusCode).toBe(404);
        expect(await rows(theirs)).toBe(1);
      } finally {
        await app.close();
      }
    }));
});
