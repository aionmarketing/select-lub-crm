/**
 * Test design (testing-strategy)
 *
 * Continues `update-customer.engine.integration.test.ts`, whose test-design
 * header (applyVehicleFieldEdit branches, Axis 6, and the infeasible branches
 * named there) covers every case here. Split out of
 * `apps/api/src/cadastro/omie/engine.test.ts` (adopt-modular-vertical-slices 4B)
 * for the 300-line cap; the store is now `createCadastroStore`, which runs every
 * call under `module_customers`.
 *
 * Holds: the applyVehicleFieldEdit column patch (shared columns, plate clear,
 * CRM-only columns on the titular, omie_unavailable) and Axis 6 (an unlinked
 * customer; an omieId Omie no longer recognises). The helpers are duplicated
 * from the first file, because slice test files do not import each other.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { applyCrmEdit, applyVehicleFieldEdit } from "../../contracts/cadastro-engine/index.js";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { emptySync, type FieldSyncRow } from "../../contracts/cadastro-store/port.js";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";

/** Omie característica label this file builds; pinned to the reader in the first file. */
const CAMPOS = { plate: "Placa" } as const;

function synced(fieldKey: FieldSyncRow["fieldKey"], wire: string) {
  return {
    ...emptySync(fieldKey),
    lastAttemptedAt: null,
    localVersion: 1,
    externalVersion: 1,
    syncedLocalVersion: 1,
    syncedExternalVersion: 1,
    lastOmieWire: wire,
    origin: "CRM",
  };
}

/** A linked customer with one vehicle and three synced field rows. */
async function seedLinked(tx: DbClient) {
  const store = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
  const fake = createFakeOmie();
  const unit = await seedUnit(tx);
  const omieId = `omie-1-${randomUUID().slice(0, 8)}`;
  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      omieId,
      unitId: unit.id,
      postalCode: "01310100",
      country: "br",
      origin: "CRM",
      status: "active",
    },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: "ABC1D23", omieId: null, origin: "CRM" },
  });
  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    cep: "01310100",
    codigo_pais: "1058",
    caracteristicas: [{ campo: CAMPOS.plate, conteudo: "ABC1D23" }],
  });
  await tx.customerFieldSync.createMany({
    data: [
      { customerId: customer.id, ...synced("name", "Ana") },
      { customerId: customer.id, ...synced("postalCode", "01310100") },
    ],
  });
  await tx.vehicleFieldSync.create({
    data: { vehicleId: vehicle.id, ...synced("plate", "ABC1D23") },
  });
  return { store, fake, unitId: unit.id, customerId: customer.id, vehicleId: vehicle.id, omieId };
}

describeWithDatabase("applyVehicleFieldEdit column patch", () => {
  const db = () => prisma as PrismaClient;

  it("writes make, model, odometer, version, and year on the titular vehicle", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, vehicleId } = await seedLinked(tx);

      const result = await applyVehicleFieldEdit(store, fake, {
        vehicleId,
        unitId,
        patch: { make: "VW", model: "Gol", odometerKm: 8000, version: "1.0", year: 2020 },
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      expect(result.vehicle.make).toBe("VW");
      expect(result.vehicle.model).toBe("Gol");
      expect(result.vehicle.odometerKm).toBe(8000);
      expect(result.vehicle.version).toBe("1.0");
      expect(result.vehicle.year).toBe(2020);
    }));

  it("clears plate when the patch sends null and leaves unpatched columns", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, vehicleId } = await seedLinked(tx);

      const result = await applyVehicleFieldEdit(store, fake, {
        vehicleId,
        unitId,
        patch: { plate: null },
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      expect(result.vehicle.plate).toBeNull();
      expect(result.vehicle.make).toBeNull();
      expect(result.vehicle.year).toBeNull();
    }));

  it("saves version and year on the titular vehicle when the patch carries no shared key", () =>
    withTestTransaction(db(), async (tx) => {
      // The titular-vehicle branch with hasShared false: same body as the
      // non-titular branch above it, but reached only when isTitular is true
      // and the patch is CRM-only columns alone.
      const { store, fake, unitId, vehicleId } = await seedLinked(tx);

      const result = await applyVehicleFieldEdit(store, fake, {
        vehicleId,
        unitId,
        patch: { version: "2.0", year: 2021 },
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      expect(result.vehicle.version).toBe("2.0");
      expect(result.vehicle.year).toBe(2021);
      expect(fake.putCount()).toBe(0);
    }));

  it("reports omie_unavailable with the saved vehicle when a titular shared edit fails to reach Omie", () =>
    withTestTransaction(db(), async (tx) => {
      // The nested applyCrmEdit call's `omie_unavailable` bubbling to
      // ApplyVehicleEditResult — no prior it had driven this specific arm.
      const { store, fake, unitId, vehicleId } = await seedLinked(tx);
      fake.failPuts();

      const result = await applyVehicleFieldEdit(store, fake, {
        vehicleId,
        unitId,
        patch: { make: "Fiat" },
      });

      expect(result.status).toBe("omie_unavailable");
      if (result.status !== "omie_unavailable") {
        return;
      }
      // The CRM save happened before the Omie failure was reported.
      expect(result.vehicle.make).toBe("Fiat");
    }));
});

describeWithDatabase("Axis 6 unlinked customer and an omieId Omie no longer recognises", () => {
  const db = () => prisma as PrismaClient;

  it("persists a shared-field edit locally and never calls Omie when the customer has no omieId", () =>
    withTestTransaction(db(), async (tx) => {
      // decideField's own `!omieId` guard (engine.ts): applyCrmEdit computes
      // `snapshot` from `customer.omieId ? ... : null` but still calls
      // decideField for every patched shared key regardless — this is the
      // guard that actually keeps an unlinked customer's edit from calling
      // Omie. Every prior it in this file seeds a linked customer.
      const store = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
      const fake = createFakeOmie();
      const unit = await seedUnit(tx);
      const customer = await tx.customer.create({
        data: {
          name: "Ana",
          omieId: null,
          unitId: unit.id,
          postalCode: "01310100",
          origin: "CRM",
          status: "active",
        },
      });

      const result = await applyCrmEdit(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        patch: { postalCode: "22041080" },
      });

      expect(result.status).toBe("ok");
      expect(fake.putCount()).toBe(0);
      expect((await store.getCustomer(customer.id))?.postalCode).toBe("22041080");
    }));

  it("opens a pending with an empty Omie placeholder when the stored omieId resolves to nothing", () =>
    withTestTransaction(db(), async (tx) => {
      // A customer record pointing at an omieId Omie has no row for (never
      // seeded into the fake) — decideField's crmAhead-and-omieAhead branch
      // still runs (omieId is truthy, so the `!omieId` guard above does not
      // apply), but `adapter.get` returns null. readSnapshotField is never
      // called, so the pending's omieValue falls back to "" rather than
      // reading a value nobody has.
      const store = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
      const fake = createFakeOmie(); // the phantom id is never fake.seed()-ed
      const unit = await seedUnit(tx);
      const customer = await tx.customer.create({
        data: {
          name: "Ana",
          omieId: `phantom-omie-${randomUUID().slice(0, 8)}`,
          unitId: unit.id,
          postalCode: "01310100",
          origin: "CRM",
          status: "active",
        },
      });
      await tx.customerFieldSync.create({
        data: {
          customerId: customer.id,
          ...emptySync("postalCode"),
          lastAttemptedAt: null,
          localVersion: 1,
          externalVersion: 2,
          syncedLocalVersion: 1,
          syncedExternalVersion: 1,
        },
      });

      const result = await applyCrmEdit(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        patch: { postalCode: "22041080" },
      });

      expect(result.status).toBe("ok");
      expect(fake.putCount()).toBe(0);
      const pending = await store.getOpenPending({ customerId: customer.id }, "postalCode");
      expect(pending?.status).toBe("open");
      expect(pending?.omieValue).toBe("");
      // Neither stored value moved: the CRM edit landed as a normal patch
      // (postalCode is a customer column, always written), but Omie's own
      // conflicting change is not invented from nothing.
      expect((await store.getCustomer(customer.id))?.postalCode).toBe("22041080");
    }));
});
