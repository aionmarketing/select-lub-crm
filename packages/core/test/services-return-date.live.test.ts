/**
 * Test design (testing-strategy)
 *
 * Setup: live Prisma against DATABASE_URL, skipped when unset. Every fixture row
 * carries an id prefix this file owns and is deleted afterwards, so runs neither
 * collide with the seeded demo data nor with each other.
 *
 * MOVED AGAIN IN 3C. With `setVehicleReturnDate` (now the `services` module's
 * `internal/set-vehicle-return-date.ts`) and `reconcileVehicleReturns` (its
 * `contracts/reconcile-vehicle-returns.ts`), from
 * `packages/db/src/vehicle-return-date.live.test.ts`. Assertions unchanged; each
 * call passes `createDb(db)`, a handle over the committed client, so the return
 * moves under `module_services` and its reminders under `module_scheduling`,
 * nested in one transaction.
 *
 * WHERE THESE CAME FROM. The five cases below were in
 * `return-reminders.live.test.ts`, whose other nine tested
 * `return-reminders.ts`. Stream 3B moved that file into the `scheduling` module
 * (`packages/core/src/modules/scheduling`) and its nine cases with it. These five
 * test `setVehicleReturnDate` and `reconcileVehicleReturns`, which stay here until
 * 3C moves them into `services`; they are kept on committed rows, unchanged.
 *
 * SETUP CHANGED, NOT ASSERTIONS. Each case used to create its reminder through
 * `createReturnReminderMessage`, which is `scheduling`'s now and which this
 * package cannot import (`core` depends on `db`). {@link seedReminder} writes the
 * same rows the same way: it runs the same pure planner, `planReminderMessage`
 * from `@select-lub/shared-types`, on the same inputs, and inserts what it
 * returns — so the instants, lead days and texts the assertions read are
 * byte-for-byte what the old helper produced.
 *
 * SUT: setVehicleReturnDate and reconcileVehicleReturns — that an edited return
 * date carries its un-sent offset reminders, cancels those pushed into the past,
 * survives a reconcile pass, moves no other return, and that a superseding
 * service stops a return's un-sent reminders.
 *
 * Oracle: vehicle-returns (align-shipped-ui-to-revised-canvas delta) —
 *   "`returnDate` SHALL be editable after creation"; "Editing one return's date
 *   ... MUST NOT move any other return"; "Follow-up places that vehicle by the
 *   edited date, not by the service plus the rule period"; rows already SENT are
 *   untouched.
 *
 * Axes
 *   A2 interval provenance — a matched rule / the six-month default
 *   A4 return status — OPEN / ARCHIVED / SUPERSEDED
 *   A5 which return is edited — the one under test / a second vehicle's
 *   A6 reconcile after an edit — run
 *   A7 cascade: trigger kind on an existing row — offset / absolute
 *   A8 cascade: row status — SCHEDULED / SENT
 *   A9 cascade: direction — later (moves) / earlier past now (cancels)
 *   A10 supersede: row status — SCHEDULED / SENT
 *
 * Outputs
 *   O5 the stored returnDate is the edited day and the rule link is cleared
 *   O6 no other return moved
 *   O7 status archived / superseded, distinct, with the row unchanged
 *   O8 offset row moved, its own hour kept, its text re-resolved
 *   O9 absolute row and SENT row untouched
 *   O10 cancelled with a Portuguese reason recorded on the row
 *   O11 a superseded return's un-sent reminders cancelled, SENT left alone
 *
 * Sampled-cell
 *   date slips two weeks later   | A7 both A8 both A9 later | O8 O9  | the hour drifting, an absolute date moved, or a SENT row rewritten
 *   date moves before now        | A9 earlier               | O10    | dispatched late, or moved to the present
 *   newer service supersedes     | A10 both                 | O11    | a reminder about a replaced date still firing
 *   edit one of two returns      | A2 A5 both A6 run        | O5 O6  | the edit undone by reconcile
 *   edit a non-open return       | A4 ARCHIVED+SUPERSEDED   | O7     | either accepted, or the two conflated
 *
 * Decision / branch map (services/internal/set-vehicle-return-date.ts,
 * services/contracts/reconcile-vehicle-returns.ts)
 *   returnDate regex miss           T malformed-day it; F every other it
 *   status === ARCHIVED (edit)      T non-open it; F edit its
 *   status !== OPEN (edit)          T non-open it; F edit its
 *   plan.status keep/move/cancel    all three in the two cascade its
 *   plan.supersede non-empty        T supersede it; F every other it
 *
 * Out of scope: the reminder writes themselves (scheduling's slice tests); the
 *   keep/move/cancel decision (shared-types' reminder-plan.test.ts).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_REMINDER_TEMPLATE, planReminderMessage, type ReminderTrigger } from "../src/modules/scheduling/contracts/http.js";
import { SCHEDULE_TIME_ZONE } from "../src/modules/services/contracts/http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { createDb } from "../src/kernel/db.js";
import { reconcileVehicleReturns } from "../src/modules/services/contracts/index.js";
import { setVehicleReturnDate } from "../src/modules/services/internal/set-vehicle-return-date.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
const hasDatabase = shouldRunLiveTests();
const P = "rdlive";
/** User.id is a uuid, so it cannot carry the prefix; cleanup deletes it by id. */
const USER_ID = "00000000-0000-4000-8000-000000000003";
const PERFORMED_AT = new Date("2026-03-10T12:00:00.000Z");
/** Well before every trigger below, so nothing is rejected as already past. */
const NOW = new Date("2026-03-11T12:00:00.000Z");

const prisma = hasDatabase ? new PrismaClient() : null;

async function cleanup() {
  if (!prisma) return;
  await prisma.scheduledMessage.deleteMany({ where: { conversationId: `${P}-conv` } });
  await prisma.returnReminderMessage.deleteMany({
    where: { vehicleReturn: { vehicleId: { startsWith: P } } },
  });
  await prisma.vehicleReturn.deleteMany({ where: { vehicleId: { startsWith: P } } });
  await prisma.conversation.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.whatsAppConnection.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.service.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.customer.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.intervalRule.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.unit.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

/** Removes only what one `it` created, so the next one starts from the fixture. */
async function clearReminders() {
  const db = prisma as PrismaClient;
  await db.scheduledMessage.deleteMany({ where: { conversationId: `${P}-conv` } });
  await db.returnReminderMessage.deleteMany({
    where: { vehicleReturn: { vehicleId: { startsWith: P } } },
  });
}

async function openReturnId(vehicleId: string) {
  const db = prisma as PrismaClient;
  const row = await db.vehicleReturn.findFirstOrThrow({
    where: { vehicleId, status: "OPEN" },
    select: { id: true },
  });
  return row.id;
}

/**
 * Writes a reminder message and one scheduled row per trigger, the way
 * `createReturnReminderMessage` did: same planner, same inputs, same columns.
 *
 * @returns The message id and the row ids, in trigger order.
 */
async function seedReminder(returnId: string, triggers: ReminderTrigger[]) {
  const db = prisma as PrismaClient;
  const row = await db.vehicleReturn.findUniqueOrThrow({
    where: { id: returnId },
    include: {
      intervalRule: true,
      sourceService: { select: { performedAt: true, kind: true, description: true } },
      vehicle: { select: { customerId: true, make: true, model: true, plate: true } },
    },
  });
  const plan = planReminderMessage({
    returnDate: row.returnDate.toISOString().slice(0, 10),
    performedAt: row.sourceService.performedAt as Date,
    serviceLabel: row.sourceService.kind ?? row.sourceService.description ?? "manutenção",
    vehicleLabel:
      [row.vehicle.make, row.vehicle.model].filter(Boolean).join(" ") || row.vehicle.plate || "seu veículo",
    interval: row.intervalRule
      ? { amount: row.intervalRule.intervalAmount, unit: row.intervalRule.intervalUnit === "days" ? "days" : "months" }
      : { amount: 6, unit: "months" },
    bodyTemplate: DEFAULT_REMINDER_TEMPLATE,
    triggers,
    now: NOW,
  });
  if (plan.status !== "ok") {
    throw new Error(`setup failed: ${plan.status}`);
  }
  const message = await db.returnReminderMessage.create({
    data: { vehicleReturnId: row.id, bodyTemplate: DEFAULT_REMINDER_TEMPLATE, createdByUserId: USER_ID },
  });
  const scheduledMessageIds: string[] = [];
  for (const planned of plan.rows) {
    const created = await db.scheduledMessage.create({
      data: {
        id: randomUUID(),
        customerId: row.vehicle.customerId,
        conversationId: `${P}-conv`,
        serviceId: row.sourceServiceId,
        returnReminderMessageId: message.id,
        leadDays: planned.leadDays,
        frozenText: planned.frozenText,
        scheduledAt: planned.scheduledAt,
        timeZone: SCHEDULE_TIME_ZONE,
        status: "SCHEDULED",
        idempotencyKey: randomUUID(),
        intervalRuleId: row.intervalRuleId,
        intervalRuleVersion: row.intervalRuleVersion,
        createdByUserId: USER_ID,
      },
      select: { id: true },
    });
    scheduledMessageIds.push(created.id);
  }
  return { reminderMessageId: message.id, scheduledMessageIds };
}

describe.skipIf(!hasDatabase)("vehicle return date and supersede, live", () => {
  beforeAll(async () => {
    await cleanup();
    const db = prisma as PrismaClient;
    await db.unit.create({ data: { id: `${P}-unit`, name: "Datas de retorno" } });
    await db.user.create({
      data: { id: USER_ID, email: `${P}@example.test`, name: "Return Date Fixture" },
    });
    await db.customer.create({
      data: { id: `${P}-cust`, unitId: `${P}-unit`, origin: "omie", status: "active" },
    });
    await db.whatsAppConnection.create({
      data: { id: `${P}-conn`, unitId: `${P}-unit`, instanceName: `${P}-instance` },
    });
    await db.conversation.create({
      data: {
        id: `${P}-conv`,
        whatsappConnectionId: `${P}-conn`,
        remoteJid: "5511900000001@s.whatsapp.net",
        // conversation_chat_key_format: digits only, or a @g.us group key.
        chatKey: "5511900000001",
        customerId: `${P}-cust`,
        startedAt: PERFORMED_AT,
        lastMessageAt: PERFORMED_AT,
      },
    });
    // Two vehicles: one under test, one that must not move when the first is edited.
    for (const suffix of ["a", "b"] as const) {
      await db.vehicle.create({
        data: {
          id: `${P}-veh-${suffix}`,
          customerId: `${P}-cust`,
          plate: `RDL-000${suffix === "a" ? 1 : 2}`,
          make: "Toyota",
          model: "Corolla",
          origin: "omie",
        },
      });
      await db.service.create({
        data: {
          id: `${P}-svc-${suffix}`,
          customerId: `${P}-cust`,
          vehicleId: `${P}-veh-${suffix}`,
          unitId: `${P}-unit`,
          performedAt: PERFORMED_AT,
          kind: "troca de óleo",
          origin: "omie",
        },
      });
    }
    // No interval rule is active for this kind, so both returns fall back to the
    // six-month default and land on 2026-09-10.
    await reconcileVehicleReturns(createDb(prisma as PrismaClient), {
      vehicleIds: [`${P}-veh-a`, `${P}-veh-b`],
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma?.$disconnect();
  });

  it("carries offset reminders with the date, leaves absolute and sent ones alone", async () => {
    const db = prisma as PrismaClient;
    await clearReminders();
    const returnId = await openReturnId(`${P}-veh-a`);
    await db.vehicleReturn.update({
      where: { id: returnId },
      data: { returnDate: new Date("2026-09-10T00:00:00.000Z") },
    });
    const created = await seedReminder(returnId, [
      { kind: "before", days: 7, time: { hour: 9, minute: 0 } },
      { kind: "before", days: 0, time: { hour: 9, minute: 0 } },
      // An absolute date: the attendant said "this exact day".
      { kind: "absolute", at: new Date("2026-07-01T13:30:00.000Z") },
    ]);
    // One of the offset rows has already gone out and must not be rewritten.
    const rowsBefore = await db.scheduledMessage.findMany({
      where: { returnReminderMessageId: created.reminderMessageId },
      orderBy: { scheduledAt: "asc" },
    });
    const sentRow = rowsBefore.find((row) => row.leadDays === 7);
    if (!sentRow) {
      throw new Error("setup failed: no 7-day row");
    }
    await db.scheduledMessage.update({
      where: { id: sentRow.id },
      data: { status: "SENT", sentAt: new Date("2026-09-03T12:00:00.000Z") },
    });

    // The return slips two weeks, to 24/09.
    const result = await setVehicleReturnDate(createDb(db), {
      returnId,
      returnDate: "2026-09-24",
      now: NOW,
    });

    expect(result).toEqual({
      status: "ok",
      returnDate: "2026-09-24",
      moved: 1,
      cancelled: 0,
      kept: 1,
    });
    const after = await db.scheduledMessage.findMany({
      where: { returnReminderMessageId: created.reminderMessageId },
    });
    const onTheDay = after.find((row) => row.leadDays === 0);
    // Follows the new date and keeps the 09:00 the attendant chose.
    expect(onTheDay?.scheduledAt.toISOString()).toBe("2026-09-24T12:00:00.000Z");
    expect(onTheDay?.frozenText).toContain("Faz 6 meses");
    const absolute = after.find((row) => row.leadDays === null);
    // An explicit date is never overridden by a date edit.
    expect(absolute?.scheduledAt.toISOString()).toBe("2026-07-01T13:30:00.000Z");
    const sent = after.find((row) => row.id === sentRow.id);
    expect(sent?.status).toBe("SENT");
    expect(sent?.scheduledAt.toISOString()).toBe(sentRow.scheduledAt.toISOString());
    expect(sent?.frozenText).toBe(sentRow.frozenText);
  });

  it("cancels an offset reminder the new date would push into the past", async () => {
    const db = prisma as PrismaClient;
    await clearReminders();
    const returnId = await openReturnId(`${P}-veh-a`);
    await db.vehicleReturn.update({
      where: { id: returnId },
      data: { returnDate: new Date("2026-09-10T00:00:00.000Z") },
    });
    const created = await seedReminder(returnId, [
      { kind: "before", days: 7, time: { hour: 9, minute: 0 } },
    ]);

    // Moved earlier, so 7 days before it lands before NOW.
    const result = await setVehicleReturnDate(createDb(db), {
      returnId,
      returnDate: "2026-03-12",
      now: NOW,
    });

    expect(result).toEqual({
      status: "ok",
      returnDate: "2026-03-12",
      moved: 0,
      cancelled: 1,
      kept: 0,
    });
    const row = await db.scheduledMessage.findUniqueOrThrow({
      where: { id: created.scheduledMessageIds[0] as string },
    });
    // Cancelled with the reason recorded, rather than dispatched late or moved
    // silently to the present.
    expect(row.status).toBe("CANCELLED");
    expect(row.lastError).toBe("A nova data de retorno colocaria este lembrete no passado.");
  });

  it("stops a superseded return's un-sent reminders and leaves a sent one", async () => {
    const db = prisma as PrismaClient;
    await clearReminders();
    const returnId = await openReturnId(`${P}-veh-a`);
    await db.vehicleReturn.update({
      where: { id: returnId },
      data: { returnDate: new Date("2026-09-10T00:00:00.000Z") },
    });
    const created = await seedReminder(returnId, [
      { kind: "before", days: 7, time: { hour: 9, minute: 0 } },
      { kind: "before", days: 0, time: { hour: 9, minute: 0 } },
    ]);
    const sentId = created.scheduledMessageIds[0] as string;
    await db.scheduledMessage.update({
      where: { id: sentId },
      data: { status: "SENT", sentAt: new Date("2026-09-03T12:00:00.000Z") },
    });

    // A newer service arrives, which restarts the count for this vehicle.
    await db.service.create({
      data: {
        id: `${P}-svc-newer`,
        customerId: `${P}-cust`,
        vehicleId: `${P}-veh-a`,
        unitId: `${P}-unit`,
        performedAt: new Date("2026-06-01T12:00:00.000Z"),
        kind: "troca de óleo",
        origin: "omie",
      },
    });
    const reconciled = await reconcileVehicleReturns(createDb(db), { vehicleIds: [`${P}-veh-a`] });

    expect(reconciled.superseded).toBe(1);
    // The old return is history, so a reminder about its date would tell the
    // customer something a newer service has already replaced.
    expect(reconciled.remindersCancelled).toBe(1);
    const stopped = await db.scheduledMessage.findMany({
      where: { returnReminderMessageId: created.reminderMessageId, id: { not: sentId } },
    });
    expect(stopped.every((row) => row.status === "CANCELLED")).toBe(true);
    expect(stopped[0]?.lastError).toBe("O retorno foi substituído por um serviço mais recente.");
    const sent = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sentId } });
    expect(sent.status).toBe("SENT");

    // Put the fixture back: the newer service and the return it opened would
    // otherwise change what the remaining tests find.
    await db.vehicleReturn.deleteMany({
      where: { vehicleId: `${P}-veh-a`, sourceServiceId: `${P}-svc-newer` },
    });
    await db.service.delete({ where: { id: `${P}-svc-newer` } });
    await db.vehicleReturn.update({ where: { id: returnId }, data: { status: "OPEN" } });
  });

  it("moves one return's date, clears its rule link, and moves no other return", async () => {
    const db = prisma as PrismaClient;
    await clearReminders();
    const editedId = await openReturnId(`${P}-veh-a`);
    const untouchedId = await openReturnId(`${P}-veh-b`);
    // The rule link the edit must clear, recorded on the return as the rule
    // that dated it would be.
    await db.intervalRule.create({
      data: {
        id: `${P}-rule`,
        version: 1,
        criterion: "kind",
        criterionId: `${P}-kind`,
        intervalAmount: 6,
        intervalUnit: "months",
        priority: 1,
        active: true,
      },
    });
    await db.vehicleReturn.update({
      where: { id: editedId },
      data: { intervalRuleId: `${P}-rule`, intervalRuleVersion: 1 },
    });
    const before = await db.vehicleReturn.findUniqueOrThrow({ where: { id: untouchedId } });

    const result = await setVehicleReturnDate(createDb(db), {
      returnId: editedId,
      returnDate: "2026-11-20",
    });

    // No reminders on this return at this point, so nothing moved with it.
    expect(result).toEqual({
      status: "ok",
      returnDate: "2026-11-20",
      moved: 0,
      cancelled: 0,
      kept: 0,
    });
    const edited = await db.vehicleReturn.findUniqueOrThrow({ where: { id: editedId } });
    expect(edited.returnDate.toISOString().slice(0, 10)).toBe("2026-11-20");
    // Null records that this date no longer came from a rule; the rule row itself
    // is untouched, so no other car's cadence changed.
    expect(edited.intervalRuleId).toBeNull();
    expect(await db.intervalRule.count({ where: { id: `${P}-rule` } })).toBe(1);
    const untouched = await db.vehicleReturn.findUniqueOrThrow({ where: { id: untouchedId } });
    expect(untouched.returnDate.toISOString()).toBe(before.returnDate.toISOString());

    // The edit is authoritative: reconcile re-dates nothing, so an import
    // sweeping every vehicle does not quietly undo it.
    await reconcileVehicleReturns(createDb(db), { vehicleIds: [`${P}-veh-a`, `${P}-veh-b`] });
    const afterReconcile = await db.vehicleReturn.findUniqueOrThrow({ where: { id: editedId } });
    expect(afterReconcile.returnDate.toISOString().slice(0, 10)).toBe("2026-11-20");

    await expect(
      setVehicleReturnDate(createDb(db), { returnId: editedId, returnDate: "20/11/2026" }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("moves only an open return, refusing an archived, superseded or unknown one", async () => {
    const db = prisma as PrismaClient;
    const returnId = await openReturnId(`${P}-veh-b`);
    const before = await db.vehicleReturn.findUniqueOrThrow({ where: { id: returnId } });

    // Archived: absent from both Follow-up sections and both counts, so an edit
    // here would be a change nobody could see land. Unarchive first.
    await db.vehicleReturn.update({ where: { id: returnId }, data: { status: "ARCHIVED" } });
    const archived = await setVehicleReturnDate(createDb(db), { returnId, returnDate: "2026-12-01" });
    const afterArchived = await db.vehicleReturn.findUniqueOrThrow({ where: { id: returnId } });

    // Superseded: history a newer service replaced.
    await db.vehicleReturn.update({ where: { id: returnId }, data: { status: "SUPERSEDED" } });
    const superseded = await setVehicleReturnDate(createDb(db), { returnId, returnDate: "2026-12-01" });
    const afterSuperseded = await db.vehicleReturn.findUniqueOrThrow({ where: { id: returnId } });
    await db.vehicleReturn.update({ where: { id: returnId }, data: { status: "OPEN" } });

    // Distinct outcomes, because the two need different Portuguese reasons.
    expect(archived).toEqual({ status: "archived" });
    expect(superseded).toEqual({ status: "superseded" });
    expect(afterArchived.returnDate.toISOString()).toBe(before.returnDate.toISOString());
    expect(afterSuperseded.returnDate.toISOString()).toBe(before.returnDate.toISOString());
    expect(
      await setVehicleReturnDate(createDb(db), { returnId: `${P}-missing`, returnDate: "2026-12-01" }),
    ).toEqual({ status: "not_found" });
  });
});
