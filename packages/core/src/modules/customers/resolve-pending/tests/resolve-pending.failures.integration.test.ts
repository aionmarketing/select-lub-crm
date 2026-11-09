/**
 * Test design (testing-strategy) — customers / resolve-pending, part 2 of 3:
 * the Omie put failing, and the closes that write nothing to Omie.
 *
 * The full design — axes, outputs, sampled cells, decision map, oracle and the
 * fake-only assertions surfaced — is the header of
 * `resolve-pending.choices.integration.test.ts`. Moved from
 * `apps/api/src/cadastro/omie/resolve-pending.test.ts` (adopt-modular-vertical-slices
 * 4B); the store runs every call under `module_customers`.
 *
 * Cases here:
 *   failed put throw leaves pending open         | A3 throw | O5
 *   close retains the row with resolved_by       | A1 omie  | O1
 *   edit without value throws                    | A1 edit  | O4
 *   crm on unlinked customer closes without put  | A4 null  | O8
 *   failedKeys on overlong plate leaves open     | A3 keys  | O5
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { CONTEUDO_MAX, createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { emptySync } from "../../contracts/cadastro-store/port.js";
import { ingestOmieSnapshot, resolvePending } from "../../contracts/cadastro-engine/index.js";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";

/**
 * The cadastro store over the test's transaction; every call runs in its own
 * `db.tx("customers", …)`, so under `module_customers`.
 *
 * @param tx - The test transaction.
 * @returns The store.
 */
function storeOn(tx: DbClient) {
  return createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
}

const actorId = "11111111-1111-1111-1111-111111111111";

/** Omie ids are unique in Postgres, so every test coins its own. */
function newOmieId(): string {
  return `omie-resolve-${randomUUID().slice(0, 8)}`;
}

/**
 * Seeds a linked customer with one vehicle and an open pending on the given
 * field, inside the test's transaction.
 *
 * @param tx - The test transaction.
 * @param fieldKey - Which field carries the open pending.
 * @returns The store, the fake Omie, and the seeded ids.
 */
async function seedPending(tx: DbClient, fieldKey: "postalCode" | "name" = "postalCode") {
  const store = storeOn(tx);
  const fake = createFakeOmie();
  const unit = await seedUnit(tx);
  const omieId = newOmieId();
  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      omieId,
      unitId: unit.id,
      postalCode: fieldKey === "postalCode" ? "CRMCEP12" : "01310100",
      origin: "CRM",
      status: "active",
    },
  });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "CRM" } });
  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    cep: fieldKey === "postalCode" ? "OMIECEP1" : "01310100",
  });
  if (fieldKey === "postalCode") {
    await tx.customerFieldSync.create({
      data: {
        customerId: customer.id,
        ...emptySync("postalCode"),
        lastAttemptedAt: null,
        localVersion: 2,
        externalVersion: 2,
        syncedLocalVersion: 1,
        syncedExternalVersion: 1,
        lastOmieWire: "01310100",
      },
    });
    await ingestOmieSnapshot(store, fake, customer.id);
  } else {
    await store.saveOpenPending({
      fieldKey: "name",
      crmValue: "Ana",
      omieValue: "Casa Velha",
      localVersion: 2,
      externalVersion: 2,
      status: "open",
      customerId: customer.id,
      vehicleId: null,
    });
    await tx.customerFieldSync.create({
      data: {
        customerId: customer.id,
        ...emptySync("name"),
        lastAttemptedAt: null,
        localVersion: 2,
        externalVersion: 2,
        syncedLocalVersion: 1,
        syncedExternalVersion: 1,
        lastOmieWire: "Ana",
      },
    });
  }
  return { store, fake, unitId: unit.id, customerId: customer.id, vehicleId: vehicle.id, omieId };
}

describeWithDatabase("resolvePending", () => {
  const db = () => prisma as PrismaClient;

  it("leaves the pending open when the Omie put throws", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedPending(tx);
      fake.failPuts();

      const result = await resolvePending(store, fake, {
        customerId,
        unitId,
        fieldKey: "postalCode",
        vehicleId: null,
        choice: "crm",
        actorId,
      });

      expect(result.status).toBe("omie_unavailable");
      expect((await store.getCustomer(customerId))?.postalCode).toBe("CRMCEP12");
      expect((await store.getOpenPending({ customerId }, "postalCode"))?.status).toBe("open");
    }));

  it("retains the closed row with resolved_by_user_id and does not delete it", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedPending(tx);
      const before = await tx.customerReconciliationPending.count({ where: { customerId } });
      expect(before).toBeGreaterThan(0);

      await resolvePending(store, fake, {
        customerId,
        unitId,
        fieldKey: "postalCode",
        vehicleId: null,
        choice: "omie",
        actorId,
      });

      const rows = await tx.customerReconciliationPending.findMany({ where: { customerId } });
      expect(rows).toHaveLength(before);
      expect(rows[0]?.status).toBe("resolved");
      expect(rows[0]?.resolvedByUserId).toBe(actorId);
    }));

  it("throws not-found when edit is missing value", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedPending(tx, "name");

      await expect(
        resolvePending(store, fake, {
          customerId,
          unitId,
          fieldKey: "name",
          vehicleId: null,
          choice: "edit",
          actorId,
        }),
      ).rejects.toThrow("pending_not_found");
      expect((await store.getCustomer(customerId))?.name).toBe("Ana");
    }));

  it("closes an unlinked crm resolve without calling Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const store = storeOn(tx);
      const fake = createFakeOmie();
      const unit = await seedUnit(tx);
      const customer = await tx.customer.create({
        data: { name: "Ana", omieId: null, unitId: unit.id, origin: "CRM", status: "active" },
      });
      await store.saveOpenPending({
        fieldKey: "name",
        crmValue: "Ana",
        omieValue: "Casa Velha",
        localVersion: 2,
        externalVersion: 2,
        status: "open",
        customerId: customer.id,
        vehicleId: null,
      });

      const result = await resolvePending(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        fieldKey: "name",
        vehicleId: null,
        choice: "crm",
        actorId,
      });

      expect(result.status).toBe("ok");
      expect(fake.putCount()).toBe(0);
      expect(await store.getOpenPending({ customerId: customer.id }, "name")).toBeNull();
    }));

  it("leaves the pending open when put returns the field in failedKeys", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, vehicleId, omieId } = await seedPending(tx);
      const overlong = "P".repeat(CONTEUDO_MAX + 1);
      const vehicle = await store.getVehicle(vehicleId);
      await store.saveVehicle({ ...vehicle!, plate: overlong });
      await store.saveOpenPending({
        fieldKey: "plate",
        crmValue: overlong,
        omieValue: "ABC1D23",
        localVersion: 2,
        externalVersion: 2,
        status: "open",
        customerId,
        vehicleId,
      });

      const result = await resolvePending(store, fake, {
        customerId,
        unitId,
        fieldKey: "plate",
        vehicleId,
        choice: "crm",
        actorId,
      });

      expect((await store.getCustomer(customerId))?.omieId).toBe(omieId);
      expect(result.status).toBe("omie_unavailable");
      expect((await store.getOpenPending({ vehicleId }, "plate"))?.status).toBe("open");
    }));
});
