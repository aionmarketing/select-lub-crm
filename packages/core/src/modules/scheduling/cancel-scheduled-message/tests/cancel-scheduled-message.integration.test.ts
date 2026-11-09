/**
 * Test design (testing-strategy) — scheduling / cancel-scheduled-message
 *
 * Module role: `module_scheduling` for the schedule's read and update; the
 * outbox row is cancelled through channel's `cancelOutbound`, which runs its
 * own `db.tx("channel", …)` joined to the same transaction. Both writes ran
 * under their owners' roles.
 *
 * Moved from `apps/api/src/scheduled.route.test.ts`, assertions unchanged: its
 * four cancel cases (SCHEDULED, the queued outbox row, a SENT row, and a
 * disconnected channel).
 *
 * SUT: `POST /conversations/:id/scheduled-messages/:scheduleId/cancel`,
 *   through `buildSliceApp` with this slice's route only, inside one
 *   rolling-back transaction per test. The LIVE probe is pinned per case, so
 *   nothing here reaches the network.
 *
 * Oracle: scheduled-messages task 2.2 / design D4 — cancel SCHEDULED; reject
 *   SENT; cancel returns 409 when the channel is not CONNECTED. And the
 *   apply-owner-rulings-2026-09-25 delta to "Cancel before send": a schedule,
 *   SCHEDULED or PROCESSING, whose outbox row is claimed, sent or confirmed
 *   answers 409 and both rows stay as they were; no row, or one still queued or
 *   blocked, cancels as before.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   F1 — every cancel case reads the `status` column back out of `tx`, and the
 *     queued-outbox case reads the linked `OutboxMessage.status` back too — the
 *     whole point of the one transaction, since a schedule marked CANCELLED
 *     beside an outbox row still `queued` would still be sent.
 *
 * Axes
 *   A1 channel — CONNECTED / DISCONNECTED
 *   A2 schedule status — SCHEDULED / PROCESSING / SENT
 *   A7 outbox row — none / queued / blocked / claimed / sent / confirmed
 *
 * Outputs
 *   O3 CANCELLED column + cancelled outbox; O4 409
 *
 * Sampled-cell
 *   cancel SCHEDULED            | A2 SCHEDULED     | O3    | column still SCHEDULED
 *   cancel queued outbox        | A2 SCHEDULED A7  | O3    | outbox left queued
 *   cancel SENT                 | A2 SENT          | O4    | 200 CANCELLED
 *   cancel while disconnected   | A1 off           | O4    | column CANCELLED
 *   picked up (3 x 2)           | A2 SCHED+PROC A7 claimed/sent/confirmed | O4, both rows unchanged | 200 CANCELLED
 *   processing, still queued    | A2 PROC A7 queued   | O3 | 409, or outbox left queued
 *   scheduled, blocked          | A2 SCHED A7 blocked | O3 | outbox left blocked
 *
 * Decision map (cancel-scheduled-message)
 *   row miss                    not sampled here — same join as list's 404
 *   probe false                 T disconnected it; F the rest
 *   status === SENT             T SENT it; F SCHEDULED its
 *   compare-and-set miss        not sampled — needs the due tick to send between the read and the write
 *   outbox moved 0 + picked up  T picked-up its; F no-row and queued/blocked its
 *
 * Out of scope: the hook's 401/403 (apps/api/test/scheduling.integration.test.ts).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb, type DbClient } from "../../../../kernel/db.js";
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
import { createRoute } from "../index.js";

const db = () => prisma as PrismaClient;

/** One loja, its connection, a conversation on it, and the attendant. */
async function seedScope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const user = await seedUser(tx, { units: [unit.id] });
  return { unitId: unit.id, userId: user.id, conversationId: conversation.id };
}

/** This slice alone, as the scope's attendant, with the probe pinned. */
async function appOn(tx: DbClient, scope: { unitId: string; userId: string }, connected = true) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) =>
      registerSlice(
        app,
        "scheduling",
        "cancel-scheduled-message",
        createRoute({ channelConnected: async () => connected }),
      ),
    caller: { userId: scope.userId, unitId: scope.unitId },
  });
}

async function insertSchedule(
  tx: DbClient,
  input: { conversationId: string; userId: string; status?: string; idempotencyKey?: string },
) {
  return tx.scheduledMessage.create({
    data: {
      conversationId: input.conversationId,
      frozenText: "Olá",
      scheduledAt: new Date("2099-01-15T15:00:00.000Z"),
      status: input.status ?? "SCHEDULED",
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      createdByUserId: input.userId,
    },
    select: { id: true },
  });
}

/** The `status` column as the database holds it, never a response field. */
function statusOf(tx: DbClient, scheduleId: string) {
  return tx.scheduledMessage.findUniqueOrThrow({
    where: { id: scheduleId },
    select: { status: true, cancelledAt: true },
  });
}

function cancel(app: Awaited<ReturnType<typeof appOn>>, conversationId: string, scheduleId: string) {
  return app.inject({
    method: "POST",
    url: `/conversations/${conversationId}/scheduled-messages/${scheduleId}/cancel`,
  });
}

describeWithDatabase("POST /conversations/:id/scheduled-messages/:scheduleId/cancel", () => {
  it("cancels a SCHEDULED row, and the column says so", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const row = await insertSchedule(tx, { conversationId: scope.conversationId, userId: scope.userId });
      // Precondition: it really is SCHEDULED before the request.
      expect((await statusOf(tx, row.id)).status).toBe("SCHEDULED");
      const app = await appOn(tx, scope);
      try {
        const cancelled = await cancel(app, scope.conversationId, row.id);

        expect(cancelled.statusCode).toBe(200);
        expect(cancelled.json().status).toBe("CANCELLED");
        const persisted = await statusOf(tx, row.id);
        expect(persisted.status).toBe("CANCELLED");
        expect(persisted.cancelledAt).not.toBeNull();
      } finally {
        await app.close();
      }
    }));

  it("cancels the queued outbox row in the same transaction as the schedule", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const key = `sched-ob-${randomUUID()}`;
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        idempotencyKey: key,
      });
      const outbox = await tx.outboxMessage.create({
        data: { conversationId: scope.conversationId, textBody: "Olá", status: "queued", idempotencyKey: key },
        select: { id: true },
      });
      const app = await appOn(tx, scope);
      try {
        const cancelled = await cancel(app, scope.conversationId, row.id);

        expect(cancelled.statusCode).toBe(200);
        expect((await statusOf(tx, row.id)).status).toBe("CANCELLED");
        // Both columns, read back: a schedule marked CANCELLED beside an outbox
        // row still `queued` would still be sent by the drain (F1).
        const persistedOutbox = await tx.outboxMessage.findUniqueOrThrow({
          where: { id: outbox.id },
          select: { status: true },
        });
        expect(persistedOutbox.status).toBe("cancelled");
      } finally {
        await app.close();
      }
    }));

  it("rejects cancel of a SENT row and leaves the column SENT", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        status: "SENT",
      });
      const app = await appOn(tx, scope);
      try {
        const cancelled = await cancel(app, scope.conversationId, row.id);

        expect(cancelled.statusCode).toBe(409);
        const persisted = await statusOf(tx, row.id);
        expect(persisted.status).toBe("SENT");
        expect(persisted.cancelledAt).toBeNull();
      } finally {
        await app.close();
      }
    }));

  it("returns 409 when cancelling while the channel is not CONNECTED, leaving the row SCHEDULED", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const row = await insertSchedule(tx, { conversationId: scope.conversationId, userId: scope.userId });
      const app = await appOn(tx, scope, false);
      try {
        const cancelled = await cancel(app, scope.conversationId, row.id);

        expect(cancelled.statusCode).toBe(409);
        const persisted = await statusOf(tx, row.id);
        expect(persisted.status).toBe("SCHEDULED");
        expect(persisted.cancelledAt).toBeNull();
      } finally {
        await app.close();
      }
    }));

  /** An outbox row for `key`, in `status`, as the drain or the due tick leaves it. */
  async function outboxRow(tx: DbClient, conversationId: string, key: string, status: string) {
    return tx.outboxMessage.create({
      data: {
        conversationId,
        textBody: "Olá",
        status,
        idempotencyKey: key,
        ...(status === "blocked" ? { lastError: "connection_disconnected" } : {}),
        ...(status === "claimed" ? { claimedAt: new Date("2099-01-15T15:00:01.000Z") } : {}),
      },
      select: { id: true },
    });
  }

  function outboxOf(tx: DbClient, id: string) {
    return tx.outboxMessage.findUniqueOrThrow({
      where: { id },
      select: { status: true, updatedAt: true, lastError: true },
    });
  }

  it.each([
    ["PROCESSING", "claimed"],
    ["PROCESSING", "sent"],
    ["PROCESSING", "confirmed"],
    ["SCHEDULED", "claimed"],
    ["SCHEDULED", "sent"],
    ["SCHEDULED", "confirmed"],
  ])("answers 409 for a %s schedule whose outbox row is %s, and changes neither row", (scheduleStatus, outboxStatus) =>
    withTestTransaction(db(), async (tx) => {
      // SCHEDULED beside a claimed row is the stale-PROCESSING reset: the due
      // tick's recovery put the schedule back while the drain still held it.
      const scope = await seedScope(tx);
      const key = `sched-picked-${randomUUID()}`;
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        status: scheduleStatus,
        idempotencyKey: key,
      });
      const outbox = await outboxRow(tx, scope.conversationId, key, outboxStatus);
      const outboxBefore = await outboxOf(tx, outbox.id);
      const app = await appOn(tx, scope);
      try {
        const refused = await cancel(app, scope.conversationId, row.id);

        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toEqual({ state: "CONNECTED" });
        const persisted = await statusOf(tx, row.id);
        expect(persisted.status).toBe(scheduleStatus);
        expect(persisted.cancelledAt).toBeNull();
        expect(await outboxOf(tx, outbox.id)).toEqual(outboxBefore);
      } finally {
        await app.close();
      }
    }),
  );

  it("cancels a PROCESSING schedule whose outbox row is still queued, with that row", () =>
    withTestTransaction(db(), async (tx) => {
      // The due tick queued it but the drain has not claimed it: still stoppable.
      const scope = await seedScope(tx);
      const key = `sched-proc-q-${randomUUID()}`;
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        status: "PROCESSING",
        idempotencyKey: key,
      });
      const outbox = await outboxRow(tx, scope.conversationId, key, "queued");
      const app = await appOn(tx, scope);
      try {
        const cancelled = await cancel(app, scope.conversationId, row.id);

        expect(cancelled.statusCode).toBe(200);
        expect(cancelled.json().status).toBe("CANCELLED");
        expect((await statusOf(tx, row.id)).status).toBe("CANCELLED");
        expect((await outboxOf(tx, outbox.id)).status).toBe("cancelled");
      } finally {
        await app.close();
      }
    }));

  it("cancels a SCHEDULED row beside a blocked outbox row, and the outbox row with it", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const key = `sched-blocked-${randomUUID()}`;
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        idempotencyKey: key,
      });
      const outbox = await outboxRow(tx, scope.conversationId, key, "blocked");
      const app = await appOn(tx, scope);
      try {
        const cancelled = await cancel(app, scope.conversationId, row.id);

        expect(cancelled.statusCode).toBe(200);
        expect((await statusOf(tx, row.id)).status).toBe("CANCELLED");
        expect((await outboxOf(tx, outbox.id)).status).toBe("cancelled");
      } finally {
        await app.close();
      }
    }));
});
