/**
 * Test design (testing-strategy)
 *
 * Exercises the cadastro engine (`customers/contracts/cadastro-engine`) (`applyVehicleFieldEdit`,
 * `ingestOmieSnapshot`) against the real cadastro store,
 * `createPrismaCadastroStore` in `apps/api/src/cadastro/prisma.ts`. Relocated
 * from `packages/omie/src/n-vehicles.test.ts`: `packages/db` depends on
 * `packages/omie`, so the Prisma adapter cannot live in the Omie package (D6).
 *
 * Moved from `apps/api/src/cadastro/omie/n-vehicles.test.ts`
 * (adopt-modular-vertical-slices 4B): the store is now `createCadastroStore(db)`
 * and runs every call under `module_customers`.
 *
 * Setup: the real cadastro store on a rolled-back transaction + createFakeOmie.
 *
 * Fake-only assertion surfaced: the titular rules are an ORDER BY in the adapter
 * (`[{ createdAt: "asc" }, { id: "asc" }]`) and a sort in the fake, and the fake
 * let a test choose both keys — `seedVehicle({ id: "veh-a" | "veh-b" })` made the
 * tie-break assertion true by construction, since the test picked which id was
 * smaller. Postgres assigns the id (a cuid), so the tie-break it now creates two
 * vehicles with an identical `createdAt` and asserts the titular is whichever of
 * the two generated ids actually sorts first — a fact about the query, not about
 * the fixture. The fake also accepted `seedVehicle` for a customer that did not
 * exist; `vehicle.customer_id` has a foreign key, so the extra car now genuinely
 * belongs to the same customer, which is what "extra vehicle isolation" means.
 *
 * `CARACTERISTICA_CAMPOS` is not part of the kernel's `erp-mock` barrel, so
 * this file declares the two labels it needs and pins them to the package's own
 * reader (`readSnapshotField`) in the first it — if a label ever changes, that
 * pin fails rather than the fixtures silently describing a wire shape nothing
 * produces.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md Axis 1–2 and
 * specs/customer-vehicles + specs/omie-sync extra-vehicle isolation.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * Axis 1 — persist count (EP + BVA on vehicle count)
 *   0 list []; 1 that row is titular; 2 both readable, oldest titular
 *   Same createdAt → smaller id is titular
 *
 * Axis 2 — Omie isolation (EP)
 *   Linked extra plate edit: adapter 0, titular plate unchanged, no extra
 *     VehicleFieldSync
 *   Omie-only snapshot plate: titular follows R3; extra plate unchanged
 *
 * Outputs: O-list, O-titular, O-no-adapter, O-extra-untouched
 *
 * Sampled-cell
 *   list 0 / get titular 0                  | Axis 1 n=0 | [] / null
 *   one vehicle is titular                  | Axis 1 n=1 | that id
 *   two vehicles oldest titular             | Axis 1 n=2 | older id first
 *   same createdAt smaller id titular       | Axis 1 tie | the smaller generated id
 *   extra plate persist no Omie             | Axis 2     | putCount 0
 *   snapshot plate skips extra              | Axis 2     | extra plate kept
 *
 * Decision map (getVehicleForCustomer / applyVehicleFieldEdit)
 *   D1 vehicles.length === 0     T: null; F: sort
 *   D2 createdAt unequal         T: older; F: id compare
 *   D3 target is titular         T: applyCrmEdit/409; F: column write
 *   D4 extra seedSync            T: never in extra path; F: titular plate still has sync
 *
 * Out of scope: HTTP 404/409 (API inject); N owners; live Omie.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { applyVehicleFieldEdit, ingestOmieSnapshot } from "../../contracts/cadastro-engine/index.js";
import { createFakeOmie, emptySnapshot, readSnapshotField } from "../../../../kernel/clients/erp-mock.js";
import { emptySync } from "../../contracts/cadastro-store/port.js";
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

/** Omie característica labels this file builds; pinned to the reader below. */
const CAMPOS = { plate: "Placa" } as const;

/** Omie ids are unique in Postgres, so every test coins its own. */
function newOmieId(): string {
  return `omie-n-${randomUUID().slice(0, 8)}`;
}

/** A customer with no vehicles, plus a store on the same transaction. */
async function seedCustomer(tx: DbClient, input: { omieId?: string | null } = {}) {
  const unit = await seedUnit(tx);
  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      omieId: input.omieId ?? null,
      unitId: unit.id,
      origin: "CRM",
      status: "active",
    },
  });
  const store = storeOn(tx);
  return { unit, customer, store };
}

/** A linked customer with a titular and one extra car, both really its own. */
async function seedLinkedTwoCars(tx: DbClient) {
  const omieId = newOmieId();
  const { unit, customer, store } = await seedCustomer(tx, { omieId });
  const fake = createFakeOmie();
  const older = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      plate: "TITULAR1",
      origin: "CRM",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  });
  const newer = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      plate: "EXTRA001",
      origin: "CRM",
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    },
  });
  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    caracteristicas: [{ campo: CAMPOS.plate, conteudo: "TITULAR1" }],
  });
  await tx.vehicleFieldSync.create({
    data: {
      vehicleId: older.id,
      ...emptySync("plate"),
      lastAttemptedAt: null,
      localVersion: 1,
      externalVersion: 1,
      syncedLocalVersion: 1,
      syncedExternalVersion: 1,
      lastOmieWire: "TITULAR1",
      origin: "CRM",
    },
  });
  return { store, fake, unit, customer, older, newer, omieId };
}

describeWithDatabase("Axis 1 persist count", () => {
  const db = () => prisma as PrismaClient;

  it("builds its caracteristica labels the way the package reads them", () => {
    const snapshot = {
      ...emptySnapshot(),
      caracteristicas: [{ campo: CAMPOS.plate, conteudo: "ABC1D23" }],
    };

    const read = readSnapshotField(snapshot, "plate");

    expect(read.status).toBe("value");
    expect(read.status === "value" ? read.wire : null).toBe("ABC1D23");
  });

  it("lists zero vehicles and returns a null titular", () =>
    withTestTransaction(db(), async (tx) => {
      const { customer, store } = await seedCustomer(tx);

      expect(await store.listVehicles(customer.id)).toEqual([]);
      expect(await store.getVehicleForCustomer(customer.id)).toBeNull();
    }));

  it("treats a single vehicle as titular", () =>
    withTestTransaction(db(), async (tx) => {
      const { customer, store } = await seedCustomer(tx);
      const only = await tx.vehicle.create({
        data: { customerId: customer.id, origin: "CRM" },
      });

      expect((await store.getVehicleForCustomer(customer.id))?.id).toBe(only.id);
      expect(await store.listVehicles(customer.id)).toHaveLength(1);
    }));

  it("keeps the oldest createdAt vehicle as titular when a second car is added", () =>
    withTestTransaction(db(), async (tx) => {
      const { customer, store } = await seedCustomer(tx);
      const older = await tx.vehicle.create({
        data: {
          customerId: customer.id,
          origin: "CRM",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      });
      await store.createVehicle({
        id: `veh-new-${randomUUID().slice(0, 8)}`,
        customerId: customer.id,
        omieId: null,
        plate: "ABC1D23",
        make: null,
        model: null,
        version: null,
        year: null,
        odometerKm: null,
        origin: "crm",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      });

      const listed = await store.listVehicles(customer.id);
      expect(listed).toHaveLength(2);
      expect(listed[0]?.id).toBe(older.id);
      expect((await store.getVehicleForCustomer(customer.id))?.id).toBe(older.id);
    }));

  it("breaks equal createdAt ties with the smaller id", () =>
    withTestTransaction(db(), async (tx) => {
      const { customer, store } = await seedCustomer(tx);
      const stamp = new Date("2026-08-01T00:00:00.000Z");
      const first = await tx.vehicle.create({
        data: { customerId: customer.id, origin: "CRM", createdAt: stamp },
      });
      const second = await tx.vehicle.create({
        data: { customerId: customer.id, origin: "CRM", createdAt: stamp },
      });
      // Postgres assigns the ids, so which one wins is a fact about the ORDER BY
      // rather than something this fixture chose.
      const smaller = [first.id, second.id].sort()[0];
      expect(first.createdAt.getTime()).toBe(second.createdAt.getTime());

      expect((await store.getVehicleForCustomer(customer.id))?.id).toBe(smaller);
    }));
});

describeWithDatabase("Axis 2 Omie isolation", () => {
  const db = () => prisma as PrismaClient;

  it("persists an extra vehicle plate without writing Omie or field-sync", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unit, customer, newer } = await seedLinkedTwoCars(tx);
      expect(await store.getSync({ vehicleId: newer.id }, "plate")).toBeNull();

      const result = await applyVehicleFieldEdit(store, fake, {
        vehicleId: newer.id,
        unitId: unit.id,
        patch: { plate: "NEWPLATE" },
      });

      expect(result.status).toBe("ok");
      expect((await store.getVehicle(newer.id))?.plate).toBe("NEWPLATE");
      expect((await store.getVehicleForCustomer(customer.id))?.plate).toBe("TITULAR1");
      expect(fake.putCount()).toBe(0);
      expect(await store.getSync({ vehicleId: newer.id }, "plate")).toBeNull();
    }));

  it("applies an Omie-only plate to the titular and leaves the extra plate", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customer, newer, omieId } = await seedLinkedTwoCars(tx);
      const snap = (await fake.get(omieId))!;
      snap.caracteristicas = [{ campo: CAMPOS.plate, conteudo: "OMIEPLATE" }];
      fake.seed(omieId, snap);

      await ingestOmieSnapshot(store, fake, customer.id);

      expect((await store.getVehicleForCustomer(customer.id))?.plate).toBe("OMIEPLATE");
      expect((await store.getVehicle(newer.id))?.plate).toBe("EXTRA001");
      expect(fake.putCount()).toBe(0);
    }));
});
