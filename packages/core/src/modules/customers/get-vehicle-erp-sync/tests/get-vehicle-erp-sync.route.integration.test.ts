/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicle-sync.route.test.ts` (adopt-modular-
 * vertical-slices 4B); runs under module_customers. This file keeps that
 * suite's six `GET /vehicles/:id/omie-sync` cases, assertions unchanged. Its two
 * `PATCH /vehicles/:id` dual-change-guard cases went to the slice of the route
 * they call:
 * update-vehicle/tests/update-vehicle.vehicles-dual-change.integration.test.ts.
 *
 * SUT: `GET /vehicles/:id/omie-sync` (the `get-vehicle-erp-sync` slice) and the
 *   cadastro store. The ranking between the four states is NOT retested here: it
 *   lives in the pure `buildVehicleOmieSync`, which the store calls, and
 *   `packages/shared-types/src/vehicle-omie-sync.test.ts` covers its branches.
 *   What this file owns is the wiring the pure function cannot see — unit
 *   scoping, 404s, and that the store reads a NON-titular vehicle's own rows
 *   rather than the customer's.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   via `seedUser`, with a generated id. This route never reaches Omie, so it
 *   is given no adapter.
 *
 * Oracle: `customer-vehicles` delta of `align-shipped-ui-to-revised-canvas` —
 *   never-synchronised distinguishable, a failure carrying its reason and time,
 *   a conflict carrying both values per field, and the mapping never presented
 *   as confirmed while GitHub #29 is open. Unit scoping follows the existing
 *   rule that a vehicle has no unit of its own and inherits the titular
 *   customer's.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (required by route-tests-on-real-database)
 *   1. **An orphan vehicle.** The old file's last case seeded
 *      `{ id: "veh-orfao", customerId: "cus-sumiu" }` — a vehicle whose owning
 *      customer does not exist — and asserted the route answers 404 through the
 *      `!owner` arm. `vehicle.customer_id` is a non-null FK to `customer` with
 *      `onDelete: Restrict`, so Postgres cannot hold that row at all: the insert
 *      fails with a foreign-key violation before any request is made. The state
 *      the assertion described is unreachable on the real adapter, so the case
 *      is removed rather than rewritten, and the `!owner` arm is recorded below
 *      as contract-hidden. On the fake, which kept customers and vehicles in two
 *      unrelated Maps, it was an ordinary reachable case.
 *   2. **String ids the test chose.** The old file asserted on literals
 *      (`"veh-1"`, `"cus-1"`) and, in the other-unit case, on the literal unit
 *      id `"unit-outra"`. `customer.unit_id` is an FK to `unit`, so an unseeded
 *      unit id is not insertable; every id here is now a real row's.
 *   (Note 3, on the dual-change guard, moved with the guard's cases.)
 *
 * Axes
 *   A1 vehicle       — exists / unknown id
 *   A2 owning unit   — caller's / another unit's
 *   A3 sync data     — none / failed field / open pending
 *   A4 which vehicle — the titular / a second car of the same customer
 *
 * Outputs
 *   O1 200 never_synced; O2 200 failed with reason; O3 200 conflict with both
 *   values; O4 404; O5 mappingConfirmed false on every 200
 *
 * Sampled cells (one row per `it`)
 *   unsynced titular            | A1 exists, A3 none    | O1 O5
 *                                 | fails if the body claims a confirmed mapping
 *   failed field                | A3 failed             | O2
 *                                 | fails if the reason is dropped in transport
 *   open pending                | A3 pending            | O3
 *                                 | fails if only one side of the field is sent
 *   second (non-titular) car    | A4 second, A3 pending | O3
 *                                 | fails if the read narrows to the titular,
 *                                   which is what `listOpenPendings` does
 *   another unit's vehicle      | A2 other              | O4
 *                                 | fails if the body confirms the row exists
 *   unknown id                  | A1 unknown            | O4
 *
 * Decision / branch map (get-vehicle-erp-sync/index.ts)
 *   `!unitId`
 *     T — contract-hidden: in production the auth hook answers before the
 *         handler runs
 *     F — every `it`
 *   `!vehicle`               T — unknown-id `it`; F — the rest
 *   `!owner || owner.unitId !== unitId`
 *     first operand  T — contract-hidden on Postgres: see fake-only note 1,
 *                        the FK makes an ownerless vehicle uninsertable
 *     second operand T — other-unit `it`;  F — the four 200 its
 *   `!sync`
 *     T — infeasible from this handler: `getVehicleOmieSync` returns null only
 *         for a vehicle that does not exist, and `getVehicle` has already
 *         proved this one does. Kept as a guard because the port allows it
 *     F — the four 200 its
 *
 * Out of scope, with reason
 *   - The pure ranking function: covered in shared-types, and both callers use it.
 *   - The rail panel that consumes this (task 7.3) — not built, and `apps/web`
 *     is another session's lane.
 *   - Omie HTTP behaviour: this route does not reach Omie.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { vehicleOmieSyncSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/**
 * Creates a customer in `unitId` with one vehicle, both real rows.
 *
 * @param tx - The test transaction.
 * @param unitId - Owning unit; a real `unit` row, because `customer.unit_id` is an FK.
 * @param input - Optional `omieId` to link the customer, and the vehicle's plate.
 * @returns The customer and vehicle ids.
 */
async function seedCustomerWithVehicle(
  tx: DbClient,
  unitId: string,
  input: { omieId?: string; plate?: string } = {},
): Promise<{ customerId: string; vehicleId: string }> {
  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      unitId,
      omieId: input.omieId ?? null,
      origin: "manual",
      status: "active",
    },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: input.plate ?? "ABC1D23", origin: "manual" },
    select: { id: true },
  });
  return { customerId: customer.id, vehicleId: vehicle.id };
}

describeWithDatabase("GET /vehicles/:id/omie-sync", () => {
  const db = () => prisma as PrismaClient;

  /**
   * Mounts the slice on the test transaction, called by an attendant of `unitId`.
   *
   * @param tx - The test transaction.
   * @param unitId - The unit the test attendant is a member of and calls in.
   * @returns The Fastify instance, ready for `inject`.
   */
  async function appOn(tx: DbClient, unitId: string) {
    const user = await seedUser(tx, { units: [unitId] });
    return buildSliceApp({
      db: createDb(tx, runInTransactionOnTx(tx)),
      plugin: (a) => registerSlice(a, "customers", "get-vehicle-erp-sync", route),
      caller: { userId: user.id, unitId },
    });
  }

  it("reports a vehicle that has never synchronised, without claiming a confirmed mapping", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const { vehicleId } = await seedCustomerWithVehicle(tx, unit.id);
      const app = await appOn(tx, unit.id);

      const response = await app.inject({
        method: "GET",
        url: `/vehicles/${vehicleId}/omie-sync`,
      });

      expect(response.statusCode).toBe(200);
      expect(vehicleOmieSyncSchema.parse(response.json())).toEqual({
        vehicleId,
        mappingConfirmed: false,
        state: "never_synced",
        omieId: null,
      });
      await app.close();
    }));

  it("carries the reason and the attempt time of a failed field push", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const { vehicleId } = await seedCustomerWithVehicle(tx, unit.id);
      await tx.vehicleFieldSync.create({
        data: {
          vehicleId,
          fieldKey: "plate",
          origin: "CRM",
          lastAttemptedAt: new Date("2026-08-29T10:00:00.000Z"),
          lastResult: "failed",
          lastError: "wire_mapping_failed",
        },
      });
      const app = await appOn(tx, unit.id);

      const response = await app.inject({
        method: "GET",
        url: `/vehicles/${vehicleId}/omie-sync`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        state: "failed",
        fieldKey: "plate",
        reason: "wire_mapping_failed",
        lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        mappingConfirmed: false,
      });
      await app.close();
    }));

  it("returns both values for each field in conflict", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const { vehicleId } = await seedCustomerWithVehicle(tx, unit.id);
      await tx.vehicleReconciliationPending.create({
        data: {
          vehicleId,
          fieldKey: "plate",
          crmValue: "ABC1D23",
          omieValue: "ABC-1234",
          localVersion: 2,
          externalVersion: 1,
          status: "open",
        },
      });
      const app = await appOn(tx, unit.id);

      const response = await app.inject({
        method: "GET",
        url: `/vehicles/${vehicleId}/omie-sync`,
      });

      expect(response.statusCode).toBe(200);
      const state = vehicleOmieSyncSchema.parse(response.json());
      expect(state.state === "conflict" && state.fields).toEqual([
        { fieldKey: "plate", crmValue: "ABC1D23", omieValue: "ABC-1234" },
      ]);
      await app.close();
    }));

  it("reads a second car's own conflict rather than narrowing to the titular", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const { customerId, vehicleId: titularId } = await seedCustomerWithVehicle(tx, unit.id);
      const second = await tx.vehicle.create({
        data: {
          customerId,
          plate: "XYZ9K88",
          origin: "manual",
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
        },
        select: { id: true },
      });
      await tx.vehicleReconciliationPending.create({
        data: {
          vehicleId: second.id,
          fieldKey: "model",
          crmValue: "Onix",
          omieValue: "ONIX LT",
          localVersion: 2,
          externalVersion: 1,
          status: "open",
        },
      });
      const app = await appOn(tx, unit.id);

      const response = await app.inject({
        method: "GET",
        url: `/vehicles/${second.id}/omie-sync`,
      });

      expect(response.statusCode).toBe(200);
      const state = vehicleOmieSyncSchema.parse(response.json());
      // Precondition: the titular is a different row, so a read that narrowed
      // to the customer's first car could not answer with this pending.
      expect(second.id).not.toBe(titularId);
      expect(state.vehicleId).toBe(second.id);
      expect(state.state === "conflict" && state.fields).toEqual([
        { fieldKey: "model", crmValue: "Onix", omieValue: "ONIX LT" },
      ]);
      await app.close();
    }));

  it("answers 404 for a vehicle whose owner belongs to another unit", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const other = await seedUnit(tx);
      const { vehicleId } = await seedCustomerWithVehicle(tx, other.id, { plate: "OUT9R00" });
      const app = await appOn(tx, unit.id);

      const response = await app.inject({
        method: "GET",
        url: `/vehicles/${vehicleId}/omie-sync`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(vehicleId);
      await app.close();
    }));

  it("answers 404 for an id no vehicle carries", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      await seedCustomerWithVehicle(tx, unit.id);
      const app = await appOn(tx, unit.id);

      const response = await app.inject({
        method: "GET",
        url: "/vehicles/nao-existe/omie-sync",
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    }));
});
