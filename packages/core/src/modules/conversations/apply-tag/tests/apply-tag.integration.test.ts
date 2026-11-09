/**
 * Test design (testing-strategy) — conversations / apply-tag
 *
 * Module role: `module_conversations`. The link read, the checks and the insert
 * each run in their own `db.tx("conversations", …)`.
 *
 * Moved from `apps/api/src/tags.test.ts` (4A), assertions unchanged: its
 * "returns 409 when applying an inactive tag" and "returns 404 when applying a
 * tag to another loja's conversation" cases. Their tags used to be created (and,
 * for the 409, deactivated) over `POST /tags` and `PATCH /tags/:id`; a slice test
 * mounts only its own route, so the rows are written through `tx` in the state
 * those calls left. The apply-twice and re-apply-after-remove cases chain the
 * list and remove routes and stay in `apps/api/test/tags.integration.test.ts`.
 *
 * SUT: `POST /conversations/:id/tags/:tagId`, through `buildSliceApp` with this
 *   slice's route only, inside one rolling-back transaction.
 *
 * Oracle: openspec/changes/tags-and-templates-crud design.md axis 2.
 *
 * F4 (from the original file) — the loja gate is conversation →
 *   whatsappConnection → unitId, so the another-loja case hangs its conversation
 *   off a second loja's real connection.
 *
 * Decision map (apply-tag)
 *   D4  !tag.active              T inactive 409 it
 *   D6  conversation miss        T other-loja 404
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
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

async function scope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "conversations", "apply-tag", route),
    caller: { userId: "tags-test-caller", unitId: unit.id },
  });
  const tag = async (active: boolean) =>
    (await tx.tag.create({ data: { unitId: unit.id, name: "Retorno", sortOrder: 0, active }, select: { id: true } }))
      .id;
  return { connectionId: connection.id, app, tag };
}

describeWithDatabase("POST /conversations/:id/tags/:tagId", () => {
  it("returns 409 when applying an inactive tag", () =>
    withTestTransaction(db(), async (tx) => {
      const { connectionId, app, tag } = await scope(tx);
      const conversation = await seedConversation(tx, { connectionId });
      try {
        const tagId = await tag(false);

        const applied = await app.inject({
          method: "POST",
          url: `/conversations/${conversation.id}/tags/${tagId}`,
        });

        // A guard in the adapter, not a constraint — so the transaction is
        // intact and the row count below is readable.
        expect(applied.statusCode).toBe(409);
        expect(
          await tx.conversationTag.count({ where: { conversationId: conversation.id, tagId } }),
        ).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("returns 404 when applying a tag to another loja's conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const { connectionId, app, tag } = await scope(tx);
      const otherUnit = await seedUnit(tx);
      const otherConnection = await seedConnection(tx, { unitId: otherUnit.id });
      const otherConversation = await seedConversation(tx, { connectionId: otherConnection.id });
      const ownConversation = await seedConversation(tx, { connectionId });
      try {
        const tagId = await tag(true);
        // Positive control, new with the move: the same tag applies to this
        // loja's own thread, so the 404 below is the loja gate (the original's
        // control was its `POST /tags` 201).
        const own = await app.inject({
          method: "POST",
          url: `/conversations/${ownConversation.id}/tags/${tagId}`,
        });
        expect(own.statusCode).toBe(200);

        const applied = await app.inject({
          method: "POST",
          url: `/conversations/${otherConversation.id}/tags/${tagId}`,
        });

        // The gate is conversation -> whatsappConnection -> unitId (F4).
        expect(applied.statusCode).toBe(404);
        expect(
          await tx.conversationTag.count({ where: { conversationId: otherConversation.id } }),
        ).toBe(0);
      } finally {
        await app.close();
      }
    }));
});
