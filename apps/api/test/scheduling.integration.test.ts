/**
 * Test design (testing-strategy) — scheduling at the composition root
 *
 * WHY THIS FILE IS IN apps/api AND NOT IN A SLICE
 *   Each case here drives two or more of scheduling's routes in sequence — create
 *   a reminder then archive, patch then cancel then patch again, archive twice
 *   then unarchive. A slice's tests mount that slice's route alone and may not
 *   import another slice, so these run through the real `buildApp`, which mounts
 *   the whole module behind the real auth hook, one file per module (W2-C9).
 *
 * Moved from `apps/api/src/return-reminders.route.test.ts`, four cases,
 *   assertions unchanged: "refuses a reminder on a return that is not open",
 *   "replaces the moment list and refuses to edit a cancelled message", "cancels
 *   every un-sent row of a message", "archives and unarchives without touching
 *   the reminders". Its six single-route cases moved to the create-return-reminder
 *   slice. The two scheduled-message route files had no hook case and no
 *   multi-route case; all their cases moved to slices.
 *
 * Setup: Fastify inject against the real app on one rolling-back transaction
 *   per test. The caller is a real `user` row with a real membership.
 *   THE CHANNEL PROBE IS PINNED through `buildApp`'s `channelConnected` port, so
 *   nothing here reaches the real Evolution instance; `getUser` is the fake.
 *
 * Oracle: vehicle-returns — "Cancelling a reminder message SHALL cancel every one
 *   of its scheduled messages that has not been sent"; "Archiving SHALL do
 *   nothing else ... it SHALL NOT pause, cancel, move or otherwise touch the
 *   return's reminders". follow-up — Criar lembrete is never blocked by an
 *   existing reminder.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   F1 — the open return is dated 2099, so its planned instants stay ahead of any run.
 *   F3 — every archive assertion reads `VehicleReturn.status` back out of `tx`,
 *     and "archiving touches nothing else" is checked against the reminder's
 *     scheduled rows in the database.
 *
 * Sampled-cell
 *   archived return              | 409 return_not_open        | a live reminder on a hidden row
 *   replace the moment list      | 200, dropped moment CANCELLED; 409 message_cancelled after cancel
 *   cancel                       | 200, every row CANCELLED; 404 unknown
 *   archive then unarchive       | 200 {}, reminders untouched; 409 twice; 404 unknown
 *
 * Out of scope: each route's own answers (the slices' tests).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

const FUTURE_RETURN_DAY = "2099-09-10";
const PERFORMED_AT = new Date("2026-03-10T12:00:00.000Z");
const morning = { hour: 9, minute: 0 };

const db = () => prisma as PrismaClient;

function auth(unitId: string) {
  return { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
}

function appOn(tx: DbClient) {
  return buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
    channelConnected: async () => true,
  });
}

/** `YYYY-MM-DD` as the UTC midnight a `@db.Date` column holds. */
function day(text: string): Date {
  const [year, month, date] = text.split("-").map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, date as number));
}

/** An OPEN return in `unitId`, with its own customer, vehicle and service. */
async function insertReturn(tx: DbClient, unitId: string, returnDay: string) {
  const customer = await tx.customer.create({
    data: { origin: "crm", status: "active", name: "Maria" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, origin: "crm", plate: `AAA-${randomUUID().slice(0, 4)}`, make: "Toyota", model: "Corolla" },
    select: { id: true },
  });
  const service = await tx.service.create({
    data: { customerId: customer.id, vehicleId: vehicle.id, unitId, origin: "crm", kind: "troca de óleo", performedAt: PERFORMED_AT },
    select: { id: true },
  });
  return tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: day(returnDay), status: "OPEN" },
    select: { id: true },
  });
}

/** One loja with a conversation, an open far-future return and a second open one. */
async function seedScope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
  const future = await insertReturn(tx, unit.id, FUTURE_RETURN_DAY);
  const other = await insertReturn(tx, unit.id, "2020-03-01");
  return { unitId: unit.id, conversationId: conversation.id, futureReturnId: future.id, overdueReturnId: other.id };
}

/** The `status` column of a return, as the database holds it (F3). */
async function returnStatus(tx: DbClient, returnId: string) {
  const row = await tx.vehicleReturn.findUniqueOrThrow({ where: { id: returnId }, select: { status: true } });
  return row.status;
}

describeWithDatabase("scheduling through the real app", () => {
  it("refuses a reminder on a return that is not open", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx);
      try {
        const archived = await app.inject({
          method: "POST",
          url: `/vehicle-returns/${scope.futureReturnId}/archive`,
          headers: auth(scope.unitId),
          payload: {},
        });
        expect(archived.statusCode).toBe(200);
        expect(await returnStatus(tx, scope.futureReturnId)).toBe("ARCHIVED");

        const response = await app.inject({
          method: "POST",
          url: `/vehicle-returns/${scope.futureReturnId}/reminders`,
          headers: auth(scope.unitId),
          payload: { conversationId: scope.conversationId, triggers: [{ kind: "before", days: 0, time: morning }] },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: "return_not_open" });
      } finally {
        await app.close();
      }
    }));

  it("replaces the moment list and refuses to edit a cancelled message", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx);
      try {
        const created = await app.inject({
          method: "POST",
          url: `/vehicle-returns/${scope.futureReturnId}/reminders`,
          headers: auth(scope.unitId),
          payload: {
            conversationId: scope.conversationId,
            triggers: [
              { kind: "before", days: 30, time: morning },
              { kind: "before", days: 0, time: morning },
            ],
          },
        });
        expect(created.statusCode).toBe(201);
        const { reminderMessageId } = created.json();

        // Desired set: drop "30 dias antes", keep "no dia", add "7 dias depois".
        const patched = await app.inject({
          method: "PATCH",
          url: `/return-reminders/${reminderMessageId}`,
          headers: auth(scope.unitId),
          payload: {
            triggers: [
              { kind: "before", days: 0, time: morning },
              { kind: "after", days: 7, time: morning },
            ],
          },
        });

        expect(patched.statusCode).toBe(200);
        const rows = patched.json().scheduledMessages as { status: string; scheduledAt: string }[];
        // The dropped moment travels back as CANCELLED rather than vanishing:
        // the screen filters it, and a second fetch to learn what went would
        // cost more.
        expect(rows.filter((row) => row.status === "CANCELLED")).toHaveLength(1);
        expect(rows.filter((row) => row.status === "SCHEDULED").map((row) => row.scheduledAt)).toEqual([
          "2099-09-10T12:00:00.000Z",
          "2099-09-17T12:00:00.000Z",
        ]);
        // The survivor was kept, not recreated: still three rows in total.
        expect(await tx.scheduledMessage.count({ where: { returnReminderMessageId: reminderMessageId } })).toBe(3);

        const cancelled = await app.inject({
          method: "POST",
          url: `/return-reminders/${reminderMessageId}/cancel`,
          headers: auth(scope.unitId),
          payload: {},
        });
        expect(cancelled.statusCode).toBe(200);

        const afterCancel = await app.inject({
          method: "PATCH",
          url: `/return-reminders/${reminderMessageId}`,
          headers: auth(scope.unitId),
          payload: { bodyTemplate: "Outro texto" },
        });

        // Editing something already stopped would quietly bring it back.
        expect(afterCancel.statusCode).toBe(409);
        expect(afterCancel.json()).toEqual({ error: "message_cancelled" });
      } finally {
        await app.close();
      }
    }));

  it("cancels every un-sent row of a message", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx);
      try {
        const created = await app.inject({
          method: "POST",
          url: `/vehicle-returns/${scope.futureReturnId}/reminders`,
          headers: auth(scope.unitId),
          payload: {
            conversationId: scope.conversationId,
            triggers: [
              { kind: "before", days: 30, time: morning },
              { kind: "before", days: 0, time: morning },
            ],
          },
        });
        expect(created.statusCode).toBe(201);
        const { reminderMessageId } = created.json();

        const response = await app.inject({
          method: "POST",
          url: `/return-reminders/${reminderMessageId}/cancel`,
          headers: auth(scope.unitId),
          payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().cancelledAt).not.toBeNull();
        // The columns, not the response array: these are the rows the due tick
        // would otherwise pick up.
        const persisted = await tx.scheduledMessage.findMany({
          where: { returnReminderMessageId: reminderMessageId },
          select: { status: true },
        });
        expect(persisted).toHaveLength(2);
        expect(persisted.every((row) => row.status === "CANCELLED")).toBe(true);

        const unknown = await app.inject({
          method: "POST",
          url: "/return-reminders/nope/cancel",
          headers: auth(scope.unitId),
          payload: {},
        });
        expect(unknown.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));

  it("archives and unarchives without touching the reminders", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx);
      try {
        const created = await app.inject({
          method: "POST",
          url: `/vehicle-returns/${scope.futureReturnId}/reminders`,
          headers: auth(scope.unitId),
          payload: { conversationId: scope.conversationId, triggers: [{ kind: "before", days: 0, time: morning }] },
        });
        expect(created.statusCode).toBe(201);
        const { reminderMessageId } = created.json();

        const archive = (returnId: string) =>
          app.inject({
            method: "POST",
            url: `/vehicle-returns/${returnId}/archive`,
            headers: auth(scope.unitId),
            payload: {},
          });

        const archived = await archive(scope.futureReturnId);

        expect(archived.statusCode).toBe(200);
        // Empty on purpose: nothing was done to the reminders, so there is
        // nothing to count back.
        expect(archived.json()).toEqual({});
        expect(await returnStatus(tx, scope.futureReturnId)).toBe("ARCHIVED");
        // The reminder's rows are exactly as they were, read from the table (F3).
        const afterArchive = await tx.scheduledMessage.findMany({
          where: { returnReminderMessageId: reminderMessageId },
          select: { status: true },
        });
        expect(afterArchive).toHaveLength(1);
        expect(afterArchive[0]?.status).toBe("SCHEDULED");

        // Archiving twice is not a no-op that pretends to work.
        const twice = await archive(scope.futureReturnId);
        expect(twice.statusCode).toBe(409);
        expect(twice.json()).toEqual({ error: "return_not_open" });

        const unarchived = await app.inject({
          method: "POST",
          url: `/vehicle-returns/${scope.futureReturnId}/unarchive`,
          headers: auth(scope.unitId),
          payload: {},
        });

        expect(unarchived.statusCode).toBe(200);
        expect(await returnStatus(tx, scope.futureReturnId)).toBe("OPEN");

        // Unarchiving a live return, and archiving one nobody has.
        const notArchived = await app.inject({
          method: "POST",
          url: `/vehicle-returns/${scope.overdueReturnId}/unarchive`,
          headers: auth(scope.unitId),
          payload: {},
        });
        expect(notArchived.statusCode).toBe(409);
        expect((await archive("nope")).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));
});
