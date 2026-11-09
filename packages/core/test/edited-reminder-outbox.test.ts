/**
 * Test design (testing-strategy)
 *
 * SUT: an edited reminder and the copy of it waiting to be sent —
 *   scheduling's `moveReminderRow` (through `rewriteUnlessPickedUp`), channel's
 *   drain claim, and the due tick's `dispatchDue` with `enqueueOutbound`'s
 *   reconcile — on the real database inside one rolling-back transaction per
 *   case.
 *
 * Why here: it spans scheduling and channel; `test/` is outside the boundary
 *   rules.
 *
 * Oracle: owner rulings 2026-09-25, PR 6, and the vehicle-returns delta
 *   ("An edit reaches a copy waiting to be sent"; "A reminder moved later is
 *   not sent before its new time") — an edited reminder sends its edited text,
 *   not before its new time; a copy already picked up is left as it is.
 *
 * WHERE A WAITING COPY COMES FROM. `blocked`: a due attempt on a disconnected
 *   channel. `queued` beside a SCHEDULED row: a send that hung past both timers
 *   — the stale-PROCESSING reset put the schedule back to SCHEDULED after 5 min,
 *   and reclaim-stuck returned the claimed copy to `queued` after its 300 s claim
 *   timeout. The fixtures below are those states. Since hold-unknown-outcome-sends
 *   that chain no longer happens (the recovery leaves a claimed copy alone and the
 *   reclaim fails it instead of requeuing), but rows written before it can still
 *   be in that state, so the cases stay.
 *
 * Dates are early 2026, as in the due tick's own tests: `dispatchDue` has no
 *   tenancy predicate, and nothing seeded is due that early.
 *
 * Cases
 *   1. a `queued` copy, the reminder moved a day later: the drain claims
 *      nothing now; at the new time the due tick queues it with the new text.
 *   2. a `blocked` copy, the reminder moved: the copy carries the new text and
 *      the due tick at the new time queues it so.
 *   3. a `claimed` copy: the move writes nothing to the schedule or the copy.
 *   4. a wording edit (`updateReminder`) carries the new text to a `blocked`
 *      copy.
 *   5. belt and braces: a `blocked` copy an edit path did NOT rewrite still
 *      leaves with the schedule's current text — the reconcile's unblock
 *      writes it.
 *   6. a `blocked` copy, the reminder moved EARLIER but still ahead: it keeps
 *      its own reason until the new time, then leaves with the new text.
 *   7. a wording edit on a `queued` copy whose time is past: it stays queued
 *      (no hold) with the new text.
 *
 * THE DUE TICK'S READ-THEN-CLAIM RACE (review of #170). `dispatchDue` reads the
 *   due rows in one transaction and claims each in a later one. Cases 8 and 9
 *   commit an edit between the two, by running it right after the due tick's
 *   first `db.tx` returns:
 *   8. the edit moves the row later: the claim, which re-checks the time, takes
 *      nothing, and the held copy keeps the new text.
 *   9. the edit rewrites only the text: the claim takes the row, and the copy
 *      leaves with the text the row holds at claim time, not the text read.
 *   Mutation-checked against the old claim (no time check, text from the read).
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb, type Db } from "../src/kernel/db.js";
import { claimQueued } from "../src/modules/channel/drain-outbox/index.js";
import { moveReminderRow } from "../src/modules/scheduling/contracts/reminder-rows.js";
import { dispatchDue } from "../src/modules/scheduling/run-due-tick/index.js";
import { updateReminder } from "../src/modules/scheduling/update-return-reminder/index.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../src/testing/index.js";

const db = () => prisma as PrismaClient;

const WAS = new Date("2025-12-31T12:00:00.000Z");
const NOW = new Date("2026-01-01T12:00:00.000Z");
const MOVED = new Date("2026-01-02T12:00:00.000Z");
const AT_THE_NEW_TIME = new Date("2026-01-02T12:00:01.000Z");
const LATER = new Date("2026-01-03T12:00:00.000Z");

function handle(tx: DbClient) {
  return createDb(tx, runInTransactionOnTx(tx));
}

/** A reminder row on an open return, and its copy in `copyStatus` with the old text. */
async function reminderWithCopy(tx: DbClient, copyStatus: "queued" | "blocked" | "claimed", scheduledAt = WAS) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id, connectionState: "CONNECTED" });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({ data: { origin: "crm", status: "active" } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm" } });
  const service = await tx.service.create({
    data: { customerId: customer.id, vehicleId: vehicle.id, unitId: unit.id, origin: "crm", performedAt: new Date("2025-06-30T12:00:00.000Z") },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: new Date("2025-12-31T00:00:00.000Z"), status: "OPEN" },
  });
  const message = await tx.returnReminderMessage.create({
    data: { vehicleReturnId: vehicleReturn.id, bodyTemplate: "Lembrete", createdByUserId: user.id },
  });
  const key = `edited-${randomUUID()}`;
  const row = await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      returnReminderMessageId: message.id,
      leadDays: 0,
      frozenText: "Texto antigo",
      scheduledAt,
      status: "SCHEDULED",
      idempotencyKey: key,
      createdByUserId: user.id,
    },
  });
  const copy = await tx.outboxMessage.create({
    data: {
      conversationId: conversation.id,
      textBody: "Texto antigo",
      status: copyStatus,
      idempotencyKey: key,
      ...(copyStatus === "blocked" ? { lastError: "connection_disconnected" } : {}),
      ...(copyStatus === "claimed" ? { claimedAt: NOW } : {}),
    },
  });
  return { scheduleId: row.id, copyId: copy.id, key, reminderMessageId: message.id, userId: user.id };
}

function copyOf(tx: DbClient, id: string) {
  return tx.outboxMessage.findUniqueOrThrow({
    where: { id },
    select: { status: true, textBody: true, lastError: true, updatedAt: true },
  });
}

/** The due tick's handle, with `edit` committed right after its due read returns, before any claim. */
function editAfterDueRead(tx: DbClient, edit: () => Promise<unknown>): Db {
  const real = handle(tx);
  let calls = 0;
  return {
    client: real.client,
    tx: async (module, fn, runInTransaction) => {
      const result = await real.tx(module, fn, runInTransaction);
      if (++calls === 1) {
        await edit();
      }
      return result;
    },
  };
}

function rewordTo(tx: DbClient, r: { reminderMessageId: string; userId: string }, bodyTemplate: string) {
  return handle(tx).tx("scheduling", (inner) =>
    updateReminder(inner, { reminderMessageId: r.reminderMessageId, bodyTemplate, createdByUserId: r.userId, now: NOW }),
  );
}

function scheduleOf(tx: DbClient, id: string) {
  return tx.scheduledMessage.findUniqueOrThrow({
    where: { id },
    select: { status: true, frozenText: true, scheduledAt: true },
  });
}

describeWithDatabase("an edited reminder and its waiting copy", () => {
  it("holds a queued copy moved a day later, and sends the new text at the new time", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "queued");

      const moved = await moveReminderRow(handle(tx), {
        scheduledMessageId: r.scheduleId,
        scheduledAt: MOVED,
        frozenText: "Texto novo",
        now: NOW,
      });

      expect(moved).toBe(1);
      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ scheduledAt: MOVED, frozenText: "Texto novo" });
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "blocked", textBody: "Texto novo", lastError: "rescheduled" });

      // A drain run now does not take it: it is not due until MOVED.
      const claimed = await claimQueued(handle(tx));
      expect(claimed?.id).not.toBe(r.copyId);
      expect((await copyOf(tx, r.copyId)).status).toBe("blocked");

      // At the new time the due tick claims the schedule and queues the copy.
      await dispatchDue(handle(tx), AT_THE_NEW_TIME);
      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("PROCESSING");
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "queued", textBody: "Texto novo", lastError: null });
    }));

  it("rewrites a blocked copy's text when the reminder is moved, and queues it so at the new time", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "blocked");

      await moveReminderRow(handle(tx), { scheduledMessageId: r.scheduleId, scheduledAt: MOVED, frozenText: "Texto novo", now: NOW });

      // Still blocked for its own reason; only the text moved with the edit.
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "blocked", textBody: "Texto novo", lastError: "connection_disconnected" });
      await dispatchDue(handle(tx), AT_THE_NEW_TIME);
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "queued", textBody: "Texto novo" });
    }));

  it("leaves the schedule and a claimed copy as they are", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "claimed");
      const before = await copyOf(tx, r.copyId);

      const moved = await moveReminderRow(handle(tx), { scheduledMessageId: r.scheduleId, scheduledAt: MOVED, frozenText: "Texto novo", now: NOW });

      expect(moved).toBe(0);
      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ scheduledAt: WAS, frozenText: "Texto antigo", status: "SCHEDULED" });
      expect(await copyOf(tx, r.copyId)).toEqual(before);
    }));

  it("carries a wording edit to the copy waiting blocked", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "blocked");

      const result = await handle(tx).tx("scheduling", (inner) =>
        updateReminder(inner, {
          reminderMessageId: r.reminderMessageId,
          bodyTemplate: "Texto novo",
          createdByUserId: r.userId,
          now: NOW,
        }),
      );

      expect(result).toMatchObject({ status: "ok", rewritten: 1 });
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "blocked", textBody: "Texto novo" });
    }));

  it("sends the schedule's current text even when an edit path left the blocked copy's text alone", () =>
    withTestTransaction(db(), async (tx) => {
      // Belt and braces: the reconcile's unblock writes the due tick's text.
      const r = await reminderWithCopy(tx, "blocked");
      await tx.scheduledMessage.update({ where: { id: r.scheduleId }, data: { frozenText: "Texto novo" } });

      await dispatchDue(handle(tx), NOW);

      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "queued", textBody: "Texto novo" });
    }));

  it("keeps a blocked copy moved earlier blocked for its own reason, and queues the new text at the new time", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "blocked", LATER);

      const moved = await moveReminderRow(handle(tx), { scheduledMessageId: r.scheduleId, scheduledAt: MOVED, frozenText: "Texto novo", now: NOW });

      expect(moved).toBe(1);
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "blocked", textBody: "Texto novo", lastError: "connection_disconnected" });
      // Not due yet at NOW: the tick leaves it.
      await dispatchDue(handle(tx), NOW);
      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("SCHEDULED");
      await dispatchDue(handle(tx), AT_THE_NEW_TIME);
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "queued", textBody: "Texto novo", lastError: null });
    }));

  it("rewrites a queued copy whose time is past without holding it", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "queued");

      expect(await rewordTo(tx, r, "Texto novo")).toMatchObject({ status: "ok", rewritten: 1 });

      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "queued", textBody: "Texto novo", lastError: null });
      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ scheduledAt: WAS, frozenText: "Texto novo", status: "SCHEDULED" });
    }));

  it("does not claim a row an edit moved later between the due read and the claim", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "queued");
      const moveLater = () =>
        moveReminderRow(handle(tx), { scheduledMessageId: r.scheduleId, scheduledAt: MOVED, frozenText: "Texto novo", now: NOW });

      await dispatchDue(editAfterDueRead(tx, moveLater), NOW);

      expect(await scheduleOf(tx, r.scheduleId)).toMatchObject({ status: "SCHEDULED", scheduledAt: MOVED, frozenText: "Texto novo" });
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "blocked", textBody: "Texto novo", lastError: "rescheduled" });
    }));

  it("sends the text the row holds at claim time when an edit rewords it between the due read and the claim", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await reminderWithCopy(tx, "blocked");

      await dispatchDue(editAfterDueRead(tx, () => rewordTo(tx, r, "Texto novo")), NOW);

      expect((await scheduleOf(tx, r.scheduleId)).status).toBe("PROCESSING");
      expect(await copyOf(tx, r.copyId)).toMatchObject({ status: "queued", textBody: "Texto novo" });
    }));
});
