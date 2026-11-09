/**
 * Test design (testing-strategy) — services writes only its own four tables
 *
 * Requirement (3C.1): the services code runs under `module_services`, and
 * `git grep -E "scheduledMessage\.(create|update|updateMany)"
 * packages/core/src/modules/services` returns nothing — every `scheduled_message`
 * write goes through `scheduling`'s contract. This file is that check, kept.
 *
 * How it is shown, in two halves that together close it (the shape of
 * `scheduling-roles.test.ts`):
 *   1. THE DATABASE REFUSES THE REST. Under `module_services`, a write to
 *      `scheduled_message` (scheduling's), `customer` (customers') or
 *      `conversation` (conversations') is refused by Postgres; writes to the four
 *      owned tables are accepted (the positive control, so the refusals are not a
 *      role that can write nothing).
 *   2. NOTHING RUNS OUTSIDE A MODULE ROLE. The one way round (1) is a write on
 *      the raw client, `db.client`, which carries no role — which is exactly what
 *      the reconcile did until 3C (W3-C3). The module's source is scanned: it
 *      never touches `.client`, and every Prisma write it makes names one of the
 *      four owned delegates. `scheduled_message` is changed only through
 *      `scheduling/contracts/reminder-rows.ts`, which runs under its owner's role.
 *
 * Which role a nested contract call actually runs under is shown with a
 * recorder that asks Postgres, in `erp`'s `run-pull.roles.integration.test.ts`
 * (the reconcile case). Each refusal sits in its own test, one cause per failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { describe, expect, it } from "vitest";
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
const MODULE_DIR = resolve(import.meta.dirname, "../src/modules/services");

/** The four tables `ownership.json` gives services, as Prisma delegates. */
const OWNED_DELEGATES = new Set(["service", "serviceItem", "vehicleReturn", "intervalRule"]);

/** A loja, a customer with a car, a conversation, and a reminder row to aim at. */
async function seedTargets(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({
    data: { origin: "crm", status: "active", unitId: unit.id },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, origin: "crm" },
    select: { id: true },
  });
  const reminder = await tx.scheduledMessage.create({
    data: {
      conversationId: conversation.id,
      frozenText: "x",
      scheduledAt: new Date("2099-01-01T12:00:00.000Z"),
      status: "SCHEDULED",
      idempotencyKey: `roles-${unit.id}`,
      createdByUserId: user.id,
    },
    select: { id: true },
  });
  return {
    unitId: unit.id,
    customerId: customer.id,
    vehicleId: vehicle.id,
    conversationId: conversation.id,
    reminderId: reminder.id,
  };
}

function asServices<T>(tx: DbClient, fn: (inner: DbClient) => Promise<T>) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("services", fn);
}

describeWithDatabase("module_services at the database", () => {
  it("may write service, service_item, vehicle_return and interval_rule", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);

      const serviceId = await asServices(tx, async (inner) => {
        const service = await inner.service.create({
          data: {
            customerId: t.customerId,
            vehicleId: t.vehicleId,
            unitId: t.unitId,
            origin: "omie",
            performedAt: new Date("2026-03-01T12:00:00.000Z"),
          },
          select: { id: true },
        });
        await inner.serviceItem.create({ data: { serviceId: service.id, description: "Óleo" } });
        const rule = await inner.intervalRule.create({
          data: {
            version: 1,
            criterion: "kind",
            criterionId: `roles-${t.unitId}`,
            intervalAmount: 6,
            intervalUnit: "months",
            priority: 1,
            active: true,
          },
          select: { id: true },
        });
        await inner.vehicleReturn.create({
          data: {
            vehicleId: t.vehicleId,
            sourceServiceId: service.id,
            returnDate: new Date("2026-09-01T00:00:00.000Z"),
            status: "OPEN",
            intervalRuleId: rule.id,
            intervalRuleVersion: 1,
          },
        });
        return service.id;
      });

      expect(await tx.serviceItem.count({ where: { serviceId } })).toBe(1);
      expect(await tx.vehicleReturn.count({ where: { sourceServiceId: serviceId } })).toBe(1);
    }));

  it("is refused a write to scheduled_message, scheduling's table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asServices(tx, (inner) =>
          inner.scheduledMessage.update({ where: { id: t.reminderId }, data: { status: "CANCELLED" } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to customer, customers' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asServices(tx, (inner) =>
          inner.customer.update({ where: { id: t.customerId }, data: { name: "x" } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to conversation, conversations' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asServices(tx, (inner) =>
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

describe("services' source", () => {
  const files = sourceFiles(MODULE_DIR);
  const WRITE = /\.(\w+)\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(/g;

  it("scans a real module: the files exist and they do write", () => {
    // Positive control: a scan of nothing, or a pattern that matches nothing,
    // would pass the two checks below vacuously.
    expect(files.length).toBeGreaterThan(10);
    const writes = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(WRITE)]);
    expect(writes.length).toBeGreaterThan(5);
  });

  it("writes only through the four owned delegates", () => {
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
