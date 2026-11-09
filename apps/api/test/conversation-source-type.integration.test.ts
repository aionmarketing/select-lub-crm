/**
 * Test design — the database refuses a conversation origin outside the three
 *
 * SUT: migration `20260924120000_conversation_source_type_check`, on the
 *   worktree database the harness migrates, inside one rolling-back
 *   transaction per test (`withTestTransaction`).
 *
 * Why. `conversation.source_type` was unconstrained TEXT. The reports read path
 *   filed an unknown string under UNKNOWN while the origin filter compared the
 *   raw column, so the origin table and its drill-through could disagree. The
 *   owner chose to make the value impossible rather than map it twice.
 *
 * Partitions:
 *   P1 each of AD, ORGANIC, UNKNOWN — stored and read back unchanged.
 *   P2 any other string — refused by `conversation_source_type_check`.
 *
 * P1 is the positive control for P2: without it, a refusal could come from a
 *   row the fixture built wrongly rather than from the constraint.
 * P2 has a test of its own because a refused statement aborts the transaction;
 *   nothing may run after it in the same test.
 */
import { expect, it } from "vitest";
import { prisma, type DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";

async function seededConversationId(tx: DbClient): Promise<string> {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  return conversation.id;
}

describeWithDatabase("conversation.source_type check", () => {
  it("stores each of AD, ORGANIC and UNKNOWN", () =>
    withTestTransaction(prisma!, async (tx) => {
      const id = await seededConversationId(tx);
      for (const value of ["AD", "ORGANIC", "UNKNOWN"]) {
        await tx.$executeRaw`UPDATE conversation SET source_type = ${value} WHERE id = ${id}`;
        const rows = await tx.$queryRaw<{ source_type: string }[]>`
          SELECT source_type FROM conversation WHERE id = ${id}`;
        expect(rows[0]?.source_type).toBe(value);
      }
    }));

  it("refuses any other value", () =>
    withTestTransaction(prisma!, async (tx) => {
      const id = await seededConversationId(tx);
      await expect(
        tx.$executeRaw`UPDATE conversation SET source_type = ${"GARBAGE"} WHERE id = ${id}`,
      ).rejects.toThrow(/conversation_source_type_check/);
    }));
});
