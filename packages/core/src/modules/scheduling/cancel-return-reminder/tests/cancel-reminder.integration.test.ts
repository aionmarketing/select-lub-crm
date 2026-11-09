/**
 * Test design (testing-strategy) — scheduling / cancel-return-reminder, the write
 *
 * Module role: `module_scheduling`. Every call runs `cancelReminder` inside
 * `db.tx("scheduling", …)`, as the route does.
 *
 * Moved from `packages/db/src/return-reminders.live.test.ts`, its
 * `cancelReturnReminderMessage` case, assertions unchanged. That file ran on
 * committed rows; this runs in the rolling-back harness, and NOTHING DEPENDED ON
 * A SECOND CONNECTION: the rows were written and read back through one client.
 *
 * SETUP CHANGED, NOT ASSERTIONS. The reminder used to be created through
 * `createReturnReminderMessage`, another slice now; its three rows are inserted
 * directly at the instants create produced.
 *
 * THE UNKNOWN-MESSAGE THROW IS ITS OWN CASE, LAST. The old case ended by
 * asserting that cancelling an unknown message throws. Inside `db.tx` a throw
 * rolls back to the savepoint, so the transaction survives; it is still kept to
 * a case of its own so the main case's assertions do not depend on that.
 *
 * Oracle: vehicle-returns — "Cancelling a reminder message SHALL cancel every
 *   one of its scheduled messages that has not been sent; rows already SENT are
 *   untouched"; scenario "a reminder message with one SENT and two SCHEDULED
 *   rows is cancelled THEN the two SCHEDULED rows become CANCELLED and the SENT
 *   row is unchanged".
 *
 * And apply-owner-rulings-2026-09-25: each row's `queued` or `blocked` outbox row
 *   is cancelled with it (a blocked one used to stay, and show in the thread, for
 *   ever), and a row whose outbox row is already claimed is left as it is.
 *
 * Axes: A3 scheduled row status at cancel — SCHEDULED / SENT; message known / unknown;
 *   A4 the row's outbox row — none / blocked / claimed
 * Outputs: O4 SCHEDULED rows CANCELLED, the SENT row unchanged; a throw for an unknown message;
 *   O5 blocked outbox row cancelled, claimed one and its schedule untouched
 *
 * Decision map (cancelReminder)
 *   message missing                   T unknown it; F cancel it
 *   status === SCHEDULED (the where)  T the two un-sent rows; F the SENT row
 *   outbox picked up                  T the claimed row; F the blocked and no-row rows
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { cancelReminder } from "../index.js";

const db = () => prisma as PrismaClient;

/** Runs the write the way the route does: one `db.tx` under scheduling's role. */
function cancel(tx: DbClient, reminderMessageId: string) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("scheduling", (t) => cancelReminder(t, reminderMessageId));
}

/** A reminder message with three SCHEDULED rows on an OPEN return. */
async function seedReminder(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({
    data: { unitId: unit.id, origin: "omie", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: `RML-${randomUUID().slice(0, 4)}`, origin: "omie" },
    select: { id: true },
  });
  const service = await tx.service.create({
    data: {
      customerId: customer.id,
      vehicleId: vehicle.id,
      unitId: unit.id,
      performedAt: new Date("2026-03-10T12:00:00.000Z"),
      kind: "troca de óleo",
      origin: "omie",
    },
    select: { id: true },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: new Date("2026-09-10T00:00:00.000Z"), status: "OPEN" },
    select: { id: true },
  });
  const message = await tx.returnReminderMessage.create({
    data: { vehicleReturnId: vehicleReturn.id, bodyTemplate: "Lembrete", createdByUserId: user.id },
    select: { id: true },
  });
  const ids: string[] = [];
  for (const [leadDays, at] of [
    [30, "2026-08-11T12:00:00.000Z"],
    [7, "2026-09-03T12:00:00.000Z"],
    [0, "2026-09-10T12:00:00.000Z"],
  ] as const) {
    const row = await tx.scheduledMessage.create({
      data: {
        customerId: customer.id,
        conversationId: conversation.id,
        serviceId: service.id,
        returnReminderMessageId: message.id,
        leadDays,
        frozenText: "Lembrete",
        scheduledAt: new Date(at),
        status: "SCHEDULED",
        idempotencyKey: randomUUID(),
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return { reminderMessageId: message.id, scheduledMessageIds: ids };
}

describeWithDatabase("cancelReminder", () => {
  it("cancels the un-sent rows of a message and leaves a sent one alone", () =>
    withTestTransaction(db(), async (tx) => {
      const created = await seedReminder(tx);
      const sentId = created.scheduledMessageIds[0] as string;
      const sentAt = new Date("2026-08-11T12:00:00.000Z");
      await tx.scheduledMessage.update({ where: { id: sentId }, data: { status: "SENT", sentAt } });

      const result = await cancel(tx, created.reminderMessageId);

      expect(result.cancelled).toBe(2);
      const sent = await tx.scheduledMessage.findUniqueOrThrow({ where: { id: sentId } });
      // A message that has left cannot be recalled, so nothing about it moves.
      expect(sent.status).toBe("SENT");
      expect(sent.sentAt?.toISOString()).toBe(sentAt.toISOString());
      expect(sent.cancelledAt).toBeNull();
      const others = await tx.scheduledMessage.findMany({
        where: { returnReminderMessageId: created.reminderMessageId, id: { not: sentId } },
      });
      expect(others.every((row) => row.status === "CANCELLED")).toBe(true);
      expect(others.every((row) => row.cancelledAt !== null)).toBe(true);
    }));

  it("cancels a row's blocked outbox row with it, and leaves a row whose outbox row is claimed", () =>
    withTestTransaction(db(), async (tx) => {
      const created = await seedReminder(tx);
      const [blockedId, claimedId, bareId] = created.scheduledMessageIds as [string, string, string];
      const rows = await tx.scheduledMessage.findMany({
        where: { id: { in: [blockedId, claimedId] } },
        select: { id: true, idempotencyKey: true, conversationId: true },
      });
      const keyOf = (id: string) => rows.find((row) => row.id === id)?.idempotencyKey as string;
      const conversationId = rows[0]?.conversationId as string;
      // A due attempt on a down channel: the schedule went back to SCHEDULED
      // with the reason, beside a blocked outbox row.
      await tx.scheduledMessage.update({ where: { id: blockedId }, data: { lastError: "connection_disconnected" } });
      const blocked = await tx.outboxMessage.create({
        data: { conversationId, textBody: "Lembrete", status: "blocked", idempotencyKey: keyOf(blockedId) },
        select: { id: true },
      });
      // The stale-PROCESSING reset: SCHEDULED again while the drain holds the row.
      const claimed = await tx.outboxMessage.create({
        data: { conversationId, textBody: "Lembrete", status: "claimed", idempotencyKey: keyOf(claimedId) },
        select: { id: true, updatedAt: true },
      });

      const result = await cancel(tx, created.reminderMessageId);

      expect(result.cancelled).toBe(2);
      const after = async (id: string) => tx.scheduledMessage.findUniqueOrThrow({ where: { id } });
      const blockedSchedule = await after(blockedId);
      expect(blockedSchedule.status).toBe("CANCELLED");
      // The reminder cancel has never touched the reason; it still does not.
      expect(blockedSchedule.lastError).toBe("connection_disconnected");
      expect((await tx.outboxMessage.findUniqueOrThrow({ where: { id: blocked.id } })).status).toBe("cancelled");
      const claimedSchedule = await after(claimedId);
      expect(claimedSchedule.status).toBe("SCHEDULED");
      expect(claimedSchedule.cancelledAt).toBeNull();
      const claimedAfter = await tx.outboxMessage.findUniqueOrThrow({ where: { id: claimed.id } });
      expect(claimedAfter.status).toBe("claimed");
      expect(claimedAfter.updatedAt).toEqual(claimed.updatedAt);
      expect((await after(bareId)).status).toBe("CANCELLED");
    }));

  it("throws for a reminder message that does not exist", () =>
    withTestTransaction(db(), async (tx) => {
      await expect(cancel(tx, `missing-${randomUUID()}`)).rejects.toThrow(/not found/);
    }));
});
