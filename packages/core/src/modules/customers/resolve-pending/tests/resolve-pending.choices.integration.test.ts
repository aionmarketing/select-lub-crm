/**
 * Test design (testing-strategy)
 *
 * Exercises the cadastro engine (`customers/contracts/cadastro-engine`) (`resolvePending`, and
 * `ingestOmieSnapshot` to build the fixture) against the real cadastro store,
 * `createPrismaCadastroStore` in `apps/api/src/cadastro/prisma.ts`. Relocated
 * from `packages/omie/src/resolve-pending.test.ts`: `packages/db` depends on
 * `packages/omie`, so the Prisma adapter cannot live in the Omie package (D6).
 *
 * Moved from `apps/api/src/cadastro/omie/resolve-pending.test.ts`
 * (adopt-modular-vertical-slices 4B): the store is now `createCadastroStore(db)`
 * and runs every call under `module_customers`. Split in three under the 300-line
 * cap: this file holds the three choices (omie / crm / edit);
 * `resolve-pending.failures` the put failures and the Omie-less closes;
 * `resolve-pending.guards` the refusals, including "the final it" named below.
 *
 * Setup: the real cadastro store on a rolled-back transaction + createFakeOmie.
 * Only the store is real; the Omie side stays faked.
 *
 * Fake-only assertion surfaced: the final it, added 2026-09-07 precisely to
 * reach `vehicle.customerId !== customer.id` with "a vehicle that genuinely
 * exists and genuinely belongs to someone else", did no such thing — it seeded
 * `{ id: "veh-other", customerId: "cus-other" }` against a customer that was
 * never created, because the fake's `seedVehicle` accepted any string. The
 * guard was therefore satisfied by a dangling reference rather than by a real
 * rival owner. Postgres restricts `vehicle.customer_id`, so that vehicle now
 * hangs off a second real customer in the same unit, which is the case the
 * comment claimed. `store.pendingRows()` was likewise a fake-only inspector;
 * the retention it now reads `customerReconciliationPending` directly and
 * scopes to this customer's rows, never an absolute count.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync —
 *   Attendant resolves an open pending per field (choice crm|omie|edit;
 *   vehicleId null = person/address; close retains the row);
 *   Failed put on resolve keeps the pending open.
 *
 * Axes
 *   A1 choice — omie / crm / edit
 *   A2 pending presence — open vs missing vs vehicleId pairing miss
 *   A3 adapter put — succeeds / throws / failedKeys
 *   A4 omieId — set vs null (crm/edit send only when set)
 *   A5 customer — found+unit match / missing / unit mismatch
 *   BVA: none (choice and ids are catalogs, not ordered ranges)
 *
 * Outputs: O1 closed + applied; O2 put then closed; O3 typed value;
 *   O4 throw pending_not_found; O5 pending still open + omie_unavailable;
 *   O6 not_found; O7 unit_mismatch; O8 closed without put
 *
 * Sampled-cell
 *   omie choice applies OMIE_SYNC and closes     | A1 omie     | O1 | still open
 *   crm choice puts Omie and closes              | A1 crm      | O2 | putCount 0
 *   edit writes typed value                      | A1 edit     | O3 | name unchanged
 *   missing pending throws not-found             | A2 miss     | O4 | field changes
 *   vehicleId on a person field throws           | A2 pair     | O4 | closes
 *   null vehicleId on a plate pending throws     | A2 pair     | O4 | closes
 *   failed put throw leaves pending open         | A3 throw    | O5 | status resolved
 *   failedKeys on overlong plate leaves open     | A3 keys     | O5 | status resolved
 *   close retains the row with resolved_by       | A1 omie     | O1 | row deleted
 *   crm on unlinked customer closes without put  | A4 null     | O8 | putCount > 0
 *   missing customer is not_found                | A5 miss     | O6 | throw
 *   unit mismatch is unit_mismatch               | A5 unit     | O7 | throw
 *   edit without value throws                    | A1 edit     | O4 | writes name
 *
 * Decision / branch map (resolvePending)
 *   !customer                         T missing-customer it; F seeded its
 *   unitId !==                        T unit-mismatch it; F seeded its
 *   vehicleField XOR vehicleId        T pairing its; F person+null / plate+id
 *   vehicle missing / wrong owner     covered by pairing + missing pending
 *   !owner                            infeasible once vehicle exists for plate
 *   !pending                          T missing-pending it; F seeded its
 *   choice === "omie"                 T omie + retain its; F crm/edit its
 *   choice === "edit"                 T edit it; F crm its
 *   edit && value === undefined       T edit-without-value it; F edit with value
 *   customer.omieId                   T linked crm/edit; F unlinked crm it
 *   put.failedKeys includes key       T overlong-plate it; F crm success it
 *   adapter.put throw                 T throw it; F crm success it
 *   savedAfterFail !saved             infeasible (row just persisted)
 *
 * Out of scope: HTTP 404/503 (resolve-pending.route.integration.test.ts);
 *   odometerKm parseStoredValue empty/NaN (same "" → null as other strings).
 *
 * Added 2026-09-07, per repo-foundation "Reachable production decisions have
 *   both test outcomes": "vehicle missing / wrong owner" above named itself
 *   covered by the pairing and missing-pending its, but neither of those
 *   reaches `vehicle.customerId !== customer.id` — the person+vehicleId it
 *   fails the earlier field/id XOR guard first, and the plate+null it fails
 *   that same guard from the other side, so a REAL vehicle belonging to a
 *   different customer was never actually exercised. New it added for it.
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

  it("applies the Omie value with OMIE_SYNC and closes the pending", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedPending(tx);
      expect((await store.getOpenPending({ customerId }, "postalCode"))?.status).toBe("open");

      const result = await resolvePending(store, fake, {
        customerId,
        unitId,
        fieldKey: "postalCode",
        vehicleId: null,
        choice: "omie",
        actorId,
      });

      expect(result.status).toBe("ok");
      expect((await store.getCustomer(customerId))?.postalCode).toBe("OMIECEP1");
      expect((await store.getSync({ customerId }, "postalCode"))?.origin).toBe("OMIE_SYNC");
      expect((await store.getSync({ customerId }, "postalCode"))?.changedBy).toBe(actorId);
      expect(await store.getOpenPending({ customerId }, "postalCode")).toBeNull();
      expect(fake.putCount()).toBe(0);
    }));

  it("sends the CRM value to Omie and closes on choice crm", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, omieId } = await seedPending(tx);

      const result = await resolvePending(store, fake, {
        customerId,
        unitId,
        fieldKey: "postalCode",
        vehicleId: null,
        choice: "crm",
        actorId,
      });

      expect(result.status).toBe("ok");
      expect((await fake.get(omieId))?.cep).toBe("CRMCEP12");
      expect(await store.getOpenPending({ customerId }, "postalCode")).toBeNull();
      expect(fake.putCount()).toBe(1);
    }));

  it("persists the typed edit value and closes the pending", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId } = await seedPending(tx, "name");

      const result = await resolvePending(store, fake, {
        customerId,
        unitId,
        fieldKey: "name",
        vehicleId: null,
        choice: "edit",
        value: "Casa Nova",
        actorId,
      });

      expect(result.status).toBe("ok");
      expect((await store.getCustomer(customerId))?.name).toBe("Casa Nova");
      expect(await store.getOpenPending({ customerId }, "name")).toBeNull();
    }));
});
