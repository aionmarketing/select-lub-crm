/**
 * Test design (testing-strategy) — scheduling / list-scheduled-messages
 *
 * Module role: `module_scheduling`. The conversation check and the list read
 * run in one `db.tx("scheduling", …)`.
 *
 * Moved from `apps/api/src/scheduled.route.test.ts`, assertion unchanged: its
 * list case. One case, as before.
 *
 * SUT: `GET /conversations/:id/scheduled-messages`, through `buildSliceApp`
 *   with this slice's route only, inside one rolling-back transaction.
 *
 * Oracle: scheduled-messages task 2.2 / design D4 — GET lists a conversation's
 *   schedules.
 *
 * Sampled-cell
 *   list after insert           | A4 list | O2 200 list | 404, or another conversation's rows
 *
 * Decision map (list-scheduled-messages)
 *   conversation miss           not sampled here — the same join as the other
 *                               slices' another-loja 404
 *
 * Out of scope: the hook's 401/403.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
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

const db = () => prisma as PrismaClient;

describeWithDatabase("GET /conversations/:id/scheduled-messages", () => {
  it("lists the schedules of the conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id });
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const user = await seedUser(tx, { units: [unit.id] });
      const row = await tx.scheduledMessage.create({
        data: {
          conversationId: conversation.id,
          frozenText: "Olá",
          scheduledAt: new Date("2099-01-15T15:00:00.000Z"),
          status: "SCHEDULED",
          idempotencyKey: randomUUID(),
          createdByUserId: user.id,
        },
        select: { id: true },
      });
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "scheduling", "list-scheduled-messages", route),
        caller: { userId: user.id, unitId: unit.id },
      });
      try {
        const listed = await app.inject({
          method: "GET",
          url: `/conversations/${conversation.id}/scheduled-messages`,
        });

        expect(listed.statusCode).toBe(200);
        // The ids this test created, not a count: the worktree database also
        // holds the demo seed (design D9).
        expect(listed.json().map((entry: { id: string }) => entry.id)).toEqual([row.id]);
      } finally {
        await app.close();
      }
    }));
});
