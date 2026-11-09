/**
 * Test design (testing-strategy) — scheduling's reminder-row contracts
 *
 * SUT: `moveReminderRow`, `cancelReminderRow` and `cancelRemindersOfReturns`
 *   (`modules/scheduling/contracts/reminder-rows.ts`), the three
 *   `scheduled_message` writes `services` will make in 3C.
 *
 * Why here and not beside the contracts: a test under `contracts/` is a
 *   `contracts` element to the boundary rules and may not import the harness.
 *   `packages/core/test/` is outside those rules, as the kernel's own role test
 *   is.
 *
 * Requirement (3B, ruling Q3): each write is compare-and-set on `SCHEDULED`. So
 *   for each contract, one case where the row is still `SCHEDULED` (the positive
 *   control: the write lands and the call says so) and one where it has already
 *   left — `PROCESSING`, claimed by the due tick — where the call returns 0 and
 *   changes nothing. These CAN fail: the contracts do not read the row first, so
 *   a `where` without the status would move or cancel the PROCESSING row.
 *
 * And: each runs under `module_scheduling` whoever calls it. The last case calls
 *   one from inside a `db.tx("services", …)`, as 3C will, to show it joins that
 *   transaction and is not refused.
 *
 * And (apply-owner-rulings-2026-09-25): both cancels take the row's `queued` or
 *   `blocked` outbox row with them — a blocked one used to stay, and show in the
 *   thread, for ever — and a SCHEDULED row whose outbox row is already claimed
 *   (the stale-PROCESSING reset) counts as dispatched: 0, nothing written. The
 *   nested case shows the outbox write still lands under channel's role from
 *   inside services' transaction, three roles deep, as the Omie reconcile runs it.
 *
 * Setup: one reminder message on one return, with rows inserted directly, inside
 *   one rolling-back transaction per test.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb } from "../src/kernel/db.js";
import {
  cancelReminderRow,
  cancelRemindersOfReturns,
  moveReminderRow,
} from "../src/modules/scheduling/contracts/reminder-rows.js";
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
const WAS = new Date("2099-09-10T12:00:00.000Z");
const MOVED = new Date("2099-09-24T12:00:00.000Z");

/** A return with a reminder message; `rows` statuses become one scheduled row each. */
async function seedReminder(tx: DbClient, statuses: string[]) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({ data: { origin: "crm", status: "active" }, select: { id: true } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm" }, select: { id: true } });
  const service = await tx.service.create({
    data: { customerId: customer.id, vehicleId: vehicle.id, unitId: unit.id, origin: "crm", performedAt: new Date("2099-03-10T12:00:00.000Z") },
    select: { id: true },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: new Date("2099-09-10T00:00:00.000Z"), status: "OPEN" },
    select: { id: true },
  });
  const message = await tx.returnReminderMessage.create({
    data: { vehicleReturnId: vehicleReturn.id, bodyTemplate: "Lembrete", createdByUserId: user.id },
    select: { id: true },
  });
  const ids: string[] = [];
  for (const [index, status] of statuses.entries()) {
    const row = await tx.scheduledMessage.create({
      data: {
        conversationId: conversation.id,
        returnReminderMessageId: message.id,
        leadDays: index,
        frozenText: "Texto antigo",
        scheduledAt: new Date(WAS.getTime() - index * 86_400_000),
        status,
        idempotencyKey: randomUUID(),
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return { returnId: vehicleReturn.id, ids };
}

function handle(tx: DbClient) {
  return createDb(tx, runInTransactionOnTx(tx));
}

/** An outbox row for scheduled row `id`, in `status`, on the row's own key. */
async function outboxFor(tx: DbClient, id: string, status: string) {
  const row = await tx.scheduledMessage.findUniqueOrThrow({
    where: { id },
    select: { idempotencyKey: true, conversationId: true },
  });
  return tx.outboxMessage.create({
    data: { conversationId: row.conversationId as string, textBody: "Texto antigo", status, idempotencyKey: row.idempotencyKey },
    select: { id: true, updatedAt: true },
  });
}

function outboxStatus(tx: DbClient, id: string) {
  return tx.outboxMessage.findUniqueOrThrow({ where: { id }, select: { status: true, updatedAt: true } });
}

function rowOf(tx: DbClient, id: string) {
  return tx.scheduledMessage.findUniqueOrThrow({
    where: { id },
    select: { status: true, scheduledAt: true, frozenText: true, lastError: true, cancelledAt: true },
  });
}

describeWithDatabase("moveReminderRow", () => {
  it("moves a SCHEDULED row to its new instant and text, and returns 1", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids } = await seedReminder(tx, ["SCHEDULED"]);
      const id = ids[0] as string;

      const moved = await moveReminderRow(handle(tx), { scheduledMessageId: id, scheduledAt: MOVED, frozenText: "Texto novo" });

      expect(moved).toBe(1);
      const row = await rowOf(tx, id);
      expect(row.scheduledAt.toISOString()).toBe(MOVED.toISOString());
      expect(row.frozenText).toBe("Texto novo");
    }));

  it("returns 0 and changes nothing for a row the due tick has claimed", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids } = await seedReminder(tx, ["PROCESSING"]);
      const id = ids[0] as string;

      const moved = await moveReminderRow(handle(tx), { scheduledMessageId: id, scheduledAt: MOVED, frozenText: "Texto novo" });

      expect(moved).toBe(0);
      const row = await rowOf(tx, id);
      expect(row.status).toBe("PROCESSING");
      expect(row.scheduledAt.toISOString()).toBe(WAS.toISOString());
      expect(row.frozenText).toBe("Texto antigo");
    }));
});

describeWithDatabase("cancelReminderRow", () => {
  it("cancels a SCHEDULED row with its reason, and returns 1", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids } = await seedReminder(tx, ["SCHEDULED"]);
      const id = ids[0] as string;

      const cancelled = await cancelReminderRow(handle(tx), { scheduledMessageId: id, at: WAS, reason: "No passado." });

      expect(cancelled).toBe(1);
      const row = await rowOf(tx, id);
      expect(row.status).toBe("CANCELLED");
      expect(row.lastError).toBe("No passado.");
      expect(row.cancelledAt).not.toBeNull();
    }));

  it("returns 0 and changes nothing for a row the due tick has claimed", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids } = await seedReminder(tx, ["PROCESSING"]);
      const id = ids[0] as string;

      const cancelled = await cancelReminderRow(handle(tx), { scheduledMessageId: id, at: WAS, reason: "No passado." });

      expect(cancelled).toBe(0);
      const row = await rowOf(tx, id);
      expect(row.status).toBe("PROCESSING");
      expect(row.lastError).toBeNull();
      expect(row.cancelledAt).toBeNull();
    }));
});

describeWithDatabase("cancelReminderRow and the outbox row", () => {
  it("cancels a blocked outbox row with its schedule", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids } = await seedReminder(tx, ["SCHEDULED"]);
      const id = ids[0] as string;
      const blocked = await outboxFor(tx, id, "blocked");

      const cancelled = await cancelReminderRow(handle(tx), { scheduledMessageId: id, at: WAS, reason: "No passado." });

      expect(cancelled).toBe(1);
      const row = await rowOf(tx, id);
      expect(row.status).toBe("CANCELLED");
      expect(row.lastError).toBe("No passado.");
      expect((await outboxStatus(tx, blocked.id)).status).toBe("cancelled");
    }));

  it("returns 0 and changes nothing for a SCHEDULED row whose outbox row is claimed", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids } = await seedReminder(tx, ["SCHEDULED"]);
      const id = ids[0] as string;
      const claimed = await outboxFor(tx, id, "claimed");

      const cancelled = await cancelReminderRow(handle(tx), { scheduledMessageId: id, at: WAS, reason: "No passado." });

      expect(cancelled).toBe(0);
      const row = await rowOf(tx, id);
      expect(row.status).toBe("SCHEDULED");
      expect(row.cancelledAt).toBeNull();
      expect(row.lastError).toBeNull();
      expect(await outboxStatus(tx, claimed.id)).toEqual({ status: "claimed", updatedAt: claimed.updatedAt });
    }));
});

describeWithDatabase("cancelRemindersOfReturns", () => {
  it("cancels the return's SCHEDULED rows and counts only them", () =>
    withTestTransaction(db(), async (tx) => {
      const { returnId, ids } = await seedReminder(tx, ["SCHEDULED", "SCHEDULED"]);

      const result = await cancelRemindersOfReturns(handle(tx), { vehicleReturnIds: [returnId], at: WAS, reason: "Substituído." });

      expect(result).toEqual({ cancelled: 2 });
      for (const id of ids) {
        expect((await rowOf(tx, id)).status).toBe("CANCELLED");
      }
    }));

  it("leaves a claimed row and a sent one alone, cancelling only the SCHEDULED one", () =>
    withTestTransaction(db(), async (tx) => {
      const { returnId, ids } = await seedReminder(tx, ["SCHEDULED", "PROCESSING", "SENT"]);

      const result = await cancelRemindersOfReturns(handle(tx), { vehicleReturnIds: [returnId], at: WAS, reason: "Substituído." });

      expect(result).toEqual({ cancelled: 1 });
      expect((await rowOf(tx, ids[0] as string)).status).toBe("CANCELLED");
      expect((await rowOf(tx, ids[1] as string)).status).toBe("PROCESSING");
      expect((await rowOf(tx, ids[2] as string)).status).toBe("SENT");
    }));

  it("cancels a row's blocked outbox row with it, and leaves a row whose outbox row is claimed", () =>
    withTestTransaction(db(), async (tx) => {
      const { returnId, ids } = await seedReminder(tx, ["SCHEDULED", "SCHEDULED"]);
      const blocked = await outboxFor(tx, ids[0] as string, "blocked");
      const claimed = await outboxFor(tx, ids[1] as string, "claimed");

      const result = await cancelRemindersOfReturns(handle(tx), { vehicleReturnIds: [returnId], at: WAS, reason: "Substituído." });

      expect(result).toEqual({ cancelled: 1 });
      expect((await rowOf(tx, ids[0] as string)).status).toBe("CANCELLED");
      expect((await outboxStatus(tx, blocked.id)).status).toBe("cancelled");
      const left = await rowOf(tx, ids[1] as string);
      expect(left.status).toBe("SCHEDULED");
      expect(left.lastError).toBeNull();
      expect(await outboxStatus(tx, claimed.id)).toEqual({ status: "claimed", updatedAt: claimed.updatedAt });
    }));

  it("cancels nothing for an empty list of returns", () =>
    withTestTransaction(db(), async (tx) => {
      const { ids } = await seedReminder(tx, ["SCHEDULED"]);

      expect(await cancelRemindersOfReturns(handle(tx), { vehicleReturnIds: [], at: WAS, reason: "x" })).toEqual({ cancelled: 0 });
      expect((await rowOf(tx, ids[0] as string)).status).toBe("SCHEDULED");
    }));
});

describeWithDatabase("reminder-row contracts inside services' transaction", () => {
  it("joins a db.tx(\"services\") and writes under scheduling's role", () =>
    withTestTransaction(db(), async (tx) => {
      // How 3C will call it: from inside its own services transaction, on a
      // handle over that transaction. Under module_services alone this write
      // would be refused; the contract puts scheduling's role on for it.
      const { ids } = await seedReminder(tx, ["SCHEDULED"]);
      const id = ids[0] as string;

      const moved = await handle(tx).tx("services", (inner) =>
        moveReminderRow(createDb(inner), { scheduledMessageId: id, scheduledAt: MOVED, frozenText: "Texto novo" }),
      );

      expect(moved).toBe(1);
      expect((await rowOf(tx, id)).scheduledAt.toISOString()).toBe(MOVED.toISOString());
    }));

  it("cancels a superseded return's blocked outbox row from inside services' transaction, under channel's role", () =>
    withTestTransaction(db(), async (tx) => {
      // services -> scheduling -> channel, as reconcileVehicleReturns runs it.
      // Under module_services or module_scheduling the outbox write would be
      // refused, so the row landing `cancelled` is the proof each role was put
      // on and restored in turn.
      const { returnId, ids } = await seedReminder(tx, ["SCHEDULED"]);
      const blocked = await outboxFor(tx, ids[0] as string, "blocked");

      const result = await handle(tx).tx("services", (inner) =>
        cancelRemindersOfReturns(createDb(inner), { vehicleReturnIds: [returnId], at: WAS, reason: "Substituído." }),
      );

      expect(result).toEqual({ cancelled: 1 });
      expect((await outboxStatus(tx, blocked.id)).status).toBe("cancelled");
      expect((await rowOf(tx, ids[0] as string)).status).toBe("CANCELLED");
    }));
});
