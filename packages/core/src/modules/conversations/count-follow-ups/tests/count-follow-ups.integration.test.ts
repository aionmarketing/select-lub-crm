/**
 * Test design (testing-strategy) — conversations / count-follow-ups
 *
 * Module role: `module_conversations` (the same reads as list-follow-ups).
 *
 * New with the move (4A). The original file's counts case compares this route
 * with `GET /follow-ups`, two slices, so it stays on the whole app in
 * `apps/api/test/follow-up.integration.test.ts`. This case is the slice's own:
 * the counts of `seedFollowUpScenario`, which lists exactly one entry per
 * section for its member loja and never the other loja's quote.
 *
 * SUT: `GET /follow-up-counts`, through `buildSliceApp` with this slice's route
 *   only, inside one rolling-back transaction.
 *
 * Oracle: follow-up spec "Section counts are a shared contract" — each count is
 *   the length its list has. The scenario's lists are one entry each (its own
 *   comments say why: the quote pair collapses, the answered quote leaves, the
 *   cleared and unlabeled threads are not aguardando).
 *
 * Sampled-cell
 *   the scenario              | {1,1,1,1} | the other loja's quote counted (2), or a 0
 */
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { followUpOptionalCountsSchema } from "../../contracts/http.js";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedFollowUpScenario,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("GET /follow-up-counts", () => {
  it("counts one entry per section for the scenario's loja", () =>
    withTestTransaction(db(), async (tx) => {
      const fixture = await seedFollowUpScenario(tx);
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "count-follow-ups", route),
        caller: { userId: fixture.userId, unitId: fixture.unitId },
      });
      try {
        const response = await app.inject({ method: "GET", url: "/follow-up-counts" });

        expect(response.statusCode).toBe(200);
        expect(followUpOptionalCountsSchema.parse(response.json())).toEqual({
          unansweredQuotes: 1,
          overdueReturns: 1,
          upcomingReturns: 1,
          waitingReply: 1,
        });
      } finally {
        await app.close();
      }
    }));
});
