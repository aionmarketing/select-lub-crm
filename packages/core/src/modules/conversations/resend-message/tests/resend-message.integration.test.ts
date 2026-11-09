/**
 * Test design (testing-strategy) — conversations / resend-message
 *
 * SUT: `POST /conversations/:id/messages/:messageId/resend`, through
 *   `buildSliceApp` with this slice's route only, inside one rolling-back
 *   transaction, with the LIVE probe a function the test controls. The write is
 *   channel's `resendUnsentOutbound` under `module_channel`.
 *
 * Oracle: `hold-unknown-outcome-sends`, conversas "Attendant can resend a message
 *   that did not go out": a text row `failed`, or `blocked` and sent by the
 *   attendant, is queued again with its own text under `resend:<id>`; a blocked
 *   original is cancelled, a failed one kept; a second press returns the first
 *   copy; anything else is 409 `resend_not_allowed`; another conversation or
 *   loja is 404; a channel down is 409 `DISCONNECTED`; send-now refuses a
 *   `resend:` key.
 *
 * Cases
 *   1. failed (unknown outcome) → 201, a queued copy, the original unchanged
 *   2. blocked, attendant-sent → 201, the original cancelled
 *   3. a second press → the same copy, one row under the key
 *   4. queued / claimed / confirmed → 409 resend_not_allowed, no row
 *   5. a scheduled message's blocked copy → 409, copy and schedule unchanged
 *   6. a failed image → 409 (its bytes are gone)
 *   7. another conversation's row, another loja's thread → 404
 *   8. the probe says down → 409 DISCONNECTED, no row
 *   9. send-now's body schemas refuse a `resend:` key
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
import { sendMediaBodySchema, sendTextBodySchema } from "../../contracts/http.js";
import { createRoute } from "../index.js";

const db = () => prisma as PrismaClient;

type Seeded = { status: string; lastError?: string; messageType?: string; key?: string };

async function outboxRow(tx: DbClient, conversationId: string, seeded: Seeded) {
  return tx.outboxMessage.create({
    data: {
      conversationId,
      messageType: seeded.messageType ?? "text",
      textBody: "Seu carro está pronto",
      status: seeded.status,
      idempotencyKey: seeded.key ?? `resend-test-${randomUUID()}`,
      ...(seeded.lastError ? { lastError: seeded.lastError } : {}),
    },
  });
}

async function setup(tx: DbClient, connected = true) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) =>
      registerSlice(app, "conversations", "resend-message", createRoute({ channelConnected: async () => connected })),
    caller: { userId: "resend-test-caller", unitId: unit.id },
  });
  const resend = (messageId: string, conversationId = conversation.id) =>
    app.inject({ method: "POST", url: `/conversations/${conversationId}/messages/${messageId}/resend` });
  return { unit, connection, conversation, app, resend };
}

function copiesOf(tx: DbClient, id: string) {
  return tx.outboxMessage.findMany({ where: { idempotencyKey: `resend:${id}` } });
}

describeWithDatabase("POST /conversations/:id/messages/:messageId/resend", () => {
  it("queues a copy of an unknown-outcome message and keeps the original as history", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, resend } = await setup(tx);
      const original = await outboxRow(tx, conversation.id, { status: "failed", lastError: "send_outcome_unknown" });

      const response = await resend(original.id);

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ direction: "outbound", textBody: "Seu carro está pronto", outboxStatus: "queued" });
      const copies = await copiesOf(tx, original.id);
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({ id: response.json().id, status: "queued", textBody: "Seu carro está pronto" });
      expect((await tx.outboxMessage.findUniqueOrThrow({ where: { id: original.id } })).status).toBe("failed");
      await app.close();
    }));

  it("releases a blocked attendant send for good: a copy is queued and the original cancelled", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, resend } = await setup(tx);
      const original = await outboxRow(tx, conversation.id, { status: "blocked", lastError: "evolution 404" });

      const response = await resend(original.id);

      expect(response.statusCode).toBe(201);
      expect(await copiesOf(tx, original.id)).toHaveLength(1);
      expect((await tx.outboxMessage.findUniqueOrThrow({ where: { id: original.id } })).status).toBe("cancelled");
      await app.close();
    }));

  it("returns the first copy on a second press instead of queuing another", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, resend } = await setup(tx);
      const original = await outboxRow(tx, conversation.id, { status: "blocked" });

      const first = await resend(original.id);
      const second = await resend(original.id);

      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
      expect(await copiesOf(tx, original.id)).toHaveLength(1);
      await app.close();
    }));

  it.each(["queued", "claimed", "confirmed"])("refuses a %s row, which is still on its way", (status) =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, resend } = await setup(tx);
      const original = await outboxRow(tx, conversation.id, { status });

      const response = await resend(original.id);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "resend_not_allowed" });
      expect(await copiesOf(tx, original.id)).toHaveLength(0);
      await app.close();
    }));

  it("leaves a scheduled message's blocked copy to the due tick", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, conversation, app, resend } = await setup(tx);
      const user = await seedUser(tx, { units: [unit.id] });
      const key = `resend-test-sched-${randomUUID()}`;
      const schedule = await tx.scheduledMessage.create({
        data: {
          conversationId: conversation.id,
          frozenText: "Seu carro está pronto",
          scheduledAt: new Date("2026-01-01T12:00:00.000Z"),
          status: "SCHEDULED",
          idempotencyKey: key,
          createdByUserId: user.id,
        },
      });
      const copy = await outboxRow(tx, conversation.id, { status: "blocked", lastError: "connection_disconnected", key });

      const response = await resend(copy.id);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "resend_not_allowed" });
      expect((await tx.outboxMessage.findUniqueOrThrow({ where: { id: copy.id } })).status).toBe("blocked");
      expect((await tx.scheduledMessage.findUniqueOrThrow({ where: { id: schedule.id } })).status).toBe("SCHEDULED");
      expect(await copiesOf(tx, copy.id)).toHaveLength(0);
      await app.close();
    }));

  it("refuses a failed image: its bytes are gone", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, resend } = await setup(tx);
      const original = await outboxRow(tx, conversation.id, { status: "failed", messageType: "image" });

      const response = await resend(original.id);

      expect(response.statusCode).toBe(409);
      expect(await copiesOf(tx, original.id)).toHaveLength(0);
      await app.close();
    }));

  it("answers 404 for another conversation's row, and for another loja's thread", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversation, app, resend } = await setup(tx);
      const other = await seedConversation(tx, { connectionId: connection.id, chatKey: "5511888888888" });
      const elsewhere = await outboxRow(tx, other.id, { status: "failed" });
      const otherUnit = await seedUnit(tx);
      const otherConnection = await seedConnection(tx, { unitId: otherUnit.id });
      const foreign = await seedConversation(tx, { connectionId: otherConnection.id });
      const foreignRow = await outboxRow(tx, foreign.id, { status: "failed" });

      expect((await resend(elsewhere.id, conversation.id)).statusCode).toBe(404);
      expect((await resend(foreignRow.id, foreign.id)).statusCode).toBe(404);
      expect(await copiesOf(tx, elsewhere.id)).toHaveLength(0);
      expect(await copiesOf(tx, foreignRow.id)).toHaveLength(0);
      await app.close();
    }));

  it("answers 409 DISCONNECTED while the live probe says the channel is down", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, resend } = await setup(tx, false);
      const original = await outboxRow(tx, conversation.id, { status: "failed" });

      const response = await resend(original.id);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ state: "DISCONNECTED" });
      expect(await copiesOf(tx, original.id)).toHaveLength(0);
      await app.close();
    }));
});

it("send-now refuses an idempotency key in the resend namespace", () => {
  expect(sendTextBodySchema.safeParse({ text: "oi", idempotencyKey: "resend:abc" }).success).toBe(false);
  expect(sendMediaBodySchema.safeParse({ messageType: "image", idempotencyKey: "resend:abc" }).success).toBe(false);
  // Control: an ordinary key still passes.
  expect(sendTextBodySchema.safeParse({ text: "oi", idempotencyKey: "abc-resend:1" }).success).toBe(true);
});
