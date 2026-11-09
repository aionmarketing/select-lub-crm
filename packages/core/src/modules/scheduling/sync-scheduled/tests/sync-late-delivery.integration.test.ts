/**
 * Test design (testing-strategy) — scheduling / sync-scheduled, late deliveries
 *
 * SUT: `syncOutboxOutcomes(db)` on the real database inside one rolling-back
 *   transaction per case, over a `FAILED` schedule and its outbox copy.
 *
 * Oracle: `hold-unknown-followups`, scheduled-messages "A scheduled message's send
 *   outcome reaches its schedule": a `FAILED` schedule whose reason is
 *   `send_outcome_unknown` moves to `SENT` once its copy is `confirmed`, even when
 *   a `resend:<id>` copy exists; a refused one never moves; one whose copy is
 *   still `failed` stays.
 *
 * Cases
 *   1. unknown + confirmed copy → SENT, the reason cleared
 *   2. the same with a resend copy present → SENT, the resend untouched
 *   3. a refusal reason + confirmed copy → FAILED (the reason predicate)
 *   4. unknown + failed copy → FAILED (the confirmed predicate)
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

/** A FAILED schedule with `reason`, and its outbox copy in `copyStatus`. */
async function failedWithCopy(tx: DbClient, reason: string, copyStatus: "confirmed" | "failed") {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const key = `late-${randomUUID()}`;
  const schedule = await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      frozenText: "Lembrete",
      scheduledAt: new Date("2026-01-01T12:00:00.000Z"),
      status: "FAILED",
      lastError: reason,
      idempotencyKey: key,
      createdByUserId: user.id,
    },
  });
  const copy = await tx.outboxMessage.create({
    data: { conversationId: conversation.id, textBody: "Lembrete", status: copyStatus, idempotencyKey: key },
  });
  return { scheduleId: schedule.id, copyId: copy.id, conversationId: conversation.id };
}

function scheduleOf(tx: DbClient, id: string) {
  return tx.scheduledMessage.findUniqueOrThrow({ where: { id }, select: { status: true, lastError: true, sentAt: true } });
}

const sync = (tx: DbClient) => syncOutboxOutcomes(createDb(tx, runInTransactionOnTx(tx)));

describeWithDatabase("syncOutboxOutcomes, late deliveries", () => {
  it("records a delivery that arrived after an unknown outcome as sent", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await failedWithCopy(tx, "send_outcome_unknown", "confirmed");

      await sync(tx);

      const schedule = await scheduleOf(tx, r.scheduleId);
      expect(schedule).toMatchObject({ status: "SENT", lastError: null });
      expect(schedule.sentAt).not.toBeNull();
    }));

  it("records it as sent even when the attendant already resent the copy", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await failedWithCopy(tx, "send_outcome_unknown", "confirmed");
      const resend = await tx.outboxMessage.create({
        data: { conversationId: r.conversationId, textBody: "Lembrete", status: "queued", idempotencyKey: `resend:${r.copyId}` },
      });

      await sync(tx);

      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("SENT");
      // The resend is its own message: the sync leaves it as it was.
      expect((await tx.outboxMessage.findUniqueOrThrow({ where: { id: resend.id } })).status).toBe("queued");
    }));

  it("leaves a refused schedule failed, whatever its copy says", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await failedWithCopy(tx, "send_refused_not_on_whatsapp", "confirmed");

      await sync(tx);

      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ status: "FAILED", lastError: "send_refused_not_on_whatsapp" });
    }));

  it("leaves an unknown outcome failed while its copy is still failed", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await failedWithCopy(tx, "send_outcome_unknown", "failed");

      await sync(tx);

      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ status: "FAILED", lastError: "send_outcome_unknown" });
    }));
});
