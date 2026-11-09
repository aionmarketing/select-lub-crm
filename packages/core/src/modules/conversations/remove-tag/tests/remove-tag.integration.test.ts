/**
 * Test design (testing-strategy) — conversations / remove-tag
 *
 * Module role: `module_conversations`. The link read, then the checks and the
 * close in one `db.tx("conversations", …)`.
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged: its
 * "returns 404 when removing a tag that was never applied" case. Its tag used to
 * be created over `POST /tags`; a slice test mounts only its own route, so the
 * row is written through `tx`. A positive control — removing an open apply — is
 * new with the move, because the original's control was that `POST /tags` 201.
 *
 * SUT: `DELETE /conversations/:id/tags/:tagId`, through `buildSliceApp` with
 *   this slice's route only, inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 2 — remove
 *   closes the open apply and keeps the history.
 *
 * Decision map (remove-tag)
 *   D12 no open apply            T never-applied 404; F the open-apply control
 */
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
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("DELETE /conversations/:id/tags/:tagId", () => {
  it("returns 404 when removing a tag that was never applied", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id });
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const applied = await seedConversation(tx, { connectionId: connection.id });
      const tag = await tx.tag.create({
        data: { unitId: unit.id, name: "Retorno", sortOrder: 0, active: true },
        select: { id: true },
      });
      await tx.conversationTag.create({ data: { conversationId: applied.id, tagId: tag.id } });
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "remove-tag", route),
        caller: { userId: "tags-test-caller", unitId: unit.id },
      });
      try {
        // Positive control: an open apply is closed, not deleted.
        const ok = await app.inject({ method: "DELETE", url: `/conversations/${applied.id}/tags/${tag.id}` });
        expect(ok.statusCode).toBe(200);
        expect(
          await tx.conversationTag.count({
            where: { conversationId: applied.id, tagId: tag.id, removedAt: { not: null } },
          }),
        ).toBe(1);

        const removed = await app.inject({
          method: "DELETE",
          url: `/conversations/${conversation.id}/tags/${tag.id}`,
        });

        // A guard, not a constraint: "nothing open to close" is 404.
        expect(removed.statusCode).toBe(404);
        expect(
          await tx.conversationTag.count({ where: { conversationId: conversation.id, tagId: tag.id } }),
        ).toBe(0);
      } finally {
        await app.close();
      }
    }));
});
