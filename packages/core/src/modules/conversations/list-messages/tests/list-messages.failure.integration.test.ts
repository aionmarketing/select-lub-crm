/**
 * Test design (testing-strategy) — conversations / list-messages, the failure kind
 *
 * SUT: `GET /conversations/:id/messages` through `buildSliceApp`, inside one
 *   rolling-back transaction, reading outbox rows seeded in each state.
 *
 * Oracle: `hold-unknown-outcome-sends`, conversas "Thread shows outbound delivery
 *   status" and design D4: `outboxFailure` is `outcome_unknown` on a `failed` row
 *   with `send_outcome_unknown`, `not_sent` on any other `failed` row and on a
 *   `blocked` row the attendant sent, and absent on a scheduled message's blocked
 *   copy and on every other status.
 *
 * One case reads all six rows from one thread, so a constant producer cannot pass
 * it: the expected kinds differ row by row.
 */
import { randomUUID } from "node:crypto";
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
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { conversationMessageListSchema } from "../../contracts/http.js";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

describeWithDatabase("GET /conversations/:id/messages failure kinds", () => {
  it("labels each outbox row by what its failure proves", () =>
    withTestTransaction(db(), async (tx: DbClient) => {
      const unit = await seedUnit(tx);
      const user = await seedUser(tx, { units: [unit.id] });
      const connection = await seedConnection(tx, { unitId: unit.id });
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const scheduledKey = `failure-kind-${randomUUID()}`;
      await tx.scheduledMessage.create({
        data: {
          conversationId: conversation.id,
          frozenText: "reminder",
          scheduledAt: new Date("2026-01-01T12:00:00.000Z"),
          status: "PROCESSING",
          idempotencyKey: scheduledKey,
          createdByUserId: user.id,
        },
      });
      const rows: { text: string; status: string; lastError?: string; key?: string }[] = [
        { text: "unknown", status: "failed", lastError: "send_outcome_unknown" },
        { text: "refused", status: "failed", lastError: "send_refused_not_on_whatsapp" },
        { text: "attendant-blocked", status: "blocked", lastError: "evolution 404" },
        { text: "reminder-blocked", status: "blocked", lastError: "connection_disconnected", key: scheduledKey },
        { text: "queued", status: "queued" },
        { text: "cancelled", status: "cancelled" },
      ];
      let at = Date.parse("2026-01-01T13:00:00.000Z");
      for (const row of rows) {
        await tx.outboxMessage.create({
          data: {
            conversationId: conversation.id,
            textBody: row.text,
            status: row.status,
            idempotencyKey: row.key ?? `failure-kind-${randomUUID()}`,
            createdAt: new Date((at += 1_000)),
            ...(row.lastError ? { lastError: row.lastError } : {}),
          },
        });
      }
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "list-messages", route),
        caller: { userId: "failure-kind-caller", unitId: unit.id },
      });

      const response = await app.inject({ method: "GET", url: `/conversations/${conversation.id}/messages` });

      expect(response.statusCode).toBe(200);
      const thread = conversationMessageListSchema.parse(response.json());
      const kinds = Object.fromEntries(thread.map((message) => [message.textBody, message.outboxFailure ?? null]));
      expect(kinds).toEqual({
        unknown: "outcome_unknown",
        refused: "not_sent",
        "attendant-blocked": "not_sent",
        "reminder-blocked": null,
        queued: null,
        cancelled: null,
      });
      await app.close();
    }));

  it("marks a failed or cancelled message already resent, and only those (hold-unknown-followups)", () =>
    withTestTransaction(db(), async (tx: DbClient) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id });
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const row = (textBody: string, status: string, at: string) =>
        tx.outboxMessage.create({
          data: {
            conversationId: conversation.id,
            textBody,
            status,
            ...(status === "failed" ? { lastError: "send_outcome_unknown" } : {}),
            idempotencyKey: `resent-${randomUUID()}`,
            createdAt: new Date(at),
          },
        });
      const resent = await row("resent", "failed", "2026-01-01T13:00:00.000Z");
      await row("not-resent", "failed", "2026-01-01T13:01:00.000Z");
      // A blocked original the resend cancelled, and one cancelled without a resend.
      const replaced = await row("replaced", "cancelled", "2026-01-01T13:02:00.000Z");
      await row("cancelled", "cancelled", "2026-01-01T13:03:00.000Z");
      // The copies have gone out already, so they are not among the thread's pending rows.
      for (const original of [resent, replaced]) {
        await tx.outboxMessage.create({
          data: { conversationId: conversation.id, textBody: original.textBody, status: "confirmed", idempotencyKey: `resend:${original.id}` },
        });
      }
      const app = await buildSliceApp({
        db: createDb(tx, runInTransactionOnTx(tx)),
        plugin: (app) => registerSlice(app, "conversations", "list-messages", route),
        caller: { userId: "resent-caller", unitId: unit.id },
      });

      const response = await app.inject({ method: "GET", url: `/conversations/${conversation.id}/messages` });

      const thread = conversationMessageListSchema.parse(response.json());
      expect(thread.map((message) => [message.textBody, message.outboxResent ?? null])).toEqual([
        ["resent", true],
        ["not-resent", null],
        ["replaced", true],
        ["cancelled", null],
      ]);
      await app.close();
    }));
});
