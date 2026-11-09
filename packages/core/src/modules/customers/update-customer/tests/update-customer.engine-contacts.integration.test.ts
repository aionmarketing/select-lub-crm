/**
 * Test design (testing-strategy)
 *
 * Continues `update-customer.engine.integration.test.ts`, whose test-design
 * header (axes, sampled-cell table, decision map, and the three fake-only
 * assertions surfaced — the merge target, the phone row shape, the contact
 * order) covers every case here. Split out of
 * `apps/api/src/cadastro/omie/engine.test.ts` (adopt-modular-vertical-slices 4B)
 * for the 300-line cap; the store is now `createCadastroStore`, which runs every
 * call under `module_customers`.
 *
 * Holds: Axis 3 field kind — CRM-only columns, primaryPhone creation, and the D5
 * promote-instead-of-duplicate cases for phone and e-mail. The helpers are
 * duplicated from the first file, because slice test files do not import each
 * other.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { applyCrmEdit } from "../../contracts/cadastro-engine/index.js";
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

/** The three contact fields under test, ordered so the assertion is about the set. */
function contacts(rows: readonly { raw: string; normalized: string; isPrimary: boolean }[]) {
  return [...rows]
    .map((row) => ({ raw: row.raw, normalized: row.normalized, isPrimary: row.isPrimary }))
    .sort((left, right) => left.normalized.localeCompare(right.normalized));
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

describeWithDatabase("Axis 3 field kind", () => {
  const db = () => prisma as PrismaClient;

  it("persists CRM-only columns without calling the adapter", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      // A real merge target: merged_into_id is a foreign key, so the fake's
      // dangling "cus-base" was not a state this column can hold.
      const base = await tx.customer.create({
        data: { name: "Base", unitId, origin: "CRM", status: "active" },
      });

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { givenName: "Ana", familyName: "Silva", mergedInto: base.id },
      });

      const customer = await store.getCustomer(customerId);
      expect(customer?.givenName).toBe("Ana");
      expect(customer?.familyName).toBe("Silva");
      expect(customer?.mergedIntoId).toBe(base.id);
      expect(fake.putCount()).toBe(0);
      expect(await store.getSync({ customerId }, "name")).toMatchObject({ localVersion: 1 });
    }));

  it("R2 primaryPhone creates the isPrimary row when missing", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, omieId } = await seedLinked(tx);
      expect((await store.getCustomer(customerId))?.phones).toEqual([]);

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { primaryPhone: "11988887777" },
      });

      const customer = await store.getCustomer(customerId);
      expect(contacts(customer!.phones)).toEqual([
        { raw: "11988887777", normalized: "11988887777", isPrimary: true },
      ]);
      expect((await fake.get(omieId))?.telefone).toBe("11988887777");
    }));

  it("promotes an existing secondary phone instead of creating a duplicate", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, omieId } = await seedLinked(tx);
      const customer = (await store.getCustomer(customerId))!;
      await store.saveCustomer({
        ...customer,
        phones: [
          { raw: "11 11111-1111", normalized: "5511111111111", isPrimary: true },
          { raw: "11 22222-2222", normalized: "5511222222222", isPrimary: false },
        ],
      });
      await tx.customerFieldSync.create({
        data: { customerId, ...synced("primaryPhone", "5511111111111") },
      });

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { primaryPhone: "5511222222222" },
      });

      const phones = (await store.getCustomer(customerId))!.phones;
      expect(phones.filter((row) => row.normalized === "5511222222222")).toHaveLength(1);
      expect(contacts(phones.filter((row) => row.isPrimary))).toEqual([
        { raw: "11 22222-2222", normalized: "5511222222222", isPrimary: true },
      ]);
      expect((await fake.get(omieId))?.telefone).toBe("5511222222222");
    }));

  it("promotes when the primary is edited to a secondary's number", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      const customer = (await store.getCustomer(customerId))!;
      await store.saveCustomer({
        ...customer,
        phones: [
          { raw: "1111", normalized: "1111", isPrimary: true },
          { raw: "2222", normalized: "2222", isPrimary: false },
        ],
      });
      await tx.customerFieldSync.create({
        data: { customerId, ...synced("primaryPhone", "1111") },
      });

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { primaryPhone: "2222" },
      });

      expect(contacts((await store.getCustomer(customerId))!.phones)).toEqual([
        { raw: "1111", normalized: "1111", isPrimary: false },
        { raw: "2222", normalized: "2222", isPrimary: true },
      ]);
    }));

  it("mutates the primary phone in place when the number is new", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      const customer = (await store.getCustomer(customerId))!;
      await store.saveCustomer({
        ...customer,
        phones: [{ raw: "1111", normalized: "1111", isPrimary: true }],
      });
      await tx.customerFieldSync.create({
        data: { customerId, ...synced("primaryPhone", "1111") },
      });

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { primaryPhone: "9999" },
      });

      expect(contacts((await store.getCustomer(customerId))!.phones)).toEqual([
        { raw: "9999", normalized: "9999", isPrimary: true },
      ]);
    }));

  it("promotes an existing secondary email instead of creating a duplicate", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      const customer = (await store.getCustomer(customerId))!;
      await store.saveCustomer({
        ...customer,
        emails: [
          { raw: "A@Example.com", normalized: "a@example.com", isPrimary: true },
          { raw: "B@Example.com", normalized: "b@example.com", isPrimary: false },
        ],
      });
      await tx.customerFieldSync.create({
        data: { customerId, ...synced("primaryEmail", "a@example.com") },
      });

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { primaryEmail: "b@example.com" },
      });

      const emails = (await store.getCustomer(customerId))!.emails;
      expect(emails.filter((row) => row.normalized === "b@example.com")).toHaveLength(1);
      expect(contacts(emails.filter((row) => row.isPrimary))).toEqual([
        { raw: "B@Example.com", normalized: "b@example.com", isPrimary: true },
      ]);
    }));
});
