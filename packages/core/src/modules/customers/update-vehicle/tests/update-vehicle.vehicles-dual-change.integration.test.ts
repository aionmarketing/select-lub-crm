/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicle-sync.route.test.ts` (adopt-modular-
 * vertical-slices 4B); runs under module_customers. This file keeps that
 * suite's two `PATCH /vehicles/:id` dual-change-guard cases, assertions
 * unchanged. The suite's six `GET /vehicles/:id/omie-sync` cases, and its full
 * design, are in get-vehicle-erp-sync/tests/get-vehicle-erp-sync.route.integration.test.ts.
 *
 * SUT: the dual-change guard on `PATCH /vehicles/:id` (the `update-vehicle`
 *   slice): the engine's `applyVehicleFieldEdit`/`decideField` and the cadastro
 *   store's `markSynced`.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. Omie stays an injected port — bound as the process's
 *   ERP adapter — because it is an external service, not a store.
 *
 * Oracle: `markSynced`'s contract: it applies the patch only when the stored
 *   versions still equal the ones the caller read.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE
 *   3. The dual-change guard itself did NOT surface a divergence: the fake's
 *      `markSynced` (packages/omie/src/memory.ts:255) compares the expected
 *      `localVersion`/`externalVersion` before applying, which is what the
 *      adapter's conditional `WHERE` does. The change's proposal states the
 *      fake "has no versionWhere"; on this tree it has an equivalent one. The
 *      guard is asserted here anyway, on the real adapter, because it is the
 *      behaviour the route depends on and nothing else covered it end to end.
 *
 * Axes
 *   A5 version race  — a local bump lands during the Omie put
 *   A6 both ahead    — CRM and Omie both moved since the last sync
 *
 * Outputs
 *   O3 conflict with both values; O6 the sync row is left unsynced (guard
 *   refused); O7 an open pending row
 *
 * Sampled cells (one row per `it`)
 *   raced local bump            | A5 race               | O6
 *                                 | fails if the adapter marks synced anyway,
 *                                   which would report the SECOND edit as
 *                                   pushed to Omie when only the first was
 *   both sides ahead            | A6 both               | O7 O3
 *                                 | fails if the route overwrites one side
 *                                   instead of opening a pending
 *
 * Decision map (engine `decideField`, reached through PATCH)
 *   `crmAhead && !omieAhead` → `markSynced` returns false  — raced-bump `it`
 *   `crmAhead && omieAhead`  → `saveOpenPending`           — both-ahead `it`
 *   other arms — covered by cadastro.live.test.ts and the engine suite
 *
 * Out of scope: Omie HTTP behaviour — the port is faked deliberately; no test
 *   here reaches the network.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot, type OmieAdapter, type OmieClientSnapshot } from "../../../../kernel/clients/erp-mock.js";
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
import { route } from "../index.js";

/** The Omie characteristic name the plate is carried in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";

/** A snapshot whose plate characteristic carries `plate`. */
function snapshotWithPlate(plate: string): OmieClientSnapshot {
  return { ...emptySnapshot(), caracteristicas: [{ campo: PLATE_CAMPO, conteudo: plate }] };
}

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

/**
 * Mounts the slice on the test transaction, called by `userId` in `unitId`.
 *
 * @param tx - The test transaction.
 * @param caller - The attendant and the unit they call in.
 * @param omieAdapter - The Omie adapter the route pushes through.
 * @returns The Fastify instance, ready for `inject`.
 */
function appOn(tx: DbClient, caller: { userId: string; unitId: string }, omieAdapter: OmieAdapter) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (a) => registerSlice(a, "customers", "update-vehicle", route({ omieAdapter })),
    caller,
  });
}

describeWithDatabase("PATCH /vehicles/:id — dual-change guard", () => {
  const db = () => prisma as PrismaClient;

  it("leaves the field unsynced when a local bump lands while Omie is being written", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const omieId = "9001";
      const { vehicleId } = await seedCustomerWithVehicle(tx, unit.id, {
        omieId,
        plate: "AAA0A00",
      });
      const user = await seedUser(tx, { units: [unit.id] });

      const omie = createFakeOmie();
      omie.seed(omieId, snapshotWithPlate("AAA0A00"));
      // A second CRM edit landing during the Omie round-trip: the sync row's
      // localVersion moves after `decideField` read it and before `markSynced`
      // applies its conditional WHERE. This is the race the guard exists for,
      // realised deterministically rather than by timing.
      const racing: OmieAdapter = {
        get: (id) => omie.get(id),
        put: async (id, fields, codigo) => {
          await tx.vehicleFieldSync.update({
            where: { vehicleId_fieldKey: { vehicleId, fieldKey: "plate" } },
            data: { localVersion: { increment: 1 } },
          });
          return omie.put(id, fields, codigo);
        },
      };
      const app = await appOn(tx, { userId: user.id, unitId: unit.id }, racing);

      const response = await app.inject({
        method: "PATCH",
        url: `/vehicles/${vehicleId}`,
        payload: { plate: "BBB1B11" },
      });

      expect(response.statusCode).toBe(200);
      const sync = await tx.vehicleFieldSync.findUniqueOrThrow({
        where: { vehicleId_fieldKey: { vehicleId, fieldKey: "plate" } },
      });
      // Precondition: the race actually moved the version the guard reads, so
      // the assertion below is not vacuously true (a guard that never ran and a
      // guard that refused both leave syncedLocalVersion at 0).
      expect(sync.localVersion).toBe(2);
      // The guard refused: the conditional WHERE looked for localVersion 1 and
      // matched zero rows, so the field is still CRM-ahead. Marking it synced
      // here would report the SECOND edit as pushed when only the first was.
      expect(sync.syncedLocalVersion).toBe(0);
      expect(sync.localVersion).toBeGreaterThan(sync.syncedLocalVersion);
      await app.close();
    }));

  it("opens a pending carrying both values when CRM and Omie have both moved", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const omieId = "9002";
      const { vehicleId } = await seedCustomerWithVehicle(tx, unit.id, {
        omieId,
        plate: "AAA0A00",
      });
      // Omie already moved this field: externalVersion is ahead of what the CRM
      // last reconciled, exactly as `bumpExternal` leaves it after an ingest.
      await tx.vehicleFieldSync.create({
        data: {
          vehicleId,
          fieldKey: "plate",
          origin: "OMIE_SYNC",
          externalVersion: 1,
          syncedExternalVersion: 0,
          lastOmieWire: "OMI2E22",
          changedBy: "OMIE_SYNC",
        },
      });
      const user = await seedUser(tx, { units: [unit.id] });

      const omie = createFakeOmie();
      omie.seed(omieId, snapshotWithPlate("OMI2E22"));
      const app = await appOn(tx, { userId: user.id, unitId: unit.id }, omie);

      const response = await app.inject({
        method: "PATCH",
        url: `/vehicles/${vehicleId}`,
        payload: { plate: "CRM3C33" },
      });

      expect(response.statusCode).toBe(200);
      const pendings = await tx.vehicleReconciliationPending.findMany({
        where: { vehicleId, fieldKey: "plate", status: "open" },
      });
      expect(pendings).toHaveLength(1);
      // Both sides are carried, so neither edit was silently discarded.
      expect(pendings[0]).toMatchObject({ crmValue: "CRM3C33", omieValue: "OMI2E22" });
      // And Omie was never written to: the route reconciles before it pushes.
      expect(omie.putCount()).toBe(0);
      await app.close();
    }));
});
