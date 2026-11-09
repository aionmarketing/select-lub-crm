/**
 * Test design (testing-strategy) — scheduling / create-scheduled-message
 *
 * Module role: `module_scheduling`. The conversation read and the insert run in
 * `db.tx("scheduling", …)`; every write under test ran as that role.
 *
 * Moved from `apps/api/src/scheduled.route.test.ts`, assertions unchanged: its
 * seven create cases (CONNECTED create, channel down, another loja, the three
 * service-occupancy cases, and create after a CANCELLED one). The list, cancel
 * and suggest cases moved to their own slices; that file had no hook case.
 *
 * SUT: `POST /conversations/:id/scheduled-messages`, through `buildSliceApp`
 *   with this slice's route only, on the worktree database inside one
 *   rolling-back transaction per test (`withTestTransaction`). The caller is
 *   stated rather than resolved by the hook, and is a real `user` row, because
 *   `scheduled_message.created_by_user_id` is a foreign key.
 *
 *   THE CHANNEL PROBE IS PINNED. The slice's only port is the LIVE Evolution
 *   probe; each case passes `async () => true` or `async () => false`, so there
 *   is no code path from this suite to the network. Both polarities stay
 *   load-bearing, as they were when the probe was pinned on the old store.
 *
 * Oracle: scheduled-messages task 2.2 / design D4 — create on a conversation;
 *   createdByUserId is the session user; another loja 404; POST confirm returns
 *   409 when the channel is not CONNECTED; one non-cancelled rail schedule per
 *   service.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   F2 — unit scoping is the join `conversation → whatsappConnection → unitId`,
 *     exercised against a real second loja's connection.
 *
 * Axes
 *   A1 channel — CONNECTED / DISCONNECTED
 *   A3 loja — matching / another
 *   A5 service occupancy — free / occupied by a rail schedule (SCHEDULED, SENT)
 *      / by a reminder / by a CANCELLED one
 *
 * Outputs
 *   O1 201 + createdByUserId + a SCHEDULED row; O4 409; O5 404; O8 conflict;
 *   O9 no row written
 *
 * Sampled-cell
 *   create while CONNECTED      | A1 on          | O1    | 409 or wrong user
 *   create while disconnected   | A1 off         | O4 O9 | 201
 *   another loja                | A3 other       | O5 O9 | 200
 *   second rail schedule        | A5 occupied    | O8    | 201 duplicate
 *   SENT occupies the service   | A5 SENT        | O8    | 201
 *   reminder row on the service | A5 reminder    | O1    | 409, blocking the rail
 *   after CANCELLED allowed     | A5 CANCELLED   | O1    | 409
 *
 * Decision map (create-scheduled-message)
 *   !unitId                     contract-hidden — the hook 403s first
 *   !crmUserId                  contract-hidden — the hook sets it after 401
 *   conversation miss           T another-loja it; F the rest
 *   probe false                 T disconnected it; F the rest
 *   occupied (findFirst)        T second / SENT its; F first / reminder / after-cancel
 *   P2002 catch                 not sampled — the occupancy check answers first
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

const FUTURE = "2099-01-15T15:00:00.000Z";

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
        "create-scheduled-message",
        createRoute({ channelConnected: async () => connected }),
      ),
    caller: { userId: scope.userId, unitId: scope.unitId },
  });
}

async function insertSchedule(
  tx: DbClient,
  input: {
    conversationId: string;
    userId: string;
    status?: string;
    serviceId?: string | null;
    returnReminderMessageId?: string | null;
    frozenText?: string;
  },
) {
  return tx.scheduledMessage.create({
    data: {
      conversationId: input.conversationId,
      serviceId: input.serviceId ?? null,
      returnReminderMessageId: input.returnReminderMessageId ?? null,
      frozenText: input.frozenText ?? "Olá",
      scheduledAt: new Date(FUTURE),
      status: input.status ?? "SCHEDULED",
      idempotencyKey: randomUUID(),
      createdByUserId: input.userId,
    },
    select: { id: true },
  });
}

/** A service in `unitId` with its own customer and vehicle. */
async function insertService(tx: DbClient, unitId: string) {
  const customer = await tx.customer.create({
    data: { origin: "crm", status: "active", name: "Maria" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, origin: "crm", plate: "ABC-1D23" },
    select: { id: true },
  });
  return tx.service.create({
    data: {
      customerId: customer.id,
      vehicleId: vehicle.id,
      unitId,
      origin: "crm",
      performedAt: new Date("2026-01-15T03:00:00.000Z"),
    },
    select: { id: true, vehicleId: true },
  });
}

/** A reminder hanging off a real return, so a reminder-owned schedule is real. */
async function insertReminder(tx: DbClient, serviceId: string, vehicleId: string, userId: string) {
  const vehicleReturn = await tx.vehicleReturn.create({
    data: { vehicleId, sourceServiceId: serviceId, returnDate: new Date(Date.UTC(2099, 0, 20)), status: "OPEN" },
    select: { id: true },
  });
  return tx.returnReminderMessage.create({
    data: { vehicleReturnId: vehicleReturn.id, bodyTemplate: "Lembrete de retorno", createdByUserId: userId },
    select: { id: true },
  });
}

function post(app: Awaited<ReturnType<typeof appOn>>, conversationId: string, payload: object) {
  return app.inject({
    method: "POST",
    url: `/conversations/${conversationId}/scheduled-messages`,
    headers: { "content-type": "application/json" },
    payload,
  });
}

describeWithDatabase("POST /conversations/:id/scheduled-messages", () => {
  it("creates a schedule with the session user id while CONNECTED", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        const created = await post(app, scope.conversationId, { text: "Olá Maria", scheduledAt: FUTURE });

        expect(created.statusCode).toBe(201);
        expect(created.json().createdByUserId).toBe(scope.userId);
        expect(created.json().text).toBe("Olá Maria");
        expect(created.json().status).toBe("SCHEDULED");
        // The row, not the response: the column is what the due tick reads.
        const row = await tx.scheduledMessage.findUniqueOrThrow({
          where: { id: created.json().id },
          select: { status: true },
        });
        expect(row).toMatchObject({ status: "SCHEDULED" });
      } finally {
        await app.close();
      }
    }));

  it("returns 409 and writes nothing when creating while the channel is not CONNECTED", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope, false);
      try {
        const created = await post(app, scope.conversationId, { text: "Olá Maria", scheduledAt: FUTURE });

        expect(created.statusCode).toBe(409);
        expect(created.json()).toEqual({ state: "DISCONNECTED" });
        // Scoped to this conversation, not a global count (design D9).
        expect(await tx.scheduledMessage.count({ where: { conversationId: scope.conversationId } })).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("returns 404 when the conversation hangs off another loja's connection", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      // A real conversation on a real connection in another loja: the gate is
      // the join, so the row has to exist for the case to mean anything (F2).
      const otherUnit = await seedUnit(tx);
      const otherConnection = await seedConnection(tx, { unitId: otherUnit.id });
      const otherConversation = await seedConversation(tx, { connectionId: otherConnection.id });
      const app = await appOn(tx, scope);
      try {
        const created = await post(app, otherConversation.id, { text: "Olá Maria", scheduledAt: FUTURE });

        expect(created.statusCode).toBe(404);
        expect(await tx.scheduledMessage.count({ where: { conversationId: otherConversation.id } })).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("rejects a second non-cancelled schedule for the same service", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, scope.unitId);
      await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        serviceId: service.id,
        frozenText: "Primeira",
      });
      const app = await appOn(tx, scope);
      try {
        const second = await post(app, scope.conversationId, {
          text: "Segunda",
          scheduledAt: FUTURE,
          serviceId: service.id,
        });

        expect(second.statusCode).toBe(409);
        expect(second.json()).toEqual({ error: "conflict" });
        expect(await tx.scheduledMessage.count({ where: { serviceId: service.id } })).toBe(1);
      } finally {
        await app.close();
      }
    }));

  it("rejects a second schedule when the existing row for the service is SENT", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, scope.unitId);
      await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        serviceId: service.id,
        status: "SENT",
        frozenText: "Enviada",
      });
      const app = await appOn(tx, scope);
      try {
        const second = await post(app, scope.conversationId, {
          text: "Outra",
          scheduledAt: FUTURE,
          serviceId: service.id,
        });

        expect(second.statusCode).toBe(409);
        expect(second.json()).toEqual({ error: "conflict" });
        expect(await tx.scheduledMessage.count({ where: { serviceId: service.id } })).toBe(1);
      } finally {
        await app.close();
      }
    }));

  it("does not let a return reminder occupy the service it was dated from", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, scope.unitId);
      // A reminder names the service its return came from, but a return may
      // carry several reminders — so counting them as occupancy would make the
      // rail action unreachable after the first.
      const reminder = await insertReminder(tx, service.id, service.vehicleId as string, scope.userId);
      await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        serviceId: service.id,
        returnReminderMessageId: reminder.id,
        frozenText: "Lembrete de retorno",
      });
      const app = await appOn(tx, scope);
      try {
        const created = await post(app, scope.conversationId, {
          text: "Programada pelo trilho",
          scheduledAt: FUTURE,
          serviceId: service.id,
        });

        expect(created.statusCode).toBe(201);
        expect(await tx.scheduledMessage.count({ where: { serviceId: service.id } })).toBe(2);
      } finally {
        await app.close();
      }
    }));

  it("allows a new schedule once the previous one for that service is CANCELLED", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, scope.unitId);
      await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        serviceId: service.id,
        status: "CANCELLED",
        frozenText: "Antiga",
      });
      const app = await appOn(tx, scope);
      try {
        const created = await post(app, scope.conversationId, {
          text: "Nova",
          scheduledAt: FUTURE,
          serviceId: service.id,
        });

        expect(created.statusCode).toBe(201);
        expect(created.json().status).toBe("SCHEDULED");
        expect(await tx.scheduledMessage.count({ where: { serviceId: service.id } })).toBe(2);
      } finally {
        await app.close();
      }
    }));
});
