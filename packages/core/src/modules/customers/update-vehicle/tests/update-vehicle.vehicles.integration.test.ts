/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/cadastro.vehicles.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `PATCH /vehicles/:id` cases (decision table P1–P5 and the unknown-id 404),
 * assertions unchanged. The rest of the old file went to the slice of the route
 * each case calls:
 *   - GET  /customers/:id/vehicles       → list-customer-vehicles/tests/list-customer-vehicles.vehicles.integration.test.ts
 *   - POST /customers/:id/vehicles       → create-customer-vehicle/tests/create-customer-vehicle.vehicles.integration.test.ts
 *   - PATCH /customers/:id               → update-customer/tests/update-customer.vehicles.integration.test.ts
 *   - GET  /customers/:id/reconciliation-pendings
 *                                        → list-customer-pendings/tests/list-customer-pendings.vehicles.integration.test.ts
 *   - GET  /conversations/:id/vehicles   → list-conversation-vehicles/tests/list-conversation-vehicles.vehicles.integration.test.ts
 *   - POST /conversations/:id/vehicles   → create-conversation-vehicle/tests/create-conversation-vehicle.vehicles.integration.test.ts
 *   - the auth hook's 403 and the GET /conversations list shape stayed with
 *     `apps/api` (the hook and the list route are not customers slices).
 *
 * SUT: `PATCH /vehicles/:id` (the `update-vehicle` slice), the
 *   `applyVehicleFieldEdit` decision table P1–P5, and the cadastro store
 *   behind it.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`. The slice alone on the
 *   harness app over the test transaction, the caller stated rather than
 *   resolved by the auth hook. Omie stays a `createFakeOmie`, bound as the ERP
 *   port, because it is an external service, not a store. The attendant is a
 *   real `user` + `user_unit` row via `seedUser`, with a generated id.
 *
 * Oracle: openspec/changes/crm-n-vehicles/design.md Axis 3 and
 * specs/customer-vehicles HTTP.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (required by route-tests-on-real-database)
 *   3. **`putCount()` was asserted as a range.** P1 said
 *      `toBeGreaterThan(0)` — which passes on two pushes as happily as one, and
 *      would not catch a repeated write. It is pinned to exactly 1.
 *   4. **Ids were Map keys.** `cus-veh`, `veh-old`, `veh-new` and the unit are
 *      FK-backed rows now; `customer.omie_id` is additionally UNIQUE, so the
 *      linked customer's Omie id is a real constraint rather than a string.
 *   (Notes 1 and 2 concern the conversation-scoped cases; they moved with them.)
 *
 * Axis 3 PATCH /vehicles/:id (decision table P1–P5)
 *
 * Outputs: O1 200/404; O2 adapter putCount, pinned exactly;
 *   O3 titular vs extra plates
 *
 * Sampled-cell
 *   P4 extra plate linked              | Axis 3   | putCount > 0 or titular plate flips
 *   P2 unlinked titular plate          | Axis 3   | 409 or putCount > 0
 *   P1 linked titular plate            | Axis 3   | putCount exactly 1
 *   P3 titular year only               | Axis 3   | putCount moves
 *   P5 unlinked extra plate            | Axis 3   | 409 or putCount > 0
 *   unknown vehicle 404                |          | 2xx
 *
 * Decision map (update-vehicle/index.ts + applyVehicleFieldEdit)
 *   D4 titular × linked × shared  P1–P5, one `it` each
 *   `if (!unitId)` — contract-hidden: in production the auth hook answers
 *     403/401 before the handler runs
 *
 * Out of scope: rail UI; the dual-change guard (update-vehicle.vehicles-dual-change);
 *   the engine replay (update-vehicle.n-vehicles).
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
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";
import { vehicleSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/** The Omie characteristic the plate travels in; mirrors CARACTERISTICA_CAMPOS.plate. */
const PLATE_CAMPO = "Placa";

/**
 * Seeds a unit, its WhatsApp connection, the attendant, a customer and its
 * vehicles, passes the Omie fake to the route, and mounts the slice on the
 * test transaction.
 *
 * @param tx - The test transaction.
 * @param options - `omieId` (default `"omie-veh-1"`; pass `null` for an
 *   unlinked customer) and `extra` to add a second, non-titular vehicle.
 * @returns The app, ids, the Omie fake, and the cadastro store.
 */
async function seedLinked(
  tx: DbClient,
  options: { omieId?: string | null; extra?: boolean } = {},
) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
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
    // In step with Omie: local and external both at 1 and both reconciled, so
    // the next CRM edit is a clean "CRM ahead" push rather than a conflict.
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

  const db = createDb(tx, runInTransactionOnTx(tx));
  const app = await buildSliceApp({
    db,
    plugin: (a) => registerSlice(a, "customers", "update-vehicle", route({ omieAdapter: fake })),
    caller: { userId: user.id, unitId: unit.id },
  });
  return {
    app,
    unit,
    connection,
    customerId: customer.id,
    vehOld: vehOld.id,
    vehNew: vehNew?.id ?? null,
    fake,
    cadastro: createCadastroStore(db),
  };
}

describeWithDatabase("customer-scoped vehicle HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("P4: extra plate persist on a linked customer does not write Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx, { extra: true });

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/vehicles/${ctx.vehNew}`,
        payload: { plate: "NEWPLATE" },
      });

      expect(response.statusCode).toBe(200);
      expect(vehicleSchema.parse(response.json()).plate).toBe("NEWPLATE");
      expect((await ctx.cadastro.getVehicle(ctx.vehOld))?.plate).toBe("TITULAR1");
      expect(ctx.fake.putCount()).toBe(0);
      await ctx.app.close();
    }));

  it("P2: unlinked titular shared patch persists without calling Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx, { omieId: null });

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/vehicles/${ctx.vehOld}`,
        payload: { plate: "NOPE0001" },
      });

      expect(response.statusCode).toBe(200);
      expect((await ctx.cadastro.getVehicle(ctx.vehOld))?.plate).toBe("NOPE0001");
      expect(ctx.fake.putCount()).toBe(0);
      await ctx.app.close();
    }));

  it("P1: linked titular plate patch pushes to Omie exactly once", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/vehicles/${ctx.vehOld}`,
        payload: { plate: "CRMNEW01" },
      });

      expect(response.statusCode).toBe(200);
      expect(vehicleSchema.parse(response.json()).plate).toBe("CRMNEW01");
      // Exactly one, not "more than none": a range passes on a duplicated push,
      // which is the defect an Omie write count exists to catch.
      expect(ctx.fake.putCount()).toBe(1);
      await ctx.app.close();
    }));

  it("P3: titular year-only patch does not write Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/vehicles/${ctx.vehOld}`,
        payload: { year: 2018 },
      });

      expect(response.statusCode).toBe(200);
      expect(vehicleSchema.parse(response.json()).year).toBe(2018);
      expect((await ctx.cadastro.getVehicle(ctx.vehOld))?.plate).toBe("TITULAR1");
      // `year` is CRM-only, so no shared field moved and Omie is never reached.
      expect(ctx.fake.putCount()).toBe(0);
      await ctx.app.close();
    }));

  it("P5: unlinked extra plate persists without Omie", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx, { omieId: null, extra: true });

      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/vehicles/${ctx.vehNew}`,
        payload: { plate: "FREEPLAT" },
      });

      expect(response.statusCode).toBe(200);
      expect(vehicleSchema.parse(response.json()).plate).toBe("FREEPLAT");
      expect(ctx.fake.putCount()).toBe(0);
      await ctx.app.close();
    }));

  it("returns 404 for an unknown vehicle id", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await seedLinked(tx);

      const response = await ctx.app.inject({
        method: "PATCH",
        url: "/vehicles/missing",
        payload: { plate: "ABC1D23" },
      });

      expect(response.statusCode).toBe(404);
      await ctx.app.close();
    }));
});
