/**
 * Test design (testing-strategy) — scheduling writes only its own two tables
 *
 * Requirement (3B.1): "no write outside `scheduled_message` /
 *   `return_reminder_message` occurs (the role test for this module)".
 *
 * How it is shown, in two halves that together close it:
 *   1. THE DATABASE REFUSES THE REST. Under `module_scheduling`, a write to
 *      `vehicle_return` (services'), `outbox_message` (channel's) or
 *      `conversation` (conversations') is refused by Postgres; writes to the two
 *      owned tables are accepted (the positive control, so the refusals are not
 *      a role that can write nothing). Every scheduling slice runs its queries in
 *      `db.tx("scheduling", …)`, so a stray write would fail there, in its own
 *      slice test, not here.
 *   2. NOTHING RUNS OUTSIDE A MODULE ROLE. The one way round (1) is a write on
 *      the raw client, `db.client`, which carries no role. The module's source
 *      is scanned: it never touches `.client`, and every Prisma write it makes
 *      names one of the two owned delegates. Writes to other modules' tables go
 *      through their contracts — `enqueueOutbound` / `cancelOutbound`
 *      (channel) and `archiveVehicleReturn` / `unarchiveVehicleReturn`
 *      (services) — which run under their owners' roles.
 *
 * Why a scan and not a recording client, as erp's run-pull roles test used: a
 *   recorder tags each write with the `db.tx` it was issued through, and
 *   channel's contract joins scheduling's transaction through a handle built on
 *   the same client, so its `outbox_message` write would be tagged `scheduling`
 *   although it ran under `module_channel`. The database is the authority on
 *   roles; the scan only has to prove nothing bypasses it.
 *
 * Each refusal sits in its own test. A refused statement inside `db.tx` rolls
 * back to the kernel's savepoint, so the transaction would survive, but one
 * refusal per test keeps each failure's cause unambiguous.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it, describe } from "vitest";
import { createDb } from "../src/kernel/db.js";
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
const MODULE_DIR = resolve(import.meta.dirname, "../src/modules/scheduling");

/** The two tables `ownership.json` gives scheduling, as Prisma delegates. */
const OWNED_DELEGATES = new Set(["scheduledMessage", "returnReminderMessage"]);

/** A loja, attendant, conversation and an OPEN return, for the writes below to aim at. */
async function seedTargets(tx: DbClient) {
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
  return { userId: user.id, conversationId: conversation.id, returnId: vehicleReturn.id };
}

function asScheduling<T>(tx: DbClient, fn: (inner: DbClient) => Promise<T>) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("scheduling", fn);
}

describeWithDatabase("module_scheduling at the database", () => {
  it("may write scheduled_message and return_reminder_message", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);

      const written = await asScheduling(tx, async (inner) => {
        const message = await inner.returnReminderMessage.create({
          data: { vehicleReturnId: t.returnId, bodyTemplate: "x", createdByUserId: t.userId },
          select: { id: true },
        });
        await inner.scheduledMessage.create({
          data: {
            conversationId: t.conversationId,
            returnReminderMessageId: message.id,
            frozenText: "x",
            scheduledAt: new Date("2099-01-01T12:00:00.000Z"),
            status: "SCHEDULED",
            idempotencyKey: randomUUID(),
            createdByUserId: t.userId,
          },
        });
        return message.id;
      });

      expect(await tx.scheduledMessage.count({ where: { returnReminderMessageId: written } })).toBe(1);
    }));

  it("is refused a write to vehicle_return, services' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asScheduling(tx, (inner) =>
          inner.vehicleReturn.update({ where: { id: t.returnId }, data: { status: "ARCHIVED" } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to outbox_message, channel's table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asScheduling(tx, (inner) =>
          inner.outboxMessage.create({ data: { conversationId: t.conversationId, textBody: "x", status: "queued" } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to conversation, conversations' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asScheduling(tx, (inner) =>
          inner.conversation.update({ where: { id: t.conversationId }, data: { lastMessageAt: new Date() } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    }));
});

/** Every non-test `.ts` file under the module. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "tests" ? [] : sourceFiles(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("scheduling's source", () => {
  const files = sourceFiles(MODULE_DIR);
  const WRITE = /\.(\w+)\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(/g;

  it("scans a real module: the files exist and they do write", () => {
    // Positive control: a scan of nothing, or a pattern that matches nothing,
    // would pass the two checks below vacuously.
    expect(files.length).toBeGreaterThan(10);
    const writes = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(WRITE)]);
    expect(writes.length).toBeGreaterThan(5);
  });

  it("writes only through the two owned delegates", () => {
    const foreign = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(WRITE)]
        .filter((match) => !OWNED_DELEGATES.has(match[1] as string))
        .map((match) => `${file}: ${match[0]}`),
    );
    expect(foreign).toEqual([]);
  });

  it("never reaches the raw client, which carries no module role", () => {
    const raw = files.filter((file) => /\bdb\.client\b|\.client\s*as\b/.test(readFileSync(file, "utf8")));
    expect(raw).toEqual([]);
  });
});
