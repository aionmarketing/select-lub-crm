/**
 * Test design (testing-strategy)
 *
 * SUT: `GET /services`, the `list-unit-services` slice, through HTTP. The
 *   ledger's filters, search and paging are driven directly in the sibling
 *   `unit-listing-*.integration.test.ts` files.
 *
 * Why these moved here (adopt-modular-vertical-slices 3C): they lived in
 * `quote.route.test.ts` beside the oil-quote routes, stayed in
 * `apps/api/src/services-listing.route.test.ts` when 2B moved the quote routes
 * (W2-C5), and move now that `services` is a module. Assertions unchanged. The
 * setup builds this slice alone on the harness app, over the test transaction,
 * as a caller who belongs to both units, instead of `apps/api`'s app behind the
 * auth hook; its seeded rows are the same.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; every row is created in the
 * test's transaction and rolls back.
 *
 * Oracle: the unit Serviços list.
 *
 * Axes
 *   A1 unit — the caller's unit vs another unit the caller also belongs to
 *
 * Sampled-cell
 *   unit list scoped        | A1 | unit 1 only         | both units
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { unitServicePageSchema } from "../../contracts/http.js";
import { route } from "../index.js";

/**
 * Builds the app on the test transaction with two units the caller belongs to, a
 * customer and two vehicles in the first, and one customer and vehicle in the second.
 *
 * @param tx - The test transaction.
 * @returns The app, acting as a caller in the first unit, and the seeded ids.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const other = await seedUnit(tx);

  const customer = await tx.customer.create({
    data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" },
    select: { id: true },
  });
  const otherCustomer = await tx.customer.create({
    data: { name: "Outra", unitId: other.id, origin: "manual", status: "active" },
    select: { id: true },
  });
  const vehicle = async (customerId: string, plate: string | null) =>
    tx.vehicle.create({ data: { customerId, origin: "manual", plate }, select: { id: true } });

  const vehA = await vehicle(customer.id, "ABC1D23");
  const vehB = await vehicle(customer.id, "XYZ9F88");
  const vehOther = await vehicle(otherCustomer.id, null);

  const user = await seedUser(tx, { units: [unit.id, other.id] });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "services", "list-unit-services", route),
    caller: { userId: user.id, unitId: unit.id, unitIds: [unit.id, other.id] },
  });

  return {
    app,
    unit,
    other,
    customerId: customer.id,
    otherCustomerId: otherCustomer.id,
    vehA: vehA.id,
    vehB: vehB.id,
    vehOther: vehOther.id,
  };
}

describeWithDatabase("vehicle and unit service listings", () => {
  const db = () => prisma as PrismaClient;

  it("lists only the current unit's services on GET /services", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      await tx.service.create({
        data: {
          customerId: ctx.customerId,
          unitId: ctx.unit.id,
          vehicleId: ctx.vehA,
          description: "Da unidade",
          origin: "manual",
        },
      });
      await tx.service.create({
        data: {
          customerId: ctx.otherCustomerId,
          unitId: ctx.other.id,
          vehicleId: ctx.vehOther,
          description: "Da outra",
          origin: "manual",
        },
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/services",
      });

      expect(res.statusCode).toBe(200);
      const page = unitServicePageSchema.parse(JSON.parse(res.body));
      // Both units were created inside this transaction, so the only rows either
      // can hold are the two above: a delta, not an absolute count.
      expect(page.rows.map((row) => row.description)).toEqual(["Da unidade"]);
      expect(page.rows[0]?.customerName).toBe("Ana");
      expect(page.hasMore).toBe(false);
      await ctx.app.close();
    }));
});
