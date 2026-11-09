/**
 * Test design — the seed helpers.
 *
 * Oracle: this change's design D4 (memberships as real rows) and D9 (assert
 * deltas, never counts); spec scenario "Tenancy is enforced by the real join".
 *
 * Decision map
 *   seedUser twice, same id, same tx       T: no unique violation, memberships replaced
 *   seedConversation on a foreign connection
 *     listed under the connection's unit  T: the join, not a flat unitId, decides
 *   every helper's rows                    T: absent after rollback
 *
 * Out of scope: the harness itself (transaction.test.ts).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@select-lub/core/db";
import { describeWithDatabase } from "./gate.js";
import { seedConnection, seedConversation, seedUnit, seedUser } from "./seed.js";
import { withTestTransaction } from "./transaction.js";

describeWithDatabase("seed helpers", () => {
  const db = () => prisma as PrismaClient;

  it("seedUser is idempotent within one transaction and replaces memberships", async () => {
    await withTestTransaction(db(), async (tx) => {
      const a = await seedUnit(tx);
      const b = await seedUnit(tx);
      const id = randomUUID();
      const first = await seedUser(tx, { id, units: [a.id] });
      const second = await seedUser(tx, { id, units: [a.id, b.id] });
      expect(second.id).toBe(first.id);
      const rows = await tx.userUnit.findMany({ where: { userId: id }, select: { unitId: true } });
      expect(rows.map((r) => r.unitId).sort()).toEqual([a.id, b.id].sort());
    });
  });

  it("a conversation belongs to its connection's unit, through the join", async () => {
    await withTestTransaction(db(), async (tx) => {
      const mine = await seedUnit(tx);
      const theirs = await seedUnit(tx);
      const myConnection = await seedConnection(tx, { unitId: mine.id });
      const theirConnection = await seedConnection(tx, { unitId: theirs.id });
      const own = await seedConversation(tx, { connectionId: myConnection.id });
      const foreign = await seedConversation(tx, { connectionId: theirConnection.id });

      const inMyUnit = await tx.conversation.findMany({
        where: { whatsappConnection: { unitId: mine.id } },
        select: { id: true },
      });
      const ids = inMyUnit.map((r) => r.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(foreign.id);
    });
  });

  it("leaves nothing behind after rollback", async () => {
    let unitId = "";
    let userId = "";
    await withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      unitId = unit.id;
      const connection = await seedConnection(tx, { unitId });
      await seedConversation(tx, { connectionId: connection.id });
      userId = (await seedUser(tx, { units: [unitId] })).id;
    });
    expect(await db().unit.findUnique({ where: { id: unitId } })).toBeNull();
    expect(await db().user.findUnique({ where: { id: userId } })).toBeNull();
  });
});
