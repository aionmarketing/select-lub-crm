/**
 * Test design (testing-strategy)
 *
 * SUT: `reconcileVehicleReturns` (services/contracts/reconcile-vehicle-returns.ts)
 *   applied to Postgres, for the owner rulings of 2026-09-25 (PR 3): ARCHIVED
 *   returns, duplicate OPEN returns, and the race the one-OPEN-return index
 *   settles. Inside one rolling-back transaction per case.
 *
 * Why here: `contracts/` may not import the harness; `test/` is outside the
 *   boundary rules. The duplicate-merge case needs two OPEN rows, which the
 *   index forbids, so it drops the index — DDL that would lock `vehicle_return`
 *   for every parallel file here — and lives in the scratch-database suite
 *   `one-open-return-migration.live.test.ts` instead.
 *
 * Oracle: services/vehicle-returns — "A vehicle SHALL have at most one open
 *   return"; delta 3 of apply-owner-rulings-2026-09-25 — a newer service
 *   supersedes an ARCHIVED return and stops its un-sent reminders; an import does
 *   not reopen an archived return.
 *
 * Cases
 *   1. Archive, then reconcile: no new OPEN return. Before this change every
 *      import reopened it, as a second row on the same service.
 *   2. A newer service supersedes an ARCHIVED return; its SCHEDULED reminder is
 *      CANCELLED; a return opens from the newer service.
 *   3. An OPEN return whose service no longer points at its vehicle is
 *      superseded: the vehicle is visited although it has no service.
 *   4. The race: the reconcile's read is stale (the other run's return is not
 *      in it), so it plans an open the index refuses. It skips — no throw, no
 *      second row, not counted — instead of failing its transaction.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb, type Db, type ModuleName, type RunInTransaction } from "../src/kernel/db.js";
import { archiveVehicleReturn, reconcileVehicleReturns } from "../src/modules/services/contracts/index.js";
import { describeWithDatabase, runInTransactionOnTx, seedUnit, seedUser, withTestTransaction } from "../src/testing/index.js";

const db = () => prisma as PrismaClient;

function handle(tx: DbClient): Db {
  return createDb(tx, runInTransactionOnTx(tx));
}

/** A vehicle with services at the given instants, oldest first. */
async function vehicleWith(tx: DbClient, performedAt: string[]) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({ data: { unitId: unit.id, origin: "crm", status: "active" } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm" } });
  const services = [];
  for (const at of performedAt) {
    services.push(
      await tx.service.create({
        data: { customerId: customer.id, vehicleId: vehicle.id, unitId: unit.id, origin: "crm", performedAt: new Date(at) },
      }),
    );
  }
  return { vehicleId: vehicle.id, userId: user.id, serviceIds: services.map((row) => row.id) };
}

/** A reminder message with one SCHEDULED row on `returnId`. */
async function reminderOn(tx: DbClient, returnId: string, userId: string) {
  const message = await tx.returnReminderMessage.create({
    data: { vehicleReturnId: returnId, bodyTemplate: "Lembrete", createdByUserId: userId },
  });
  const row = await tx.scheduledMessage.create({
    data: {
      returnReminderMessageId: message.id,
      frozenText: "Lembrete",
      scheduledAt: new Date("2099-01-01T12:00:00.000Z"),
      status: "SCHEDULED",
      idempotencyKey: randomUUID(),
      createdByUserId: userId,
    },
  });
  return { messageId: message.id, rowId: row.id };
}

function returnsOf(tx: DbClient, vehicleId: string) {
  return tx.vehicleReturn.findMany({
    where: { vehicleId },
    select: { id: true, status: true, sourceServiceId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** Binds a delegate's own methods, so a proxied call keeps its `this`. */
function bound<T extends object>(target: T, key: string | symbol) {
  const value = Reflect.get(target, key) as unknown;
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * A handle whose `vehicleReturn.findMany` answers `[]` — the read of a reconcile
 * that ran before another one committed the vehicle's return — while every
 * write reaches the database.
 */
function staleReturnsRead(tx: DbClient): Db {
  const real = handle(tx);
  const wrap = (inner: DbClient): DbClient =>
    new Proxy(inner, {
      get(target, key) {
        if (key !== "vehicleReturn") return bound(target, key);
        return new Proxy(target.vehicleReturn, {
          get(delegate, method) {
            return method === "findMany" ? async () => [] : bound(delegate, method);
          },
        });
      },
    });
  return {
    client: real.client,
    tx<T>(module: ModuleName, fn: (inner: DbClient) => Promise<T>, run?: RunInTransaction) {
      return real.tx(module, (inner) => fn(wrap(inner)), run);
    },
  };
}

describeWithDatabase("reconcileVehicleReturns — archived and duplicate returns", () => {
  it("does not reopen a return the attendant archived", () =>
    withTestTransaction(db(), async (tx) => {
      const v = await vehicleWith(tx, ["2026-03-10T12:00:00.000Z"]);
      await reconcileVehicleReturns(handle(tx), { vehicleIds: [v.vehicleId] });
      const [opened] = await returnsOf(tx, v.vehicleId);
      expect(opened?.status).toBe("OPEN"); // precondition
      await archiveVehicleReturn(handle(tx), { returnId: opened!.id, userId: v.userId });

      const result = await reconcileVehicleReturns(handle(tx), { vehicleIds: [v.vehicleId] });

      expect(await returnsOf(tx, v.vehicleId)).toEqual([
        { id: opened!.id, status: "ARCHIVED", sourceServiceId: v.serviceIds[0] },
      ]);
      expect(result.opened).toBe(0);
    }));

  it("supersedes an archived return once a newer service arrives, and stops its reminders", () =>
    withTestTransaction(db(), async (tx) => {
      const v = await vehicleWith(tx, ["2025-09-01T12:00:00.000Z"]);
      await reconcileVehicleReturns(handle(tx), { vehicleIds: [v.vehicleId] });
      const [old] = await returnsOf(tx, v.vehicleId);
      await archiveVehicleReturn(handle(tx), { returnId: old!.id, userId: v.userId });
      const reminder = await reminderOn(tx, old!.id, v.userId);
      const customerId = (await tx.vehicle.findUniqueOrThrow({ where: { id: v.vehicleId } })).customerId;
      const unitId = (await tx.service.findUniqueOrThrow({ where: { id: v.serviceIds[0]! } })).unitId;
      const newer = await tx.service.create({
        data: { customerId, vehicleId: v.vehicleId, unitId, origin: "crm", performedAt: new Date("2026-03-10T12:00:00.000Z") },
      });

      const result = await reconcileVehicleReturns(handle(tx), { vehicleIds: [v.vehicleId] });

      const rows = await returnsOf(tx, v.vehicleId);
      expect(rows.map((row) => [row.status, row.sourceServiceId])).toEqual([
        ["SUPERSEDED", v.serviceIds[0]],
        ["OPEN", newer.id],
      ]);
      expect((await tx.scheduledMessage.findUniqueOrThrow({ where: { id: reminder.rowId } })).status).toBe("CANCELLED");
      expect(result).toMatchObject({ opened: 1, superseded: 1, remindersCancelled: 1 });
    }));

  it("supersedes an open return no service points at any more", () =>
    withTestTransaction(db(), async (tx) => {
      // The service's vehicle link went (SET NULL): before, the reconcile listed
      // vehicles only from services, never visited this one, and the return
      // stayed OPEN for ever (review of #167).
      const v = await vehicleWith(tx, ["2026-03-10T12:00:00.000Z"]);
      await reconcileVehicleReturns(handle(tx), { vehicleIds: [v.vehicleId] });
      const [opened] = await returnsOf(tx, v.vehicleId);
      await tx.service.update({ where: { id: v.serviceIds[0]! }, data: { vehicleId: null } });

      const result = await reconcileVehicleReturns(handle(tx), { vehicleIds: [v.vehicleId] });

      expect(await returnsOf(tx, v.vehicleId)).toEqual([
        { id: opened!.id, status: "SUPERSEDED", sourceServiceId: v.serviceIds[0] },
      ]);
      expect(result).toMatchObject({ vehicles: 1, superseded: 1, opened: 0 });
    }));

  it("skips the open another reconcile won, instead of failing its transaction", () =>
    withTestTransaction(db(), async (tx) => {
      const v = await vehicleWith(tx, ["2026-03-10T12:00:00.000Z"]);
      // The other run opened the vehicle's return and committed.
      await reconcileVehicleReturns(handle(tx), { vehicleIds: [v.vehicleId] });
      const [won] = await returnsOf(tx, v.vehicleId);

      // This run read before that commit, so it plans an open of its own.
      const result = await reconcileVehicleReturns(staleReturnsRead(tx), { vehicleIds: [v.vehicleId] });

      expect(result.opened).toBe(0);
      expect(await returnsOf(tx, v.vehicleId)).toEqual([won]);
    }));
});
