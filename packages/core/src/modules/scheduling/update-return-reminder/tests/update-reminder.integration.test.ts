/**
 * Test design (testing-strategy) — scheduling / update-return-reminder, the write
 *
 * Module role: `module_scheduling`. Every call runs `updateReminder` inside
 * `db.tx("scheduling", …)`, as the route does.
 *
 * Moved from `packages/db/src/return-reminders.live.test.ts`, its four
 * `updateReturnReminderMessage` cases, assertions unchanged. That file ran on
 * committed rows with id-prefix cleanup; these run in the rolling-back harness.
 * NO CASE DEPENDED ON A SECOND CONNECTION: every row was written and read back
 * through the same client.
 *
 * SETUP CHANGED, NOT ASSERTIONS. Each case used to create its reminder through
 * `createReturnReminderMessage` and one cancelled it through
 * `cancelReturnReminderMessage`; those are other slices now, which a slice's
 * tests may not import. The reminder and its rows are inserted directly, at the
 * exact instants and lead days that create produced (09:00 in São Paulo = 12:00Z;
 * 30 days before 2026-09-10 = 2026-08-11, 7 days before = 2026-09-03), and the
 * cancel is a direct `cancelledAt` write. The return, as before, is dated
 * 2026-09-10 on a service performed 2026-03-10, and the clock is injected.
 *
 * Oracle: vehicle-returns — editing a reminder message replaces its un-sent
 *   moments; rows already SENT are untouched; the wording is resolved per row.
 *
 * Axes
 *   A11 what changed — the moment set / only the wording / neither
 *   A12 a desired moment vs the existing rows — matches a live one (survives),
 *       matches a SENT one (dropped), matches none (created), and a live one
 *       matching no desired moment (cancelled)
 *   A13 edit target — live message / cancelled message / unknown
 *   A14 a dropped moment's outbox row — blocked / claimed (apply-owner-rulings-2026-09-25)
 *
 * Outputs
 *   O12 counts of created / cancelled / rewritten
 *   O13 a surviving row keeps its id and its outbox idempotency key
 *   O14 a wording-only edit moves no instant and resolves each row for its own
 *   O15 message_cancelled / not_found / no_triggers refusals
 *   O16 a blocked outbox row cancelled with its dropped moment; a claimed one,
 *       and its moment, left as they are and not counted
 *
 * Sampled-cell
 *   replace the moment set       | A11 moments A12 all four | O12 O13 | a survivor recreated, or a SENT row rewritten
 *   wording only                 | A11 wording              | O14     | instants moved by a text change
 *   desired moment already sent  | A12 sent                 | O12     | a second row at an instant already heard
 *   cancelled / unknown / empty  | A13 A11 neither          | O15     | a cancelled message quietly revived
 *
 * Decision map (updateReminder)
 *   message missing                  T refusals it (unknown); F the rest
 *   message.cancelledAt              T refusals it; F the three edit its
 *   !input.triggers                  T wording-only it; F the replace its
 *   desired.length === 0 && no sent  T refusals it (empty); F every other edit it
 *   existing row at a desired instant T survivor in the replace it; F the created row
 *
 * Out of scope: the plan's arithmetic (shared-types' reminder-plan.test.ts);
 *   the route's scoping and probe (apps/api/test/scheduling.integration.test.ts).
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
import { updateReminder } from "../index.js";

const PERFORMED_AT = new Date("2026-03-10T12:00:00.000Z");
const NOW = new Date("2026-03-11T12:00:00.000Z");
const nine = { hour: 9, minute: 0 };
/** 09:00 in São Paulo on each day the planner resolves against a 2026-09-10 return. */
const AT = {
  thirtyBefore: new Date("2026-08-11T12:00:00.000Z"),
  sevenBefore: new Date("2026-09-03T12:00:00.000Z"),
  onTheDay: new Date("2026-09-10T12:00:00.000Z"),
};

const db = () => prisma as PrismaClient;

/** A loja, attendant, conversation, and a vehicle with a dated service and an OPEN return on 2026-09-10. */
async function seedFixture(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({
    data: { unitId: unit.id, origin: "omie", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: `RML-${randomUUID().slice(0, 4)}`, make: "Toyota", model: "Corolla", origin: "omie" },
    select: { id: true },
  });
  const service = await tx.service.create({
    data: { customerId: customer.id, vehicleId: vehicle.id, unitId: unit.id, performedAt: PERFORMED_AT, kind: "troca de óleo", origin: "omie" },
    select: { id: true },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: new Date("2026-09-10T00:00:00.000Z"), status: "OPEN" },
    select: { id: true },
  });
  return { userId: user.id, customerId: customer.id, serviceId: service.id, conversationId: conversation.id, returnId: vehicleReturn.id };
}

/**
 * Inserts a reminder message with one SCHEDULED row per moment, as create
 * would have written them.
 */
async function seedReminder(
  tx: DbClient,
  f: Awaited<ReturnType<typeof seedFixture>>,
  moments: { leadDays: number; at: Date }[],
) {
  const message = await tx.returnReminderMessage.create({
    data: { vehicleReturnId: f.returnId, bodyTemplate: "Faz {{tempo_decorrido}}.", createdByUserId: f.userId },
    select: { id: true },
  });
  for (const moment of moments) {
    await tx.scheduledMessage.create({
      data: {
        customerId: f.customerId,
        conversationId: f.conversationId,
        serviceId: f.serviceId,
        returnReminderMessageId: message.id,
        leadDays: moment.leadDays,
        frozenText: `Texto de ${moment.at.toISOString()}`,
        scheduledAt: moment.at,
        status: "SCHEDULED",
        idempotencyKey: randomUUID(),
        createdByUserId: f.userId,
      },
    });
  }
  return message.id;
}

function rowsOf(tx: DbClient, reminderMessageId: string) {
  return tx.scheduledMessage.findMany({
    where: { returnReminderMessageId: reminderMessageId },
    orderBy: { scheduledAt: "asc" },
  });
}

/** Runs the write the way the route does: one `db.tx` under scheduling's role. */
function update(tx: DbClient, input: Parameters<typeof updateReminder>[1]) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("scheduling", (t) => updateReminder(t, input));
}

/**
 * A client that lets the due tick claim `rowId` in the gap: just before the
 * edit's FIRST `scheduled_message` write — after it has read the rows as
 * SCHEDULED — the row is flipped to PROCESSING, as the due tick in another
 * process would. Staged in one transaction, deterministically.
 */
function claimedMidEdit(tx: DbClient, rowId: string): DbClient {
  let claimed = false;
  return new Proxy(tx, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "scheduledMessage" || value === null || typeof value !== "object") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return new Proxy(value, {
        get(delegate, method) {
          const fn: unknown = Reflect.get(delegate, method);
          if (typeof fn !== "function") return fn;
          if (method === "update" || method === "updateMany") {
            return async (...args: unknown[]) => {
              if (!claimed) {
                claimed = true;
                await target.scheduledMessage.update({ where: { id: rowId }, data: { status: "PROCESSING" } });
              }
              return fn.apply(delegate, args);
            };
          }
          return fn.bind(delegate);
        },
      });
    },
  });
}

/** `update`, on a client where `rowId` is claimed between the edit's read and its write. */
function updateRacing(tx: DbClient, rowId: string, input: Parameters<typeof updateReminder>[1]) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("scheduling", (t) =>
    updateReminder(claimedMidEdit(t, rowId), input),
  );
}

describeWithDatabase("updateReminder", () => {
  it("replaces the un-sent moments, keeping surviving rows and the sent one", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const reminderMessageId = await seedReminder(tx, f, [
        { leadDays: 30, at: AT.thirtyBefore },
        { leadDays: 7, at: AT.sevenBefore },
        { leadDays: 0, at: AT.onTheDay },
      ]);
      const before = await rowsOf(tx, reminderMessageId);
      const sent = before[0];
      const survivor = before[2];
      if (!sent || !survivor) {
        throw new Error("setup failed: missing rows");
      }
      await tx.scheduledMessage.update({
        where: { id: sent.id },
        data: { status: "SENT", sentAt: new Date("2026-08-11T12:00:00.000Z") },
      });

      // Desired set: keep "no dia", drop "7 dias antes", add "7 dias depois".
      const result = await update(tx, {
        reminderMessageId,
        triggers: [
          { kind: "before", days: 0, time: nine },
          { kind: "after", days: 7, time: nine },
        ],
        createdByUserId: f.userId,
        now: NOW,
      });

      expect(result).toEqual({ status: "ok", created: 1, cancelled: 1, rewritten: 1 });
      const after = await rowsOf(tx, reminderMessageId);
      // The sent row is untouched — instant, text and status.
      const sentAfter = after.find((row) => row.id === sent.id);
      expect(sentAfter?.status).toBe("SENT");
      expect(sentAfter?.frozenText).toBe(sent.frozenText);
      // The survivor kept its ROW, so its outbox idempotency key survived too.
      const survivorAfter = after.find((row) => row.id === survivor.id);
      expect(survivorAfter?.status).toBe("SCHEDULED");
      expect(survivorAfter?.idempotencyKey).toBe(survivor.idempotencyKey);
      // The dropped moment is cancelled rather than deleted.
      expect(after.find((row) => row.id === before[1]?.id)?.status).toBe("CANCELLED");
      // And the new one exists, after the return date.
      expect(
        after.some(
          (row) =>
            row.status === "SCHEDULED" &&
            row.leadDays === -7 &&
            row.scheduledAt.toISOString() === "2026-09-17T12:00:00.000Z",
        ),
      ).toBe(true);
    }));

  it("rewrites every un-sent text when only the wording changes", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const reminderMessageId = await seedReminder(tx, f, [
        { leadDays: 30, at: AT.thirtyBefore },
        { leadDays: 0, at: AT.onTheDay },
      ]);
      const instantsBefore = (await rowsOf(tx, reminderMessageId)).map((row) => row.scheduledAt.toISOString());

      const result = await update(tx, {
        reminderMessageId,
        bodyTemplate: "Passaram {{tempo_decorrido}} desde a última visita.",
        createdByUserId: f.userId,
        now: NOW,
      });

      expect(result).toEqual({ status: "ok", created: 0, cancelled: 0, rewritten: 2 });
      const after = await rowsOf(tx, reminderMessageId);
      // Nothing moved: a wording change is not a scheduling change.
      expect(after.map((row) => row.scheduledAt.toISOString())).toEqual(instantsBefore);
      // Each row is resolved for ITS OWN moment, not for one shared moment.
      expect(after[0]?.frozenText).toBe("Passaram 5 meses desde a última visita.");
      expect(after[1]?.frozenText).toBe("Passaram 6 meses desde a última visita.");
    }));

  it("drops a desired moment that lands on one already sent", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const reminderMessageId = await seedReminder(tx, f, [{ leadDays: 0, at: AT.onTheDay }]);
      await tx.scheduledMessage.updateMany({
        where: { returnReminderMessageId: reminderMessageId },
        data: { status: "SENT", sentAt: NOW },
      });

      // Asking again for the moment that already went out.
      const result = await update(tx, {
        reminderMessageId,
        triggers: [{ kind: "before", days: 0, time: nine }],
        createdByUserId: f.userId,
        now: NOW,
      });

      // Dropped, not duplicated: the customer was told at that moment once.
      expect(result).toEqual({ status: "ok", created: 0, cancelled: 0, rewritten: 0 });
      expect(await tx.scheduledMessage.count({ where: { returnReminderMessageId: reminderMessageId } })).toBe(1);
    }));

  // Review of #145: the rows are read as SCHEDULED and were then cancelled or
  // rewritten by id alone, so a row the due tick claimed in that gap read
  // CANCELLED while its message still went out. Mutation-checked: with the
  // writes by id alone, both cases below fail.
  it("leaves a row the due tick claims mid-edit PROCESSING, and does not count it cancelled", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const reminderMessageId = await seedReminder(tx, f, [
        { leadDays: 30, at: AT.thirtyBefore },
        { leadDays: 7, at: AT.sevenBefore },
        { leadDays: 0, at: AT.onTheDay },
      ]);
      const before = await rowsOf(tx, reminderMessageId);
      const claimed = before[1];
      if (!claimed) {
        throw new Error("setup failed: missing rows");
      }

      // Keep only "no dia": the edit means to cancel "30 dias" and "7 dias",
      // and the due tick claims "7 dias" between the edit's read and its write.
      const result = await updateRacing(tx, claimed.id, {
        reminderMessageId,
        triggers: [{ kind: "before", days: 0, time: nine }],
        createdByUserId: f.userId,
        now: NOW,
      });

      // Only the row that was still SCHEDULED is counted as cancelled.
      expect(result).toEqual({ status: "ok", created: 0, cancelled: 1, rewritten: 1 });
      const claimedAfter = await tx.scheduledMessage.findUniqueOrThrow({ where: { id: claimed.id } });
      expect(claimedAfter.status).toBe("PROCESSING");
      expect(claimedAfter.cancelledAt).toBeNull();
      expect((await tx.scheduledMessage.findUniqueOrThrow({ where: { id: before[0]!.id } })).status).toBe("CANCELLED");
    }));

  it("cancels a dropped moment's blocked outbox row, and leaves a dropped moment whose outbox row is claimed", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const reminderMessageId = await seedReminder(tx, f, [
        { leadDays: 30, at: AT.thirtyBefore },
        { leadDays: 7, at: AT.sevenBefore },
        { leadDays: 0, at: AT.onTheDay },
      ]);
      const [blockedRow, claimedRow] = await rowsOf(tx, reminderMessageId);
      if (!blockedRow || !claimedRow) {
        throw new Error("setup failed: missing rows");
      }
      const blocked = await tx.outboxMessage.create({
        data: { conversationId: f.conversationId, textBody: "x", status: "blocked", idempotencyKey: blockedRow.idempotencyKey },
        select: { id: true },
      });
      // The stale-PROCESSING reset: SCHEDULED again while the drain holds the row.
      const claimed = await tx.outboxMessage.create({
        data: { conversationId: f.conversationId, textBody: "x", status: "claimed", idempotencyKey: claimedRow.idempotencyKey },
        select: { id: true, updatedAt: true },
      });

      // Keep only "no dia": "30 dias" and "7 dias" are dropped.
      const result = await update(tx, {
        reminderMessageId,
        triggers: [{ kind: "before", days: 0, time: nine }],
        createdByUserId: f.userId,
        now: NOW,
      });

      expect(result).toEqual({ status: "ok", created: 0, cancelled: 1, rewritten: 1 });
      expect((await tx.scheduledMessage.findUniqueOrThrow({ where: { id: blockedRow.id } })).status).toBe("CANCELLED");
      expect((await tx.outboxMessage.findUniqueOrThrow({ where: { id: blocked.id } })).status).toBe("cancelled");
      const claimedAfter = await tx.scheduledMessage.findUniqueOrThrow({ where: { id: claimedRow.id } });
      expect(claimedAfter.status).toBe("SCHEDULED");
      expect(claimedAfter.cancelledAt).toBeNull();
      const claimedOutbox = await tx.outboxMessage.findUniqueOrThrow({ where: { id: claimed.id } });
      expect(claimedOutbox.status).toBe("claimed");
      expect(claimedOutbox.updatedAt).toEqual(claimed.updatedAt);
    }));

  it("does not rewrite the text of a row the due tick claims mid-edit", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const reminderMessageId = await seedReminder(tx, f, [
        { leadDays: 30, at: AT.thirtyBefore },
        { leadDays: 0, at: AT.onTheDay },
      ]);
      const before = await rowsOf(tx, reminderMessageId);
      const claimed = before[0];
      if (!claimed) {
        throw new Error("setup failed: missing rows");
      }

      const result = await updateRacing(tx, claimed.id, {
        reminderMessageId,
        bodyTemplate: "Passaram {{tempo_decorrido}} desde a última visita.",
        createdByUserId: f.userId,
        now: NOW,
      });

      // The claimed row goes out with the text it had; only the other is rewritten.
      expect(result).toEqual({ status: "ok", created: 0, cancelled: 0, rewritten: 1 });
      const claimedAfter = await tx.scheduledMessage.findUniqueOrThrow({ where: { id: claimed.id } });
      expect(claimedAfter.status).toBe("PROCESSING");
      expect(claimedAfter.frozenText).toBe(claimed.frozenText);
    }));

  it("refuses to edit a cancelled message, an unknown one, or into an empty set", () =>
    withTestTransaction(db(), async (tx) => {
      const f = await seedFixture(tx);
      const reminderMessageId = await seedReminder(tx, f, [{ leadDays: 0, at: AT.onTheDay }]);

      // A replace that would leave nothing pending and nothing sent is a delete
      // in disguise; cancelling the message is the honest control for that.
      expect(
        await update(tx, { reminderMessageId, triggers: [], createdByUserId: f.userId, now: NOW }),
      ).toEqual({ status: "no_triggers" });

      expect(
        await update(tx, { reminderMessageId: `missing-${randomUUID()}`, createdByUserId: f.userId, now: NOW }),
      ).toEqual({ status: "not_found" });

      await tx.returnReminderMessage.update({ where: { id: reminderMessageId }, data: { cancelledAt: NOW } });
      // Editing something already stopped would quietly bring it back.
      expect(
        await update(tx, { reminderMessageId, bodyTemplate: "Outro texto", createdByUserId: f.userId, now: NOW }),
      ).toEqual({ status: "message_cancelled" });
    }));
});
