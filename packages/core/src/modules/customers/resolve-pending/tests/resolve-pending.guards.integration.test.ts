/**
 * Test design (testing-strategy) — customers / resolve-pending, part 3 of 3:
 * the guards that refuse before anything is written.
 *
 * The full design — axes, outputs, sampled cells, decision map, oracle and the
 * fake-only assertions surfaced — is the header of
 * `resolve-pending.choices.integration.test.ts`. Moved from
 * `apps/api/src/cadastro/omie/resolve-pending.test.ts` (adopt-modular-vertical-slices
 * 4B); the store runs every call under `module_customers`.
 *
 * Cases here:
 *   missing pending throws not-found             | A2 miss  | O4
 *   missing customer is not_found                | A5 miss  | O6
 *   unit mismatch is unit_mismatch               | A5 unit  | O7
 *   vehicleId on a person field throws           | A2 pair  | O4
 *   null vehicleId on a plate pending throws     | A2 pair  | O4
 *   vehicleId of another customer's real vehicle | A2 owner | O4 (added 2026-09-07)
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
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

  it("throws not-found when no open pending exists", () =>
    withTestTransaction(db(), async (tx) => {
      const store = storeOn(tx);
      const fake = createFakeOmie();
      const unit = await seedUnit(tx);
      const customer = await tx.customer.create({
        data: {
          name: "Ana",
          omieId: newOmieId(),
          unitId: unit.id,
          origin: "CRM",
          status: "active",
        },
      });
      expect(await store.getOpenPending({ customerId: customer.id }, "postalCode")).toBeNull();
      const before = (await store.getCustomer(customer.id))?.name;

      await expect(
        resolvePending(store, fake, {
          customerId: customer.id,
          unitId: unit.id,
          fieldKey: "postalCode",
          vehicleId: null,
          choice: "crm",
          actorId,
        }),
      ).rejects.toThrow("pending_not_found");
      expect((await store.getCustomer(customer.id))?.name).toBe(before);
    }));

  it("returns not_found when the customer is missing", () =>
    withTestTransaction(db(), async (tx) => {
      const store = storeOn(tx);
      const fake = createFakeOmie();
      const unit = await seedUnit(tx);
      const missingId = `missing-${randomUUID().slice(0, 8)}`;
      expect(await store.getCustomer(missingId)).toBeNull();

      const result = await resolvePending(store, fake, {
        customerId: missingId,
        unitId: unit.id,
        fieldKey: "postalCode",
        vehicleId: null,
        choice: "crm",
        actorId,
      });

      expect(result.status).toBe("not_found");
    }));

  it("returns unit_mismatch when the customer belongs to another unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId } = await seedPending(tx);
      const other = await seedUnit(tx);

      const result = await resolvePending(store, fake, {
        customerId,
        unitId: other.id,
        fieldKey: "postalCode",
        vehicleId: null,
        choice: "crm",
        actorId,
      });

      expect(result.status).toBe("unit_mismatch");
      expect((await store.getOpenPending({ customerId }, "postalCode"))?.status).toBe("open");
    }));

  it("throws not-found when a person field is resolved with a vehicleId", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, vehicleId } = await seedPending(tx);

      await expect(
        resolvePending(store, fake, {
          customerId,
          unitId,
          fieldKey: "postalCode",
          vehicleId,
          choice: "crm",
          actorId,
        }),
      ).rejects.toThrow("pending_not_found");
      expect((await store.getOpenPending({ customerId }, "postalCode"))?.status).toBe("open");
    }));

  it("throws not-found when a plate pending is resolved with a null vehicleId", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, vehicleId } = await seedPending(tx);
      await store.saveOpenPending({
        fieldKey: "plate",
        crmValue: "ABC1D23",
        omieValue: "XYZ9A87",
        localVersion: 2,
        externalVersion: 2,
        status: "open",
        customerId,
        vehicleId,
      });

      await expect(
        resolvePending(store, fake, {
          customerId,
          unitId,
          fieldKey: "plate",
          vehicleId: null,
          choice: "crm",
          actorId,
        }),
      ).rejects.toThrow("pending_not_found");
    }));

  it("throws not-found when the vehicleId names a real vehicle of a different customer", () =>
    withTestTransaction(db(), async (tx) => {
      // Line 605's second clause, `vehicle.customerId !== customer.id` — distinct
      // from the two pairing its above, which both fail the EARLIER field/id XOR
      // guard (person field + a vehicleId; plate field + a null vehicleId) and so
      // never reach this clause. Neither passes a vehicle that genuinely exists
      // and genuinely belongs to someone else, which is what this guards against.
      const { store, fake, unitId, customerId, vehicleId } = await seedPending(tx);
      await store.saveOpenPending({
        fieldKey: "plate",
        crmValue: "ABC1D23",
        omieValue: "XYZ9A87",
        localVersion: 2,
        externalVersion: 2,
        status: "open",
        customerId,
        vehicleId,
      });
      // A second REAL customer, in the same unit, owning a REAL vehicle: on the
      // fake this rival owner did not exist at all.
      const rival = await tx.customer.create({
        data: { name: "Bruno", unitId, origin: "CRM", status: "active" },
      });
      const otherVehicle = await tx.vehicle.create({
        data: { customerId: rival.id, origin: "CRM" },
      });
      expect((await store.getVehicle(otherVehicle.id))?.customerId).toBe(rival.id);

      await expect(
        resolvePending(store, fake, {
          customerId,
          unitId,
          fieldKey: "plate",
          vehicleId: otherVehicle.id,
          choice: "crm",
          actorId,
        }),
      ).rejects.toThrow("pending_not_found");
      expect((await store.getOpenPending({ vehicleId }, "plate"))?.status).toBe("open");
    }));
});
