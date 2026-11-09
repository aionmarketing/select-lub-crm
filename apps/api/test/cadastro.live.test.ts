/**
 * Test design (testing-strategy)
 *
 * Setup: Prisma CadastroStore when DATABASE_URL is set. Unique ids; delete
 * only rows this file inserted. skipIf when URL missing.
 *
 * Oracle: same R2 + R4 as the cadastro engine tests, against CRM Postgres.
 * GET pendings with another unit's x-unit-id is 404 (omie-sync unit mismatch).
 *
 * P1 VALID — URL set: R2 postalCode send + R4 pending, then teardown
 * P2 VALID — URL missing: skipped
 * P3 INVALID — GET pendings as other unit → 404
 * P4 VALID — GET pendings as owning unit → 200
 *
 * Decision map (cadastro/routes.ts GET pendings): customer.unitId !== unitId T → 404;
 * F → 200 list.
 *
 * The caller is a REAL `user` row with real `user_unit` memberships, created in
 * `beforeAll` with a generated id and removed in `afterAll` before the lojas it
 * points at (memberships first: unit deletion is Restrict). It used to be
 * `seededMemoryAuth(...)`, an in-memory auth store — the last fake this file
 * built. `getUser` stays injected, because Supabase JWT validation is an
 * external port rather than a store; the token now resolves to this file's own
 * user id instead of the shared `TEST_USER_ID`, so six live files can hold
 * committed caller rows at once without colliding on one id or deleting each
 * other's.
 *
 * ASSERTION THAT ONLY HELD ON THE FAKE: the caller's memberships were a string
 * array handed to the fake, so the 200s and 403s below were decided from that
 * array. `user_unit.unit_id` is a foreign key to `unit`, so a membership now
 * requires the loja to exist, and the auth hook decides from rows it reads.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clients, kernel } from "@select-lub/core";
import {
  applyCrmEdit,
  createCadastroStore,
  ingestOmieSnapshot,
} from "@select-lub/core/modules/customers";
import { buildApp } from "../src/app.js";
import { createFakeGetUser } from "@select-lub/core/testing";
import { withConnectRetry, seedUser } from "@select-lub/core/testing";
import { TEST_ACCESS_TOKEN } from "@select-lub/core/testing";
import { shouldRunLiveTests } from "@select-lub/core/db";

const repoRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();

describe.skipIf(!live)("live cadastro engine", () => {
  const runId = randomUUID();
  /** The caller: a real `user` row, not the memory auth store's literal. */
  const callerUserId = randomUUID();
  const callerEmail = `caller-${runId}@test.local`;
  const customerId = `cus-live-${runId}`;
  const vehicleId = `veh-live-${runId}`;
  const omieId = `omie-live-${runId}`;
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let app!: Awaited<ReturnType<typeof buildApp>>;
  let unitId = "";
  let unitBId = "";

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
        localVersion: 1,
        externalVersion: 1,
        syncedLocalVersion: 1,
        syncedExternalVersion: 1,
        lastOmieWire: "01310100",
      },
    });
    const unitB = await prisma.unit.create({ data: { name: `cad-b-${runId}` } });
    unitBId = unitB.id;
    // The caller's CRM row and memberships, committed like every other row
    // in this file and cleaned up in `afterAll` before the lojas.
    await seedUser(prisma, {
      id: callerUserId,
      units: [unitId],
      email: callerEmail,
      name: `Caller ${runId}`,
    });
    app = await buildApp({
      db: prisma,
      getUser: createFakeGetUser({
        [TEST_ACCESS_TOKEN]: { id: callerUserId, email: callerEmail },
      }),
    });
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (!prisma) {
      return;
    }
    // Memberships before the lojas they point at: unit deletion is Restrict.
    await prisma.userUnit.deleteMany({ where: { userId: callerUserId } });
    await prisma.user.deleteMany({ where: { id: callerUserId } });
    await prisma.customerReconciliationPending.deleteMany({ where: { customerId } });
    await prisma.vehicleReconciliationPending.deleteMany({ where: { vehicleId } });
    await prisma.customerFieldSync.deleteMany({ where: { customerId } });
    await prisma.vehicleFieldSync.deleteMany({ where: { vehicleId } });
    await prisma.customerPhone.deleteMany({ where: { customerId } });
    await prisma.customerEmail.deleteMany({ where: { customerId } });
    await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    if (unitBId) {
      await prisma.unit.deleteMany({ where: { id: unitBId } });
    }
  });

  it("replays CRM-only R2 and dual-change R4 against Postgres", async () => {
    const store = createCadastroStore(kernel.createDb(prisma));
    const fake = clients.omie.createFakeOmie();
    fake.seed(omieId, {
      ...clients.omie.emptySnapshot(),
      razao_social: "Ana",
      cep: "01310100",
    });

    const r2 = await applyCrmEdit(store, fake, {
      customerId,
      unitId,
      patch: { postalCode: "22041080" },
    });
    expect(r2.status).toBe("ok");
    expect((await fake.get(omieId))?.cep).toBe("22041080");

    await prisma.customerFieldSync.update({
      where: { customerId_fieldKey: { customerId, fieldKey: "postalCode" } },
      data: {
        localVersion: 3,
        externalVersion: 1,
        syncedLocalVersion: 2,
        syncedExternalVersion: 1,
        lastOmieWire: "22041080",
      },
    });
    const customer = (await store.getCustomer(customerId))!;
    customer.postalCode = "CRMCEP12";
    await store.saveCustomer(customer);
    fake.seed(omieId, { ...(await fake.get(omieId))!, cep: "OMIECEP1" });
    await ingestOmieSnapshot(store, fake, customerId);

    expect((await store.getCustomer(customerId))?.postalCode).toBe("CRMCEP12");
    expect((await store.getOpenPending({ customerId }, "postalCode"))?.status).toBe("open");
  });

  it("returns 403 for pendings when x-unit-id is another unit", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/customers/${customerId}/reconciliation-pendings`,
      headers: { "x-unit-id": unitBId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 200 for pendings when x-unit-id matches the customer unit", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/customers/${customerId}/reconciliation-pendings`,
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });
});
