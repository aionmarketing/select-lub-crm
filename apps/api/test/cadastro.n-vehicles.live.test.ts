/**
 * Test design (testing-strategy)
 *
 * Setup: Prisma when DATABASE_URL is set. Unique ids; delete only rows
 * this file inserted. skipIf when URL missing.
 *
 * Oracle: titular = oldest createdAt among two vehicles (customer-vehicles).
 *
 * Axes
 *   A1 DATABASE_URL present vs missing
 *   A2 vehicle count 2, createdAt ordered
 *
 * Outputs: O1 findFirst id is older row; O2 suite skipped
 *
 * Sampled-cell
 *   URL set, two vehicles     | A1 present A2 n=2 | O1 older id | newer id
 *   URL missing               | A1 missing        | O2 skip     | suite runs live
 *
 * Decision map
 *   D1 skipIf(!DATABASE_URL) T: CI without URL; F: this file's it
 *   D2 findFirst orderBy createdAt asc T: oldId; F: would return newId
 *
 * Out of scope: HTTP inject (cadastro.vehicles.test.ts); drop-unique SQL
 * (migration file).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernel } from "@select-lub/core";
import { createCadastroStore } from "@select-lub/core/modules/customers";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { withConnectRetry } from "@select-lub/core/testing";

const repoRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();

describe.skipIf(!live)("live n vehicles titular", () => {
  const runId = randomUUID();
  const customerId = `cus-nveh-${runId}`;
  const oldId = `veh-old-${runId}`;
  const newId = `veh-new-${runId}`;
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let unitId = "";

  beforeAll(async () => {
    // Migrating here raced the other live files and duplicated work the whole
    // project now does once, in this Vitest config's `globalSetup`.
    const db = await import("@select-lub/core/db");
    const client = db.prisma;
    if (!client) {
      throw new Error("expected PrismaClient when DATABASE_URL is set");
    }
    prisma = withConnectRetry(client);
    const unit = await prisma.unit.create({ data: { name: `nveh-${runId}` } });
    unitId = unit.id;
    await prisma.customer.create({
      data: {
        id: customerId,
        name: "Ana",
        unitId,
        origin: "test",
        status: "active",
      },
    });
    await prisma.vehicle.create({
      data: {
        id: oldId,
        customerId,
        plate: "OLDPLATE",
        origin: "test",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    await prisma.vehicle.create({
      data: {
        id: newId,
        customerId,
        plate: "NEWPLATE",
        origin: "test",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.vehicle.deleteMany({ where: { id: { in: [oldId, newId] } } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    if (unitId) {
      await prisma.unit.deleteMany({ where: { id: unitId } });
    }
  });

  it("selects the older vehicle as titular", async () => {
    const store = createCadastroStore(kernel.createDb(prisma));
    const titular = await store.getVehicleForCustomer(customerId);
    expect(titular?.id).toBe(oldId);
    const listed = await store.listVehicles(customerId);
    expect(listed.map((row) => row.id)).toEqual([oldId, newId]);
  });
});
