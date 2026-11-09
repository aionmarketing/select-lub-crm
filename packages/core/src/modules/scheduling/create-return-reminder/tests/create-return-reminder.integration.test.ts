/**
 * Test design (testing-strategy) — scheduling / create-return-reminder
 *
 * Module role: `module_scheduling`. The scope reads and the write (one
 * `return_reminder_message`, one `scheduled_message` per trigger) run in
 * `db.tx("scheduling", …)`; `vehicle_return`, `service` and `vehicle` are read
 * under `readableBy`.
 *
 * Moved from `apps/api/src/return-reminders.route.test.ts`, assertions
 * unchanged: its six single-route create cases (three moments, another loja,
 * channel down, overdue return, duplicate instant, empty list). Its four cases
 * that drive a second route — archive before create, patch, cancel, and archive
 * with unarchive — moved to `apps/api/test/scheduling.integration.test.ts`,
 * which mounts every scheduling route through the real `buildApp`.
 *
 * SUT: `POST /vehicle-returns/:returnId/reminders`, through `buildSliceApp` with
 *   this slice's route only, inside one rolling-back transaction per test. The
 *   write is the one moved from `packages/db/src/return-reminders.ts`, run on
 *   the slice's own transaction rather than a nested one.
 *
 *   THE CHANNEL PROBE IS PINNED per case, so nothing here reaches the network.
 *
 * Oracle: vehicle-returns — "Confirming SHALL create one scheduled message per
 *   trigger"; "confirm SHALL be blocked with a Portuguese reason when the
 *   customer's conversation channel is not CONNECTED".
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   F1 — the clock: the open return is dated 2099 and the overdue one 2020, so
 *     "ahead of now" and "behind now" are properties of the fixture rather than
 *     of the day the suite runs.
 *   F2 — ownership is the join `vehicleReturn → sourceService → unitId`, and the
 *     another-loja case hangs a real return off a real second loja's service.
 *
 * Axes
 *   A1 unit — the caller's own return / another loja's / an unknown id
 *   A2 channel — CONNECTED / not
 *   A4 trigger set vs now — all ahead / one already past / two on one instant / empty
 *   A5 return date vs today — future / ALREADY PASSED
 *
 * Outputs
 *   O1 201 with the message and one scheduled row per trigger; O2 404;
 *   O3 409 { state: "DISCONNECTED" }; O4 409 { error, at }; O8 400
 *
 * Sampled-cell
 *   create, three moments        | A1 own A2 up A4 ahead | O1 | a row lost, or a shared text
 *   another loja's return        | A1 other, unknown     | O2 | 403, leaking that it exists
 *   channel down                 | A2 down               | O3, none written | 201
 *   overdue return, before-0     | A5 passed             | O4 | 201, then a reminder that never fires
 *   overdue return, absolute     | A5 passed             | O1 | 409, blocking the busiest section
 *   two moments, one instant     | A4 duplicate          | O4 | two rows the unique index rejects
 *   empty triggers               | A4 empty              | O8 | a message nobody will ever send
 *
 * Decision map (create-return-reminder)
 *   !unitId || !userId          contract-hidden — the hook 403s first
 *   scope miss                  T other-loja and unknown; F the rest
 *   probe false                 T channel-down; F the rest
 *   plan refusal                T overdue before-0, duplicate; F the rest
 *
 * Out of scope: the planner's own BVA (reminder-plan tests in shared-types);
 *   the due tick that sends the rows.
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

/**
 * The open return is dated in 2099 and the overdue one in 2020 (F1).
 * America/Sao_Paulo has had no DST since 2019, so 09:00 there is 12:00Z and
 * 14:30 is 17:30Z, and the planned instants below are exact.
 */
const FUTURE_RETURN_DAY = "2099-09-10";
const OVERDUE_RETURN_DAY = "2020-03-01";
const PERFORMED_AT = new Date("2026-03-10T12:00:00.000Z");
const OVERDUE_PERFORMED_AT = new Date("2019-09-01T12:00:00.000Z");

const morning = { hour: 9, minute: 0 };

const db = () => prisma as PrismaClient;

/** `YYYY-MM-DD` as the UTC midnight a `@db.Date` column holds. */
function day(text: string): Date {
  const [year, month, date] = text.split("-").map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, date as number));
}

/** An OPEN return in `unitId`, with its own customer, vehicle and service. */
async function insertReturn(tx: DbClient, input: { unitId: string; returnDay: string; performedAt: Date }) {
  const customer = await tx.customer.create({
    data: { origin: "crm", status: "active", name: "Maria" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      origin: "crm",
      plate: `AAA-${randomUUID().slice(0, 4)}`,
      make: "Toyota",
      model: "Corolla",
    },
    select: { id: true },
  });
  const service = await tx.service.create({
    data: {
      customerId: customer.id,
      vehicleId: vehicle.id,
      unitId: input.unitId,
      origin: "crm",
      kind: "troca de óleo",
      performedAt: input.performedAt,
    },
    select: { id: true },
  });
  return tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: day(input.returnDay), status: "OPEN" },
    select: { id: true },
  });
}

/** One loja with a conversation, an open far-future return and an overdue one, plus another loja's return. */
async function seedScope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const user = await seedUser(tx, { units: [unit.id] });
  const future = await insertReturn(tx, { unitId: unit.id, returnDay: FUTURE_RETURN_DAY, performedAt: PERFORMED_AT });
  const overdue = await insertReturn(tx, {
    unitId: unit.id,
    returnDay: OVERDUE_RETURN_DAY,
    performedAt: OVERDUE_PERFORMED_AT,
  });
  const otherUnit = await seedUnit(tx);
  const otherReturn = await insertReturn(tx, {
    unitId: otherUnit.id,
    returnDay: FUTURE_RETURN_DAY,
    performedAt: PERFORMED_AT,
  });
  return {
    unitId: unit.id,
    userId: user.id,
    conversationId: conversation.id,
    futureReturnId: future.id,
    overdueReturnId: overdue.id,
    otherReturnId: otherReturn.id,
  };
}

/** This slice alone, as the scope's attendant, with the probe pinned. */
function appOn(tx: DbClient, scope: { unitId: string; userId: string }, connected = true) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) =>
      registerSlice(
        app,
        "scheduling",
        "create-return-reminder",
        createRoute({ channelConnected: async () => connected }),
      ),
    caller: { userId: scope.userId, unitId: scope.unitId },
  });
}

function create(app: Awaited<ReturnType<typeof appOn>>, returnId: string, payload: object) {
  return app.inject({
    method: "POST",
    url: `/vehicle-returns/${returnId}/reminders`,
    headers: { "content-type": "application/json" },
    payload,
  });
}

describeWithDatabase("POST /vehicle-returns/:returnId/reminders", () => {
  it("creates one scheduled row per moment", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        const response = await create(app, scope.futureReturnId, {
          conversationId: scope.conversationId,
          triggers: [
            { kind: "before", days: 30, time: morning },
            { kind: "before", days: 0, time: { hour: 14, minute: 30 } },
            { kind: "after", days: 7, time: morning },
          ],
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.scheduledMessages).toHaveLength(3);
        expect(body.vehicleReturnId).toBe(scope.futureReturnId);
        expect(body.cancelledAt).toBeNull();
        // Ordered by instant, each keeping its own hour.
        expect(body.scheduledMessages.map((row: { scheduledAt: string }) => row.scheduledAt)).toEqual([
          "2099-08-11T12:00:00.000Z",
          "2099-09-10T17:30:00.000Z",
          "2099-09-17T12:00:00.000Z",
        ]);
        expect(
          body.scheduledMessages.every(
            (row: { returnReminderMessageId: string | null }) =>
              row.returnReminderMessageId === body.reminderMessageId,
          ),
        ).toBe(true);
        // Three rows in the table, not three entries in a response array.
        expect(
          await tx.scheduledMessage.count({ where: { returnReminderMessageId: body.reminderMessageId } }),
        ).toBe(3);
      } finally {
        await app.close();
      }
    }));

  it("hides another loja's return behind the same 404 as an unknown one", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        const payload = {
          conversationId: scope.conversationId,
          triggers: [{ kind: "before", days: 0, time: morning }],
        };

        // 404 rather than 403: distinguishing them would confirm the row
        // exists. The other loja's return is a real row, reached through its
        // source service, so this is the join and not a scalar (F2).
        for (const returnId of [scope.otherReturnId, "nope"]) {
          const response = await create(app, returnId, payload);
          expect(response.statusCode).toBe(404);
        }
        expect(await tx.returnReminderMessage.count({ where: { vehicleReturnId: scope.otherReturnId } })).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("blocks a confirm while the channel is down, writing nothing", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope, false);
      try {
        const response = await create(app, scope.futureReturnId, {
          conversationId: scope.conversationId,
          triggers: [{ kind: "before", days: 0, time: morning }],
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ state: "DISCONNECTED" });
        expect(await tx.returnReminderMessage.count({ where: { vehicleReturnId: scope.futureReturnId } })).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("refuses an offset moment on an overdue return but accepts an absolute one", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        // "no dia" on a return that is already late resolves into the past.
        const offset = await create(app, scope.overdueReturnId, {
          conversationId: scope.conversationId,
          triggers: [{ kind: "before", days: 0, time: morning }],
        });

        expect(offset.statusCode).toBe(409);
        expect(offset.json()).toMatchObject({ error: "trigger_in_past" });
        // The instant is named, so the screen can point at the offending row.
        expect(typeof offset.json().at).toBe("string");

        const absolute = await create(app, scope.overdueReturnId, {
          conversationId: scope.conversationId,
          triggers: [{ kind: "absolute", at: "2099-04-01T12:00:00.000Z" }],
        });

        // Same overdue return, and it works: the section is reachable after all.
        expect(absolute.statusCode).toBe(201);
        expect(absolute.json().scheduledMessages).toHaveLength(1);
      } finally {
        await app.close();
      }
    }));

  it("refuses two moments landing on the same instant", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        const response = await create(app, scope.futureReturnId, {
          conversationId: scope.conversationId,
          triggers: [
            { kind: "before", days: 0, time: morning },
            { kind: "absolute", at: "2099-09-10T12:00:00.000Z" },
          ],
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "duplicate_trigger" });
        // Refused before anything was written: the partial unique index on
        // (return_reminder_message_id, scheduled_at) is never reached.
        expect(await tx.returnReminderMessage.count({ where: { vehicleReturnId: scope.futureReturnId } })).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("rejects an empty moment list at the schema", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        // A message nobody will ever send is a malformed request, not a
        // business rejection, so it never reaches the write.
        const response = await create(app, scope.futureReturnId, {
          conversationId: scope.conversationId,
          triggers: [],
        });

        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    }));
});
