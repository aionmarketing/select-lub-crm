/**
 * Test design (testing-strategy) — scheduling / archive-vehicle-return
 *
 * Module role: the state read runs under `module_scheduling`; the write goes
 * through `services/contracts/archive-vehicle-return.ts` under
 * `module_services`, which owns `vehicle_return`. The 200 case is therefore also
 * the proof the contract runs under the owner's role: under `module_scheduling` the
 * same update is refused (scheduling-roles.test.ts).
 *
 * New file. The old archive assertions chained several routes (create a
 * reminder, archive, archive again, unarchive) and moved, unchanged, to
 * `apps/api/test/scheduling.integration.test.ts`. These cases drive this slice
 * alone.
 *
 * SUT: `POST /vehicle-returns/:returnId/archive`, through `buildSliceApp` with
 *   this slice's route only, inside one rolling-back transaction per test.
 *
 * Oracle: vehicle-returns — "Archiving SHALL do nothing else ... it SHALL NOT
 *   pause, cancel, move or otherwise touch the return's reminders"; an archived
 *   return is off both Follow-up return sections.
 *
 * Sampled-cell
 *   OPEN return, a reminder on it | 200 {} ARCHIVED, reminder SCHEDULED | a reminder paused
 *   already ARCHIVED              | 409 return_not_open, row unchanged   | 200 claiming it did something
 *   another loja's return         | 404, row unchanged                  | archiving across lojas
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
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

/** An OPEN return in a fresh loja, with one SCHEDULED reminder row, and that loja's attendant. */
async function seedReturn(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({ data: { origin: "crm", status: "active" }, select: { id: true } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm" }, select: { id: true } });
  const service = await tx.service.create({
    data: { customerId: customer.id, vehicleId: vehicle.id, unitId: unit.id, origin: "crm", performedAt: new Date() },
    select: { id: true },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: new Date("2099-01-01T00:00:00.000Z"), status: "OPEN" },
    select: { id: true },
  });
  const message = await tx.returnReminderMessage.create({
    data: { vehicleReturnId: vehicleReturn.id, bodyTemplate: "x", createdByUserId: user.id },
    select: { id: true },
  });
  const reminderRow = await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      returnReminderMessageId: message.id,
      frozenText: "x",
      scheduledAt: new Date("2099-01-01T12:00:00.000Z"),
      status: "SCHEDULED",
      idempotencyKey: randomUUID(),
      createdByUserId: user.id,
    },
    select: { id: true },
  });
  return { unitId: unit.id, userId: user.id, returnId: vehicleReturn.id, reminderRowId: reminderRow.id };
}

async function archive(tx: DbClient, caller: { unitId: string; userId: string }, returnId: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "scheduling", "archive-vehicle-return", route),
    caller: { userId: caller.userId, unitId: caller.unitId },
  });
  try {
    return await app.inject({ method: "POST", url: `/vehicle-returns/${returnId}/archive` });
  } finally {
    await app.close();
  }
}

function returnOf(tx: DbClient, returnId: string) {
  return tx.vehicleReturn.findUniqueOrThrow({
    where: { id: returnId },
    select: { status: true, archivedAt: true, archivedByUserId: true },
  });
}

describeWithDatabase("POST /vehicle-returns/:returnId/archive", () => {
  it("archives an open return, records who did it, and leaves its reminder scheduled", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await seedReturn(tx);

      const response = await archive(tx, r, r.returnId);

      expect(response.statusCode).toBe(200);
      // Empty on purpose: nothing was done to the reminders, so nothing to count back.
      expect(response.json()).toEqual({});
      const row = await returnOf(tx, r.returnId);
      expect(row.status).toBe("ARCHIVED");
      expect(row.archivedAt).not.toBeNull();
      expect(row.archivedByUserId).toBe(r.userId);
      const reminder = await tx.scheduledMessage.findUniqueOrThrow({ where: { id: r.reminderRowId } });
      expect(reminder.status).toBe("SCHEDULED");
    }));

  it("refuses a return that is already archived, leaving it as it was", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await seedReturn(tx);
      await tx.vehicleReturn.update({ where: { id: r.returnId }, data: { status: "ARCHIVED" } });

      const response = await archive(tx, r, r.returnId);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "return_not_open" });
      expect((await returnOf(tx, r.returnId)).archivedByUserId).toBeNull();
    }));

  it("hides another loja's return behind a 404 and does not archive it", () =>
    withTestTransaction(db(), async (tx) => {
      const mine = await seedReturn(tx);
      const theirs = await seedReturn(tx);

      const response = await archive(tx, mine, theirs.returnId);

      expect(response.statusCode).toBe(404);
      expect((await returnOf(tx, theirs.returnId)).status).toBe("OPEN");
    }));
});
