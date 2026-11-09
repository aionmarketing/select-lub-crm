/**
 * Test design (testing-strategy)
 *
 * Exercises the cadastro engine (`customers/contracts/cadastro-engine`) (`applyCrmEdit`,
 * `ingestOmieSnapshot`) against the real cadastro store,
 * `createPrismaCadastroStore` in `apps/api/src/cadastro/prisma.ts`. Relocated
 * from `packages/omie/src/field-sync-hardening.test.ts`: `packages/db` depends
 * on `packages/omie`, so the Prisma adapter cannot live in the Omie package (D6).
 *
 * Moved from `apps/api/src/cadastro/omie/field-sync-hardening.test.ts`
 * (adopt-modular-vertical-slices 4B); the store is now `createCadastroStore`
 * (contracts/cadastro-store), which runs every call under `module_customers`.
 *
 * Setup: the real cadastro store on a rolled-back transaction + createFakeOmie
 * (or a put-wrapper).
 *
 * Fake-only assertion surfaced: `markSynced`. On the fake it is a read of a Map
 * entry followed by a compare-and-set in the same synchronous turn, so the
 * "drops a stale mark-synced write" it could only ever exercise the engine's own
 * ordering. The adapter implements it as `updateMany` with the expected
 * `localVersion` and `externalVersion` in the WHERE clause and returns
 * `count === 1` — an optimistic-concurrency guard enforced by Postgres. That it
 * now proves the real predicate rejects the stale write, which is the thing the
 * requirement is about; previously it proved only that the engine passed the
 * versions it had read.
 *
 * Recorded, not fixed here: this file's "+2 on localVersion" it names itself
 * concurrent, and it is not. The fake could not race, and neither can the
 * harness — an interactive Prisma transaction runs its statements on one
 * connection, so the two `applyCrmEdit` calls in that `Promise.all` are
 * serialised whatever the test intends. It is a sequential-logic assertion
 * against real SQL, and worth keeping as that; a genuine concurrent-writer test
 * needs two connections and therefore cannot live inside the rollback harness.
 *
 * `CARACTERISTICA_CAMPOS` is not part of the kernel's `erp-mock` barrel, so
 * this file declares the label it needs and pins it to the package's own reader
 * (`readSnapshotField`) in the first it.
 *
 * Oracle: openspec/changes/field-sync-hardening/specs/omie-sync/spec.md —
 * concurrent writes, attempt outcome, responsible actor.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 overlapping CRM bumps — two applyCrmEdit on the same field
 * A2 markSynced guard — versions still match vs a bump during put
 * A3 send outcome — never attempted | ok | toWire fail | put fail+reason |
 *    put fail without reason
 * A4 changed_by — CRM actorId | OMIE_SYNC apply | later attendant overwrite
 *
 * Outputs: O-plus-2, O-guard-miss-no-retry, O-ok, O-failed-frozen,
 * O-never, O-actor, O-omie, O-overwrite
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell
 * ----------------------------------------------------------------------------
 * it                              | rule              | fails if
 * two overlapping edits           | A1 +2             | localVersion !== N+2
 * guard miss during put           | A2 miss           | second put or synced++
 * successful postalCode send      | A3 ok             | last_result not ok
 * plate 61 toWire fail            | A3 fail           | last_error empty / synced++
 * put reject with reason          | A3 fail+reason    | last_error is coarse
 * put reject without reason       | A3 fail+coarse    | last_error not omie_put_rejected
 * seeded synced never sent        | A3 never          | last_result or last_attempted_at set
 * CRM edit actorId                | A4 user           | changed_by not u1
 * Omie-only apply                 | A4 process        | changed_by not OMIE_SYNC
 * later attendant overwrites      | A4 overwrite      | changed_by still OMIE_SYNC
 *
 * ----------------------------------------------------------------------------
 * Decision / branch map (engine.ts decideField send + apply)
 * ----------------------------------------------------------------------------
 * toWire fail? T plate 61; F postalCode ok / put-reject its
 * put.failedKeys? T reason/coarse its; F ok + guard
 * markSynced hit? T ok send / Omie apply; F guard-miss it
 * actorId present? T CRM edit; F Omie apply uses OMIE_SYNC
 *
 * Out of scope: HTTP actor plumbing (update-customer.route.integration.test.ts); a true
 * two-connection concurrent writer, as noted above.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { applyCrmEdit, ingestOmieSnapshot } from "../../contracts/cadastro-engine/index.js";
import { createFakeOmie, emptySnapshot, readSnapshotField, type OmieAdapter } from "../../../../kernel/clients/erp-mock.js";
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

/** Omie característica label this file builds; pinned to the reader below. */
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

describeWithDatabase("concurrent shared-field writes", () => {
  const db = () => prisma as PrismaClient;

  it("builds its caracteristica label the way the package reads it", () => {
    const snapshot = {
      ...emptySnapshot(),
      caracteristicas: [{ campo: CAMPOS.plate, conteudo: "ABC1D23" }],
    };

    const read = readSnapshotField(snapshot, "plate");

    expect(read.status).toBe("value");
    expect(read.status === "value" ? read.wire : null).toBe("ABC1D23");
  });

  it("counts two overlapping CRM edits as +2 on localVersion", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      const before = (await store.getSync({ customerId }, "postalCode"))!.localVersion;

      await Promise.all([
        applyCrmEdit(store, fake, { customerId, unitId, patch: { postalCode: "11111111" } }),
        applyCrmEdit(store, fake, { customerId, unitId, patch: { postalCode: "22222222" } }),
      ]);

      expect((await store.getSync({ customerId }, "postalCode"))?.localVersion).toBe(before + 2);
    }));

  it("drops a stale mark-synced write and does not retry the Omie put", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      const adapter: OmieAdapter = {
        get: (id) => fake.get(id),
        async put(id, fields) {
          await store.bumpLocal({ customerId }, "postalCode", "interleaved");
          return fake.put(id, fields);
        },
      };

      await applyCrmEdit(store, adapter, {
        customerId,
        unitId,
        patch: { postalCode: "22041080" },
      });

      const sync = await store.getSync({ customerId }, "postalCode");
      expect(fake.putCount()).toBe(1);
      expect(sync?.localVersion).toBe(3);
      expect(sync?.syncedLocalVersion).toBe(1);
    }));
});

describeWithDatabase("Omie push attempt outcome", () => {
  const db = () => prisma as PrismaClient;

  it("records ok and clears last_error after a successful send", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      expect((await store.getSync({ customerId }, "postalCode"))?.lastResult).toBeNull();

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { postalCode: "22041080" },
      });

      const sync = await store.getSync({ customerId }, "postalCode");
      expect(sync?.lastResult).toBe("ok");
      expect(sync?.lastError).toBeNull();
      expect(sync?.lastAttemptedAt).toEqual(expect.any(String));
    }));

  it("records failed and freezes synced versions when toWire rejects", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, vehicleId } = await seedLinked(tx);
      const before = await store.getSync({ vehicleId }, "plate");

      await applyCrmEdit(store, fake, { customerId, unitId, patch: { plate: "p".repeat(61) } });

      const sync = await store.getSync({ vehicleId }, "plate");
      expect(sync?.lastResult).toBe("failed");
      expect(sync?.lastError).toBe("wire_mapping_failed");
      expect(sync?.lastAttemptedAt).toEqual(expect.any(String));
      expect(sync?.syncedLocalVersion).toBe(before?.syncedLocalVersion);
      expect(sync?.syncedExternalVersion).toBe(before?.syncedExternalVersion);
    }));

  it("prefers the adapter reason when put rejects a mapped field", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      const adapter: OmieAdapter = {
        get: (id) => fake.get(id),
        async put() {
          return { failedKeys: ["name"], reasons: { name: "omie rejected name" } };
        },
      };

      await applyCrmEdit(store, adapter, { customerId, unitId, patch: { name: "Carla" } });

      const sync = await store.getSync({ customerId }, "name");
      expect(sync?.lastResult).toBe("failed");
      expect(sync?.lastError).toBe("omie rejected name");
      expect(sync?.syncedLocalVersion).toBe(1);
    }));

  it("records omie_put_rejected when put fails without a reason", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);
      const adapter: OmieAdapter = {
        get: (id) => fake.get(id),
        async put() {
          return { failedKeys: ["name"] };
        },
      };

      await applyCrmEdit(store, adapter, { customerId, unitId, patch: { name: "Carla" } });

      expect((await store.getSync({ customerId }, "name"))?.lastError).toBe("omie_put_rejected");
    }));

  it("leaves last_result and last_attempted_at empty on a never-sent row", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, customerId } = await seedLinked(tx);

      const sync = await store.getSync({ customerId }, "name");
      expect(sync?.lastResult).toBeNull();
      expect(sync?.lastAttemptedAt).toBeNull();
    }));
});

describeWithDatabase("responsible actor", () => {
  const db = () => prisma as PrismaClient;

  it("records the CRM actor id after an attendant edit", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedLinked(tx);

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { postalCode: "22041080" },
        actorId: "u1",
      });

      expect((await store.getSync({ customerId }, "postalCode"))?.changedBy).toBe("u1");
    }));

  it("records OMIE_SYNC after an Omie-only apply", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId, omieId } = await seedLinked(tx);
      fake.seed(omieId, { ...(await fake.get(omieId))!, cep: "99999999" });

      await ingestOmieSnapshot(store, fake, customerId);

      expect((await store.getSync({ customerId }, "postalCode"))?.changedBy).toBe("OMIE_SYNC");
    }));

  it("overwrites OMIE_SYNC when a later attendant edits the field", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, omieId } = await seedLinked(tx);
      fake.seed(omieId, { ...(await fake.get(omieId))!, cep: "99999999" });
      await ingestOmieSnapshot(store, fake, customerId);
      expect((await store.getSync({ customerId }, "postalCode"))?.changedBy).toBe("OMIE_SYNC");

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { postalCode: "22041080" },
        actorId: "u2",
      });

      expect((await store.getSync({ customerId }, "postalCode"))?.changedBy).toBe("u2");
    }));
});
