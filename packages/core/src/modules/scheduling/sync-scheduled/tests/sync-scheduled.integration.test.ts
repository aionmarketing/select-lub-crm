/**
 * Test design (testing-strategy) — scheduling / sync-scheduled
 *
 * Module role: `module_scheduling`. `syncOutboxOutcomes` reads
 * `outbox_message` (channel's, `readableBy`) and writes only `scheduled_message`,
 * each row in its own `db.tx("scheduling", …)`.
 *
 * New file. The old `apps/worker/src/scheduled/due.test.ts` reached the sync
 * only through a full due → drain → sync round trip (now in
 * `apps/worker/test/scheduling-wiring.test.ts`); these cases drive the sync alone,
 * with the outbox row's outcome written directly.
 *
 * Setup: one PROCESSING schedule and its outbox row, inside one rolling-back
 * transaction per test.
 *
 * Oracle: scheduled-messages — a confirmed send marks the schedule SENT; a
 *   failed one FAILED with the reason; the api's cancel is not undone.
 *
 * Axes
 *   A1 outbox status — confirmed / failed / still queued
 *   A2 schedule status — PROCESSING / CANCELLED (changed after the read)
 *
 * Outputs
 *   SENT with sentAt; FAILED with the outbox's reason; unchanged
 *
 * Sampled-cell
 *   confirmed outbox             | A1 confirmed A2 PROCESSING | SENT    | left PROCESSING
 *   failed outbox                | A1 failed A2 PROCESSING    | FAILED  | reason lost
 *   queued outbox                | A1 queued                  | unchanged | SENT before the send
 *   cancelled schedule, confirmed outbox | A2 CANCELLED       | unchanged | SENT written over a cancel
 *
 * Decision map (syncOutboxOutcomes)
 *   outbox confirmed         T confirmed it; F the rest
 *   outbox failed            T failed it; F the rest
 *   read selects PROCESSING  F cancelled it
 *
 * NOT TESTED HERE, AND WHY: the compare-and-set in the update (`status:
 * "PROCESSING"` in its `where`) guards a cancel that lands BETWEEN the sync's
 * read and its write. Staging that needs a second connection writing mid-call,
 * which the single-transaction harness cannot do. The cancelled case below
 * pins the read's selection instead; it would pass without the compare-and-set.
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
import { syncOutboxOutcomes } from "../index.js";

const db = () => prisma as PrismaClient;

/** A PROCESSING schedule and its outbox row in `outboxStatus`. */
async function seedSent(tx: DbClient, outboxStatus: string, lastError: string | null = null) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const idempotencyKey = `sync-${randomUUID()}`;
  await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      frozenText: "Olá",
      scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "PROCESSING",
      idempotencyKey,
      createdByUserId: user.id,
    },
  });
  await tx.outboxMessage.create({
    data: { conversationId: conversation.id, textBody: "Olá", status: outboxStatus, lastError, idempotencyKey },
  });
  return idempotencyKey;
}

function sync(tx: DbClient) {
  return syncOutboxOutcomes(createDb(tx, runInTransactionOnTx(tx)));
}

function scheduleOf(tx: DbClient, idempotencyKey: string) {
  return tx.scheduledMessage.findUniqueOrThrow({ where: { idempotencyKey } });
}

describeWithDatabase("syncOutboxOutcomes", () => {
  it("marks a PROCESSING schedule SENT when its outbox row is confirmed", () =>
    withTestTransaction(db(), async (tx) => {
      const key = await seedSent(tx, "confirmed");

      await sync(tx);

      const row = await scheduleOf(tx, key);
      expect(row.status).toBe("SENT");
      expect(row.sentAt).not.toBeNull();
      expect(row.lastError).toBeNull();
    }));

  it("marks it FAILED with the outbox's reason when the send failed", () =>
    withTestTransaction(db(), async (tx) => {
      const key = await seedSent(tx, "failed", "Evolution respondeu 463");

      await sync(tx);

      const row = await scheduleOf(tx, key);
      expect(row.status).toBe("FAILED");
      expect(row.lastError).toBe("Evolution respondeu 463");
    }));

  it("leaves it PROCESSING while the outbox row is still in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const key = await seedSent(tx, "queued");

      await sync(tx);

      expect((await scheduleOf(tx, key)).status).toBe("PROCESSING");
    }));

  it("does not write SENT over a schedule the api cancelled", () =>
    withTestTransaction(db(), async (tx) => {
      // The api cancelled the schedule after its outbox row was confirmed; the
      // sync must not turn the cancel into SENT. This pins the read's
      // selection — see the header for the race it does not stage.
      const key = await seedSent(tx, "confirmed");
      await tx.scheduledMessage.update({ where: { idempotencyKey: key }, data: { status: "CANCELLED" } });

      await sync(tx);

      expect((await scheduleOf(tx, key)).status).toBe("CANCELLED");
    }));
});
