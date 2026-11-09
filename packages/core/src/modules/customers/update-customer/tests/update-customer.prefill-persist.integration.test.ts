/**
 * Test design (testing-strategy)
 *
 * Exercises the cadastro engine (`customers/contracts/cadastro-engine`) (`persistPrefillAccept`, and
 * `applyCrmEdit` beneath it) against the real cadastro store,
 * `createPrismaCadastroStore` in `apps/api/src/cadastro/prisma.ts`. Relocated from
 * `packages/omie/src/prefill-persist.test.ts`: `packages/db` depends on
 * `packages/omie`, so the Prisma adapter cannot live in the Omie package (D6).
 *
 * Moved from `apps/api/src/cadastro/omie/prefill-persist.test.ts`
 * (adopt-modular-vertical-slices 4B): the store is now `createCadastroStore(db)`
 * and runs every call under `module_customers`. It still calls
 * `persistPrefillAccept` directly, not `contracts/apply-prefill-suggestion`.
 *
 * Setup: persistPrefillAccept + the real cadastro store on a rolled-back
 * transaction + createFakeOmie (the Omie side stays faked; only the store is real).
 *
 * Fake-only assertion surfaced: the fake's `seedVehicle` took an arbitrary
 * `customerId`, so "the customer has no vehicle" and "the vehicle belongs to
 * someone else" were the same fixture. Postgres restricts `vehicle.customer_id`
 * to a real customer, so the no-vehicle cells now genuinely have none, and the
 * `unit_mismatch` cell's customer is a real member of a real unit rather than a
 * free-floating string. Each no-vehicle cell now asserts the precondition
 * (`getVehicleForCustomer` is null) that on the fake was merely assumed.
 *
 * Oracle: assistive-prefill accept persist — unlinked shared writes CRM
 * without Omie; linked shared uses applyCrmEdit; version/year are column-only.
 *
 * Axes
 *   A1 customer: missing | wrong unit | present
 *   A2 omieId: null vs set
 *   A3 field: year | version | shared plate | shared name
 *   A4 vehicle: present vs absent
 *
 * Outputs: O-ok adapter 0; O-ok applyCrmEdit; O-not_found; O-unit_mismatch
 *
 * Sampled-cell
 *   missing customer          | not_found
 *   unit mismatch             | unit_mismatch
 *   unlinked plate + vehicle  | ok adapter 0, plate set
 *   unlinked name no vehicle  | ok adapter 0, name set
 *   unlinked plate no vehicle | not_found
 *   unlinked year + vehicle   | ok adapter 0, year set
 *   unlinked year no vehicle  | not_found
 *   linked version + vehicle  | ok adapter 0 (before Omie)
 *   linked name               | applyCrmEdit putCount > 0
 *
 * Decision map (persistPrefillAccept)
 *   D1 !customer                T: missing it; F: the rest
 *   D2 unitId mismatch          T: mismatch it; F: matching unit
 *   D3 version/year             T: year/version its; F: plate/name
 *   D4 !vehicle in year/version T: year no vehicle; F: year/version with vehicle
 *   D5 field === version        T: linked version; F: year its
 *   D6 omieId set               T: linked name; F: unlinked shared
 *   D7 PREFILL_SHARED_KEYS F    infeasible at typed PrefillFieldKey after D3
 *   D8 isVehicleField && !veh   T: plate no vehicle; F: plate with vehicle
 *   D9 if (vehicle) save        T: unlinked plate; F: unlinked name no vehicle
 *   D10 owner ternary           T: plate vehicleId; F: name customerId
 *
 * Out of scope: HTTP 409 PATCH (cadastro.prefill.test.ts);
 * persist status not_linked — applyCrmEdit's omieId-null path is unreachable
 * because persistPrefillAccept only calls applyCrmEdit when omieId is set.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { persistPrefillAccept } from "../../contracts/cadastro-engine/index.js";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
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

/**
 * Seeds a unit and one customer, optionally with a vehicle, inside the given
 * transaction, and returns them with a store bound to that same transaction.
 *
 * @param tx - The test transaction.
 * @param input - Optional customer `name`, `omieId`, and whether to add a vehicle.
 * @returns The seeded unit, customer, vehicle (or null) and the cadastro store.
 */
async function seedCadastro(
  tx: DbClient,
  input: { name?: string | null; omieId?: string | null; withVehicle?: boolean } = {},
) {
  const unit = await seedUnit(tx);
  const customer = await tx.customer.create({
    data: {
      name: input.name ?? "Ana",
      omieId: input.omieId ?? null,
      unitId: unit.id,
      origin: "CRM",
      status: "active",
    },
  });
  const vehicle = input.withVehicle
    ? await tx.vehicle.create({ data: { customerId: customer.id, origin: "CRM" } })
    : null;
  const store = storeOn(tx);
  return { unit, customer, vehicle, store };
}

describeWithDatabase("persistPrefillAccept", () => {
  const db = () => prisma as PrismaClient;

  it("returns not_found when the customer is missing", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, store } = await seedCadastro(tx);
      const fake = createFakeOmie();
      const missingId = `missing-${randomUUID().slice(0, 8)}`;
      expect(await store.getCustomer(missingId)).toBeNull();

      const result = await persistPrefillAccept(store, fake, {
        customerId: missingId,
        unitId: unit.id,
        field: "plate",
        value: "ABC1D23",
      });

      expect(result.status).toBe("not_found");
      expect(fake.putCount()).toBe(0);
    }));

  it("returns unit_mismatch when the customer belongs to another unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { customer, store } = await seedCadastro(tx, { name: "Ana" });
      const other = await seedUnit(tx);
      const fake = createFakeOmie();

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: other.id,
        field: "name",
        value: "Ana Souza",
      });

      expect(result.status).toBe("unit_mismatch");
      expect((await store.getCustomer(customer.id))?.name).toBe("Ana");
    }));

  it("persists an unlinked plate without writing Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, customer, vehicle, store } = await seedCadastro(tx, {
        name: "5511999999999",
        withVehicle: true,
      });
      const fake = createFakeOmie();
      const vehicleId = vehicle?.id ?? "";
      expect((await store.getVehicle(vehicleId))?.plate).toBeNull();

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        field: "plate",
        value: "ABC1D23",
      });

      expect(result.status).toBe("ok");
      expect((await store.getVehicle(vehicleId))?.plate).toBe("ABC1D23");
      expect(fake.putCount()).toBe(0);
    }));

  it("persists an unlinked name without a vehicle and without writing Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, customer, store } = await seedCadastro(tx, { name: "5511999999999" });
      const fake = createFakeOmie();

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        field: "name",
        value: "Ana Souza",
      });

      expect(result.status).toBe("ok");
      expect((await store.getCustomer(customer.id))?.name).toBe("Ana Souza");
      expect(fake.putCount()).toBe(0);
    }));

  it("returns not_found for an unlinked plate when the customer has no vehicle", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, customer, store } = await seedCadastro(tx, { name: "5511999999999" });
      const fake = createFakeOmie();
      expect(await store.getVehicleForCustomer(customer.id)).toBeNull();

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        field: "plate",
        value: "ABC1D23",
      });

      expect(result.status).toBe("not_found");
    }));

  it("writes an unlinked year on the vehicle without Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, customer, vehicle, store } = await seedCadastro(tx, { withVehicle: true });
      const fake = createFakeOmie();
      const vehicleId = vehicle?.id ?? "";

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        field: "year",
        value: 2020,
      });

      expect(result.status).toBe("ok");
      expect((await store.getVehicle(vehicleId))?.year).toBe(2020);
      expect(fake.putCount()).toBe(0);
    }));

  it("returns not_found for year when the customer has no vehicle", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, customer, store } = await seedCadastro(tx);
      const fake = createFakeOmie();
      expect(await store.getVehicleForCustomer(customer.id)).toBeNull();

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        field: "year",
        value: 2020,
      });

      expect(result.status).toBe("not_found");
    }));

  it("writes a linked version on the vehicle without Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const linked = `omie-prefill-${randomUUID().slice(0, 8)}`;
      const { unit, customer, vehicle, store } = await seedCadastro(tx, {
        omieId: linked,
        withVehicle: true,
      });
      const fake = createFakeOmie();
      fake.seed(linked, { ...emptySnapshot(), razao_social: "Ana" });
      const vehicleId = vehicle?.id ?? "";

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        field: "version",
        value: "1.0 Comfort",
      });

      expect(result.status).toBe("ok");
      expect((await store.getVehicle(vehicleId))?.version).toBe("1.0 Comfort");
      expect(fake.putCount()).toBe(0);
    }));

  it("sends a linked name through applyCrmEdit", () =>
    withTestTransaction(db(), async (tx) => {
      const linked = `omie-prefill-${randomUUID().slice(0, 8)}`;
      const { unit, customer, store } = await seedCadastro(tx, { omieId: linked });
      const fake = createFakeOmie();
      fake.seed(linked, { ...emptySnapshot(), razao_social: "Ana" });

      const result = await persistPrefillAccept(store, fake, {
        customerId: customer.id,
        unitId: unit.id,
        field: "name",
        value: "Ana Souza",
      });

      expect(result.status).toBe("ok");
      expect(fake.putCount()).toBeGreaterThan(0);
      expect((await store.getCustomer(customer.id))?.name).toBe("Ana Souza");
    }));
});
