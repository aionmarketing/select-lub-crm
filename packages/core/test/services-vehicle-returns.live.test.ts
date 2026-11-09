/**
 * Test design (testing-strategy)
 *
 * Setup: live Prisma against DATABASE_URL, skipped when unset. Each test builds
 * its own unit / customer / vehicle / service rows under an id prefix it owns
 * and deletes them afterwards, so runs do not collide with seeded demo data or
 * with each other.
 *
 * Moved from `packages/db/src/vehicle-returns.live.test.ts`
 * (adopt-modular-vertical-slices 3C) with the functions it tests, which are the
 * `services` module's contracts now. Assertions unchanged; each call passes
 * `createDb(db)`, a handle over the committed client, so every write runs in a
 * real transaction under `module_services` — and the supersede's reminder
 * cancel under `module_scheduling`, nested.
 *
 * SUT: reconcileVehicleReturns (plan applied to Postgres) and the
 * archive/unarchive pair. The PLAN itself is unit-tested in shared-types'
 * vehicle-return-plan.test.ts — what is tested here is the half that could not
 * be tested there: that the rows are actually written, that a second run writes
 * nothing, and that archiving really does leave the reminder rows alone.
 *
 * Oracle: vehicle-returns — "at most one OPEN return per vehicle, sourced from
 *   its most recent dated service"; archiving takes the row off the Follow-up
 *   queue and does nothing else, so reminders keep firing on their own schedule
 *   (decided 2026-09-03). Arquivar is a statement about the operator's list, not
 *   about the customer.
 *
 * Axes
 *   A1 run count — first / second over unchanged rows (idempotence)
 *   A2 newer service arrives — before / after a return exists
 *   A3 reminder instant relative to now — future / past. Both are carried
 *      through archive and unarchive to show the instant is never consulted:
 *      a reminder behind now is left exactly as a reminder ahead of it is.
 *   A4 scope — a vehicle id list / unscoped (the backfill shape)
 *
 * Outputs
 *   O1 exactly one OPEN return per vehicle, sourced from the latest service
 *   O2 second run reports opened 0 and superseded 0
 *   O3 previous return is SUPERSEDED, not deleted
 *   O4 return ARCHIVED with actor and instant recorded, every reminder untouched
 *   O5 return OPEN again with the archive fields cleared, reminders still untouched
 *
 * Sampled-cell
 *   first reconcile          | A1 first  A4 scoped   | O1    | no row written / wrong source service
 *   second reconcile         | A1 second             | O2    | a duplicate OPEN return
 *   newer service arrives    | A2 after              | O1 O3 | two OPEN rows, or the old one deleted
 *   archive leaves reminders | A3 future + past      | O4    | a reminder paused, cancelled or moved
 *   unarchive restores        | A3 future + past      | O5    | archive fields left set, or a reminder touched
 *
 * Decision / branch map (services/contracts/reconcile-vehicle-returns.ts,
 * services/contracts/archive-vehicle-return.ts)
 *   scope empty short-circuit      T not sampled (guard); F every it here
 *   byVehicle.size === 0           T not sampled (no-services case is unit-tested); F every it
 *   plan.supersede non-empty       T "newer service"; F "first reconcile"
 *   plan.open non-null             T "first reconcile"; F "second reconcile"
 *   archive status !== OPEN throw  T "refuses a non-OPEN return"; F the archive it
 *   unarchive status !== ARCHIVED  F the archive it; T not sampled — the throw is
 *     the same shape as archive's and is covered there
 *
 * Out of scope: the plan's date math (shared-types); dispatch itself (worker).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { createDb } from "../src/kernel/db.js";
import {
  archiveVehicleReturn,
  reconcileVehicleReturns,
  unarchiveVehicleReturn,
} from "../src/modules/services/contracts/index.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
const hasDatabase = shouldRunLiveTests();
const P = "vrlive";
// User.id is a uuid, so it cannot carry the string prefix the other fixtures
// use; cleanup deletes it by this exact id instead.
const USER_ID = "00000000-0000-4000-8000-000000000001";

const prisma = hasDatabase ? new PrismaClient() : null;

async function cleanup() {
  if (!prisma) return;
  await prisma.scheduledMessage.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.returnReminderMessage.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.vehicleReturn.deleteMany({ where: { vehicleId: { startsWith: P } } });
  await prisma.service.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.customer.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.unit.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

describe.skipIf(!hasDatabase)("vehicle returns, live", () => {
  beforeAll(async () => {
    await cleanup();
    const db = prisma as PrismaClient;
    await db.unit.create({ data: { id: `${P}-unit`, name: "Reconcile" } });
    // Created rather than borrowed from ambient data: archiving records who did
    // it, and a test that skips its assertions when no user happens to exist
    // passes green having checked nothing.
    await db.user.create({
      data: { id: USER_ID, email: `${P}@example.test`, name: "Reconcile Fixture" },
    });
    await db.customer.create({
      data: { id: `${P}-cust`, unitId: `${P}-unit`, origin: "omie", status: "active" },
    });
    await db.vehicle.create({
      data: { id: `${P}-veh`, customerId: `${P}-cust`, plate: "VRL-0001", origin: "omie" },
    });
    await db.service.create({
      data: {
        id: `${P}-svc-old`,
        customerId: `${P}-cust`,
        vehicleId: `${P}-veh`,
        unitId: `${P}-unit`,
        performedAt: new Date("2025-01-10T12:00:00.000Z"),
        kind: "oil",
        origin: "omie",
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma?.$disconnect();
  });

  it("opens one return from the vehicle's only service", async () => {
    const db = prisma as PrismaClient;
    const result = await reconcileVehicleReturns(createDb(db), { vehicleIds: [`${P}-veh`] });

    expect(result.opened).toBe(1);
    const rows = await db.vehicleReturn.findMany({ where: { vehicleId: `${P}-veh` } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("OPEN");
    expect(rows[0]?.sourceServiceId).toBe(`${P}-svc-old`);
  });

  it("writes nothing on a second run over unchanged rows", async () => {
    const db = prisma as PrismaClient;
    const result = await reconcileVehicleReturns(createDb(db), { vehicleIds: [`${P}-veh`] });

    expect(result).toMatchObject({ opened: 0, superseded: 0 });
    expect(await db.vehicleReturn.count({ where: { vehicleId: `${P}-veh` } })).toBe(1);
  });

  it("supersedes the old return when a newer service arrives, keeping the row", async () => {
    const db = prisma as PrismaClient;
    await db.service.create({
      data: {
        id: `${P}-svc-new`,
        customerId: `${P}-cust`,
        vehicleId: `${P}-veh`,
        unitId: `${P}-unit`,
        performedAt: new Date("2026-02-01T12:00:00.000Z"),
        kind: "oil",
        origin: "omie",
      },
    });

    const result = await reconcileVehicleReturns(createDb(db), { vehicleIds: [`${P}-veh`] });

    expect(result).toMatchObject({ opened: 1, superseded: 1 });
    const open = await db.vehicleReturn.findMany({
      where: { vehicleId: `${P}-veh`, status: "OPEN" },
    });
    expect(open).toHaveLength(1);
    expect(open[0]?.sourceServiceId).toBe(`${P}-svc-new`);
    // Superseded rather than deleted: the old return is history, not a mistake.
    expect(
      await db.vehicleReturn.count({ where: { vehicleId: `${P}-veh`, status: "SUPERSEDED" } }),
    ).toBe(1);
  });

  it("archives and unarchives a return without touching its reminders", async () => {
    const db = prisma as PrismaClient;
    const openReturn = await db.vehicleReturn.findFirstOrThrow({
      where: { vehicleId: `${P}-veh`, status: "OPEN" },
    });
    const user = await db.user.findUniqueOrThrow({ where: { id: USER_ID } });
    await db.returnReminderMessage.create({
      data: {
        id: `${P}-msg`,
        vehicleReturnId: openReturn.id,
        bodyTemplate: "Oi!",
        createdByUserId: user.id,
      },
    });
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    for (const [suffix, when] of [["past", past], ["future", future]] as const) {
      await db.scheduledMessage.create({
        data: {
          id: `${P}-sm-${suffix}`,
          returnReminderMessageId: `${P}-msg`,
          frozenText: "Oi!",
          scheduledAt: when,
          status: "SCHEDULED",
          idempotencyKey: `${P}-idem-${suffix}`,
          createdByUserId: user.id,
        },
      });
    }

    await archiveVehicleReturn(createDb(db), { returnId: openReturn.id, userId: user.id });

    const archived = await db.vehicleReturn.findUniqueOrThrow({
      where: { id: openReturn.id },
    });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archivedByUserId).toBe(user.id);
    // The whole point: Arquivar takes the row off the operator's list and says
    // nothing about the customer. Both reminders keep their status and their
    // instant, so the messages the attendant deliberately created still go out.
    const afterArchive = await db.scheduledMessage.findMany({
      where: { returnReminderMessageId: `${P}-msg` },
    });
    expect(afterArchive.every((row) => row.status === "SCHEDULED")).toBe(true);
    expect(afterArchive.find((r) => r.id === `${P}-sm-future`)?.scheduledAt.getTime()).toBe(
      future.getTime(),
    );
    expect(afterArchive.find((r) => r.id === `${P}-sm-past`)?.scheduledAt.getTime()).toBe(
      past.getTime(),
    );

    await unarchiveVehicleReturn(createDb(db), { returnId: openReturn.id });

    const reopened = await db.vehicleReturn.findUniqueOrThrow({
      where: { id: openReturn.id },
    });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.archivedAt).toBeNull();
    expect(reopened.archivedByUserId).toBeNull();
    // Nothing to undo on the reminders, because nothing was done to them.
    const afterUnarchive = await db.scheduledMessage.findMany({
      where: { returnReminderMessageId: `${P}-msg` },
    });
    expect(afterUnarchive.every((row) => row.status === "SCHEDULED")).toBe(true);
  });

  it("refuses to archive a return that is not OPEN", async () => {
    const db = prisma as PrismaClient;
    // findFirstOrThrow, not findFirst-then-return: the previous test creates
    // this row, and if it ever stops doing so this must fail rather than pass
    // having asserted nothing.
    const superseded = await db.vehicleReturn.findFirstOrThrow({
      where: { vehicleId: `${P}-veh`, status: "SUPERSEDED" },
    });
    await expect(
      archiveVehicleReturn(createDb(db), { returnId: superseded.id, userId: "whoever" }),
    ).rejects.toThrow(/not OPEN/);
  });
});
