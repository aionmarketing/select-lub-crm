/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's two
 * `GET /customers/:id/vehicles` cases, assertions unchanged. The full design of
 * the old suite — its fake-only notes, the other cases and where each went —
 * is in update-vehicle/tests/update-vehicle.vehicles.integration.test.ts.
 *
 * SUT: `GET /customers/:id/vehicles` (the `list-customer-vehicles` slice) and
 *   the cadastro store behind it.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; the slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. The attendant is a real `user` + `user_unit` row
 *   with a generated id. The setup still builds a `createFakeOmie`, as the
 *   old suite's seed did, but this route never reaches Omie and takes no adapter.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md and
 * specs/customer-vehicles HTTP.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE — note 4 of the old suite applies:
 *   the customer, its vehicles and the unit are FK-backed rows, not Map keys.
 *
 * Outputs: O1 200/404; O3 titular first
 *
 * Sampled-cell
 *   GET two vehicles titular first     | list     | wrong order
 *   GET unknown customer               | 404      | 2xx
 *
 * Decision map (list-customer-vehicles/index.ts)
 *   D1 customer/unit missing      T the 404 it; F the list it
 *   `if (!unitId)` — contract-hidden: in production the auth hook answers first
 *
 * Out of scope: plateSourcedKeys on the list (create-customer-vehicle.origin).
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { vehicleListSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/** The Omie characteristic the plate travels in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";

/**
 * Seeds a unit, its WhatsApp connection, the attendant, a customer and its
 * vehicles, builds the Omie fake, and mounts the slice on the
 * test transaction.
 *
 * @param tx - The test transaction.
 * @param options - `omieId` (default `"omie-veh-1"`; pass `null` for an
 *   unlinked customer) and `extra` to add a second, non-titular vehicle.
 * @returns The app, the ids, and the Omie fake.
 */
async function seedLinked(
  tx: DbClient,
  options: { omieId?: string | null; extra?: boolean } = {},
) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  await seedConnection(tx, { unitId: unit.id });
  const fake = createFakeOmie();
  const omieId = options.omieId === undefined ? "omie-veh-1" : options.omieId;

  const customer = await tx.customer.create({
    data: { name: "Ana", omieId, unitId: unit.id, origin: "manual", status: "active" },
    select: { id: true },
  });
  const vehOld = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      plate: "TITULAR1",
      origin: "omie",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  const vehNew = options.extra
    ? await tx.vehicle.create({
        data: {
          customerId: customer.id,
          plate: "EXTRA001",
          origin: "omie",
          createdAt: new Date("2026-08-02T00:00:00.000Z"),
        },
        select: { id: true },
      })
    : null;

  if (omieId) {
    fake.seed(omieId, {
      ...emptySnapshot(),
      razao_social: "Ana",
      caracteristicas: [{ campo: PLATE_CAMPO, conteudo: "TITULAR1" }],
    });
    await tx.vehicleFieldSync.create({
      data: {
        vehicleId: vehOld.id,
        fieldKey: "plate",
        origin: "CRM",
        localVersion: 1,
        externalVersion: 1,
        syncedLocalVersion: 1,
        syncedExternalVersion: 1,
        lastOmieWire: "TITULAR1",
      },
    });
  }

  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (a) => registerSlice(a, "customers", "list-customer-vehicles", route),
    caller: { userId: user.id, unitId: unit.id },
  });
  return { app, customerId: customer.id, vehOld: vehOld.id, vehNew: vehNew?.id ?? null, fake };
}

describeWithDatabase("customer-scoped vehicle HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("lists two vehicles with the titular first", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx, { extra: true });

      const response = await ctx.app.inject({
        method: "GET",
        url: `/customers/${ctx.customerId}/vehicles`,
      });

      expect(response.statusCode).toBe(200);
      const body = vehicleListSchema.parse(response.json());
      expect(body.map((row) => row.id)).toEqual([ctx.vehOld, ctx.vehNew]);
      await ctx.app.close();
    }));

  it("returns 404 for an unknown customer vehicle list", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);

      const response = await ctx.app.inject({
        method: "GET",
        url: "/customers/missing/vehicles",
      });

      expect(response.statusCode).toBe(404);
      await ctx.app.close();
    }));
});
