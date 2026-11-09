/**
 * Test design (testing-strategy)
 *
 * Continues `update-customer.engine.integration.test.ts`, whose test-design
 * header (axes, sampled-cell table, decision map, infeasible branches) covers
 * every case here. Split out of `apps/api/src/cadastro/omie/engine.test.ts`
 * (adopt-modular-vertical-slices 4B) for the 300-line cap; the store is now
 * `createCadastroStore`, which runs every call under `module_customers`.
 *
 * Holds: Axis 2 open pending (P1, P2), Axis 4 caracteristica length BVA
 * (plate 59 / 60 / 61), Axis 5 adapter skip (unparseable KM), and the pure
 * `getBusinessValue` switch. The helpers are duplicated from the first file,
 * because slice test files do not import each other.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { applyCrmEdit, getBusinessValue, ingestOmieSnapshot } from "../../contracts/cadastro-engine/index.js";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { emptySync, type CustomerRecord, type FieldSyncRow, type VehicleRecord } from "../../contracts/cadastro-store/port.js";
import { describe, expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";

/** Omie característica labels this file builds; pinned to the reader in the first file. */
const CAMPOS = { plate: "Placa", odometerKm: "KM" } as const;

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

/** The plate característica currently stored on the fake's snapshot. */
function plateConteudo(snapshot: { caracteristicas: { campo: string; conteudo: string }[] } | null) {
  return snapshot?.caracteristicas.find((row) => row.campo === CAMPOS.plate)?.conteudo;
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

describeWithDatabase("Axis 2 open pending", () => {
  const db = () => prisma as PrismaClient;

  it("P1: CRM edit while pending persists and bumps localVersion but does not send", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, omieId } = await seedLinked(tx);
      await store.saveOpenPending({
        fieldKey: "name",
        crmValue: "Ana",
        omieValue: "OMIE",
        localVersion: 2,
        externalVersion: 2,
        status: "open",
        customerId,
        vehicleId: null,
      });
      await tx.customerFieldSync.update({
        where: { customerId_fieldKey: { customerId, fieldKey: "name" } },
        data: { localVersion: 2, syncedLocalVersion: 1, externalVersion: 2, syncedExternalVersion: 1 },
      });

      await applyCrmEdit(store, fake, { customerId, unitId, patch: { name: "Carla" } });

      expect((await store.getCustomer(customerId))?.name).toBe("Carla");
      expect((await store.getSync({ customerId }, "name"))?.localVersion).toBe(3);
      expect(fake.putCount()).toBe(0);
      expect((await fake.get(omieId))?.razao_social).toBe("Ana");
    }));

  it("P2: Omie snapshot while pending may bump externalVersion but does not apply", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId, omieId } = await seedLinked(tx);
      await store.saveOpenPending({
        fieldKey: "name",
        crmValue: "Ana",
        omieValue: "OMIE",
        localVersion: 2,
        externalVersion: 2,
        status: "open",
        customerId,
        vehicleId: null,
      });
      await tx.customerFieldSync.update({
        where: { customerId_fieldKey: { customerId, fieldKey: "name" } },
        data: {
          localVersion: 2,
          syncedLocalVersion: 1,
          externalVersion: 2,
          syncedExternalVersion: 1,
          lastOmieWire: "OMIE",
        },
      });
      fake.seed(omieId, { ...(await fake.get(omieId))!, razao_social: "OMIE-NEW" });

      await ingestOmieSnapshot(store, fake, customerId);

      expect((await store.getCustomer(customerId))?.name).toBe("Ana");
      expect((await store.getSync({ customerId }, "name"))?.externalVersion).toBe(3);
      expect(fake.putCount()).toBe(0);
    }));
});

describeWithDatabase("Axis 4 caracteristica length BVA", () => {
  const db = () => prisma as PrismaClient;

  it.each([
    { n: 59, shouldSync: true },
    { n: 60, shouldSync: true },
  ])("plate length $n sends and updates synced*", ({ n }) =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, vehicleId, omieId } = await seedLinked(tx);
      const plate = "p".repeat(n);

      await applyCrmEdit(store, fake, { customerId, unitId, patch: { plate } });

      const sync = await store.getSync({ vehicleId }, "plate");
      expect(sync?.syncedLocalVersion).toBe(sync?.localVersion);
      expect(plateConteudo(await fake.get(omieId))).toBe(plate);
    }));

  it("plate length 61 fails the adapter write, leaves synced* unchanged, and does not truncate", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, vehicleId, omieId } = await seedLinked(tx);
      const before = await store.getSync({ vehicleId }, "plate");

      await applyCrmEdit(store, fake, { customerId, unitId, patch: { plate: "p".repeat(61) } });

      const sync = await store.getSync({ vehicleId }, "plate");
      expect(sync?.syncedLocalVersion).toBe(before?.syncedLocalVersion);
      expect(sync?.localVersion).toBe((before?.localVersion ?? 0) + 1);
      const stored = plateConteudo(await fake.get(omieId));
      expect(stored).toBe("ABC1D23");
      expect(stored).toHaveLength(7);
    }));
});

describeWithDatabase("Axis 5 adapter skip", () => {
  const db = () => prisma as PrismaClient;

  it("skips unparseable KM on ingest without bumping externalVersion", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId, vehicleId, omieId } = await seedLinked(tx);
      await tx.vehicleFieldSync.create({
        data: { vehicleId, ...synced("odometerKm", "100") },
      });
      const snap = (await fake.get(omieId))!;
      snap.caracteristicas.push({ campo: CAMPOS.odometerKm, conteudo: "nao-e-numero" });
      fake.seed(omieId, snap);

      await ingestOmieSnapshot(store, fake, customerId);

      expect((await store.getSync({ vehicleId }, "odometerKm"))?.externalVersion).toBe(1);
      expect((await store.getVehicleForCustomer(customerId))?.odometerKm).toBeNull();
    }));
});

describe("getBusinessValue switch", () => {
  const customer: CustomerRecord = {
    id: "cus-pure",
    name: "Ana",
    omieId: null,
    taxId: "39053344705",
    unitId: "unit-pure",
    givenName: null,
    familyName: null,
    mergedIntoId: null,
    street: "Rua A",
    streetNumber: "10",
    neighborhood: "Centro",
    complement: "ap 1",
    city: "Sao Paulo",
    state: "SP",
    postalCode: "01310100",
    country: "br",
    origin: "CRM",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    phones: [
      {
        raw: "+55 11 99999-0000",
        normalized: "5511999990000",
        isPrimary: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    emails: [{ raw: "ana@example.com", normalized: "ana@example.com", isPrimary: true }],
  };
  const vehicle: VehicleRecord = {
    id: "veh-pure",
    customerId: customer.id,
    omieId: null,
    plate: "ABC1D23",
    make: "VW",
    model: "Gol",
    version: null,
    year: null,
    odometerKm: 12000,
    origin: "CRM",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it.each([
    ["name", "Ana"],
    ["taxId", "39053344705"],
    ["primaryPhone", "5511999990000"],
    ["primaryEmail", "ana@example.com"],
    ["street", "Rua A"],
    ["streetNumber", "10"],
    ["neighborhood", "Centro"],
    ["complement", "ap 1"],
    ["city", "Sao Paulo"],
    ["state", "SP"],
    ["postalCode", "01310100"],
    ["country", "br"],
    ["plate", "ABC1D23"],
    ["make", "VW"],
    ["model", "Gol"],
    ["odometerKm", 12000],
  ] as const)("reads %s from the customer or titular vehicle", (fieldKey, expected) => {
    expect(getBusinessValue(customer, vehicle, fieldKey)).toBe(expected);
  });

  it("returns null for vehicle keys when there is no titular vehicle", () => {
    expect(getBusinessValue(customer, null, "plate")).toBeNull();
    expect(getBusinessValue(customer, null, "make")).toBeNull();
    expect(getBusinessValue(customer, null, "model")).toBeNull();
    expect(getBusinessValue(customer, null, "odometerKm")).toBeNull();
  });
});
