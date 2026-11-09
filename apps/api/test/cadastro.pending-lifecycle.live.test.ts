/**
 * Test design (testing-strategy)
 *
 * Setup: Prisma CadastroStore + real Postgres when DATABASE_URL is set.
 * Unique ids; delete only this file's rows. skipIf when URL missing.
 *
 * Oracle: schema-review-hardening omie-sync delta — at most one open
 * pending per owner+field (partial unique); a closed pending is retained;
 * a later dual-change inserts a new open row; listings return only open.
 *
 * Axes
 *   A1 saveOpenPending concurrency — sequential update vs Promise.all race
 *   A2 prior pending status — open vs non-open
 *   A3 listing filter — open only
 *
 * Outputs: O1 one open row; O2 two rows total after close+dual; O3 list=open
 *
 * Sampled-cell
 *   concurrent saves same field | A1 race A2 open | O1 | two open rows
 *   dual-change after close     | A2 non-open     | O2+O3 | overwrite / list both
 *
 * Decision map (saveOpenPending + partial unique)
 *   open row present? T update; F create
 *   create P2002? T retry update once; F keep created
 *   listOpenPendings status=open T listed; F retained, hidden
 *
 * Out of scope: memory store (cannot enforce the partial unique);
 *   resolve route (cadastro-reconciliation-backend).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clients, kernel } from "@select-lub/core";
import { createCadastroStore, ingestOmieSnapshot } from "@select-lub/core/modules/customers";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { withConnectRetry } from "@select-lub/core/testing";

const repoRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();

describe.skipIf(!live)("pending lifecycle against Postgres", () => {
  const runId = randomUUID();
  const customerId = `cus-pend-${runId}`;
  const vehicleId = `veh-pend-${runId}`;
  const omieId = `omie-pend-${runId}`;
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let unitId = "";

  beforeAll(async () => {
    // Migrate and seed happen once for the whole project, in this Vitest
    // config's `globalSetup`. Doing it here raced the other live files on
    // Prisma's select-then-insert `upsert` — HANDOFF.md item 5.
    const db = await import("@select-lub/core/db");
    const client = db.prisma;
    if (!client) {
      throw new Error("expected PrismaClient when DATABASE_URL is set");
    }
    prisma = withConnectRetry(client);
    const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc";
    const connection = await prisma.whatsAppConnection.findUniqueOrThrow({
      where: { instanceName },
    });
    unitId = connection.unitId;
    await prisma.customer.create({
      data: {
        id: customerId,
        name: "Ana",
        omieId,
        unitId,
        postalCode: "01310100",
        origin: "test",
        status: "active",
      },
    });
    await prisma.vehicle.create({
      data: {
        id: vehicleId,
        customerId,
        plate: "ABC1D23",
        origin: "test",
      },
    });
    await prisma.customerFieldSync.create({
      data: {
        customerId,
        fieldKey: "postalCode",
        origin: "CRM",
        localVersion: 2,
        externalVersion: 2,
        syncedLocalVersion: 1,
        syncedExternalVersion: 1,
        lastOmieWire: "01310100",
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.customerReconciliationPending.deleteMany({ where: { customerId } });
    await prisma.vehicleReconciliationPending.deleteMany({ where: { vehicleId } });
    await prisma.customerFieldSync.deleteMany({ where: { customerId } });
    await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
  });

  it("keeps one open pending across a raced save, then a new row after close", async () => {
    const store = createCadastroStore(kernel.createDb(prisma));
    const pending = {
      fieldKey: "postalCode" as const,
      crmValue: "CRMCEP12",
      omieValue: "OMIECEP1",
      localVersion: 2,
      externalVersion: 2,
      status: "open" as const,
      customerId,
      vehicleId: null,
    };

    await Promise.all([
      store.saveOpenPending(pending),
      store.saveOpenPending({ ...pending, crmValue: "CRMCEP99" }),
    ]);

    const afterRace = await prisma.customerReconciliationPending.findMany({
      where: { customerId, fieldKey: "postalCode", status: "open" },
    });
    expect(afterRace).toHaveLength(1);

    await prisma.customerReconciliationPending.update({
      where: { id: afterRace[0]!.id },
      data: { status: "resolved" },
    });

    const customer = (await store.getCustomer(customerId))!;
    customer.postalCode = "NEWCRM01";
    await store.saveCustomer(customer);
    const fake = clients.omie.createFakeOmie();
    fake.seed(omieId, { ...clients.omie.emptySnapshot(), cep: "NEWOMIE01" });
    await ingestOmieSnapshot(store, fake, customerId);

    const all = await prisma.customerReconciliationPending.findMany({
      where: { customerId, fieldKey: "postalCode" },
    });
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.status === "open")).toHaveLength(1);
    expect(all.filter((row) => row.status === "resolved")).toHaveLength(1);

    const listed = await store.listOpenPendings(customerId);
    expect(listed.filter((row) => row.fieldKey === "postalCode")).toHaveLength(1);
    expect(listed[0]?.status).toBe("open");
  });
});
