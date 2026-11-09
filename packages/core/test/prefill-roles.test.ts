/**
 * Test design (testing-strategy) — prefill writes only its own two tables
 *
 * Requirement (4C.1): `git grep -E "(customer|vehicle|conversation)\.(create|update|upsert)"
 *   packages/core/src/modules/prefill` returns nothing — prefill never writes the
 *   cadastro or the conversation itself. That grep also matches the tests' own
 *   fixture setup (a raw, role-less `tx` seeding customers and vehicles), so this
 *   file states the same requirement over the module's SOURCE, and adds the
 *   database's half.
 *
 * How it is shown, in two halves that together close it (as scheduling-roles):
 *   1. THE DATABASE REFUSES THE REST. Under `module_prefill`, a write to
 *      `customer` or `vehicle` (customers') or `conversation` (conversations')
 *      is refused by Postgres; writes to the two owned tables are accepted (the
 *      positive control, so the refusals are not a role that can write nothing).
 *   2. NOTHING RUNS OUTSIDE A MODULE ROLE. The module's source is scanned: it
 *      never touches `.client`, and every Prisma write it makes names one of the
 *      two owned delegates. The customer, its vehicle, the thread link, the
 *      switch, the labels and the watermark go through `customers`' and
 *      `conversations`' contracts, which run under their owners' roles.
 *
 * Each refusal sits in its own test, so each failure's cause is unambiguous.
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
  withTestTransaction,
} from "../src/testing/index.js";

const db = () => prisma as PrismaClient;
const MODULE_DIR = resolve(import.meta.dirname, "../src/modules/prefill");

/** The two tables `ownership.json` gives prefill, as Prisma delegates. */
const OWNED_DELEGATES = new Set(["cadastroPrefillJob", "cadastroPrefillSuggestion"]);

/** A conversation linked to a customer with a vehicle, for the writes below to aim at. */
async function seedTargets(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({
    data: { unitId: unit.id, origin: "whatsapp", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "whatsapp" }, select: { id: true } });
  await tx.conversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
  return { conversationId: conversation.id, customerId: customer.id, vehicleId: vehicle.id };
}

function asPrefill<T>(tx: DbClient, fn: (inner: DbClient) => Promise<T>) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("prefill", fn);
}

describeWithDatabase("module_prefill at the database", () => {
  it("may write cadastro_prefill_job and cadastro_prefill_suggestion", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);

      await asPrefill(tx, async (inner) => {
        const job = await inner.cadastroPrefillJob.create({
          data: { conversationId: t.conversationId, status: "succeeded" },
          select: { id: true },
        });
        await inner.cadastroPrefillSuggestion.create({
          data: { conversationId: t.conversationId, fields: { name: "Ana" }, jobId: job.id, extractedAt: new Date() },
        });
      });

      expect(await tx.cadastroPrefillSuggestion.count({ where: { conversationId: t.conversationId } })).toBe(1);
    }));

  it("is refused a write to customer, customers' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asPrefill(tx, (inner) => inner.customer.update({ where: { id: t.customerId }, data: { name: "Ana" } })),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to vehicle, customers' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asPrefill(tx, (inner) => inner.vehicle.update({ where: { id: t.vehicleId }, data: { year: 2020 } })),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to conversation, conversations' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asPrefill(tx, (inner) =>
          inner.conversation.update({ where: { id: t.conversationId }, data: { prefillExtractEnabled: true } }),
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

describe("prefill's source", () => {
  const files = sourceFiles(MODULE_DIR);
  const WRITE = /\.(\w+)\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(/g;

  it("scans a real module: the files exist and they do write", () => {
    // Positive control: a scan of nothing, or a pattern that matches nothing,
    // would pass the two checks below vacuously.
    expect(files.length).toBeGreaterThan(10);
    const writes = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(WRITE)]);
    expect(writes.length).toBeGreaterThan(3);
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
