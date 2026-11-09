/**
 * Test design (testing-strategy)
 *
 * SUT: `POST /vehicles/:id/quotes` over HTTP — the slice's route, its body schema, the
 *   line-pricing rule and the insert — mounted on the kernel app by `buildSliceApp`, with
 *   `request.server.db` over the test's rolling-back transaction.
 *
 * Ran under module role: `quotes` (the whole request is one `db.tx("quotes", …)`).
 *
 * Moved from apps/api/src/quote.route.test.ts (adopt-modular-vertical-slices 2B.1): its
 * seven POST cases, assertions unchanged. The caller is stated through `buildSliceApp`,
 * and is a real seeded user because `oil_quote.created_by_user_id` is a foreign key to
 * `user`. The one case that read the catalog price back used the internal store; it now
 * reads the same `catalog_item` row directly, still asserting the price by value.
 *
 * The catalog is seeded into the transaction with the production `seedCatalogItems`, so
 * no case depends on how the suite was invoked. The three rejections are refused by the
 * schema or the handler before any write, so the reads after them are legal: none aborts
 * the transaction (memory: constraint-violation-aborts-test-transaction).
 *
 * Oracle: oil-quote HTTP — persist freeze, filter lines at the catalog price, malformed
 * body — and design D10.
 *
 * Axes
 *   A3 persist — catalog price differs from the offered one vs frozen line
 *   A4 body — valid vs missing lines / unknown item / non-numeric price
 *   A6 line kind — oil (no filter detail) vs filter (filter detail present)
 *   A7 filter line body price — equal to the catalog price vs different
 *
 * Sampled-cell
 *   persist freeze          | A3 | line 100, catalog 74.9      | the catalog price
 *   oil + two filters       | A6 | 3 lines: 100 / 32 / 45      | filter at body price
 *   filter body price 1     | A7 | line 32 (catalog)           | 1
 *   oil line only           | A6 | exactly 1 line              | a filter line appears
 *   omit lines              | A4 | 400                         | 201
 *   unknown catalog item    | A4 | 400 and no quote written    | 201
 *   non-numeric price       | A4 | 400 and no quote written    | 201
 *
 * Decision map (create-quote/index.ts)
 *   `!unitId || !userId`     contract-hidden: apps/api's hook answers 401/403 first
 *   `not_found`              the handler's own 404 — sampled for this route's twin in
 *                            get-quote-options, which shares `findVehicleInUnit`
 *   `unknown_catalog_item`   T the unknown-item it; F every 201 it
 *   `item.filter ? … : …`    T the two filter-line its; F every oil-line it
 */
import { CATALOG_SEED_ROWS, prisma, seedCatalogItems, type PrismaClient } from "@select-lub/core/db";
import { oilQuoteSchema } from "../../contracts/http.js";
import { expect, it } from "vitest";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { createOilQuoteBodySchema } from "../../contracts/http.js";
import { route } from "../index.js";

/** The seeded price of the oil every persist test offers at 100, asserted by value. */
const OIL_CATALOG_PRICE = CATALOG_SEED_ROWS.find((row) => row.id === "cat-motul-8100-5w40")!.price;

/**
 * Seeds the production catalog, a unit, an attendant in it, and a customer with a vehicle;
 * mounts the slice with that attendant as the caller.
 *
 * @param tx - The test transaction.
 */
async function setup(tx: DbClient) {
  await seedCatalogItems(tx);
  const unit = await seedUnit(tx);
  const attendant = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({
    data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      origin: "manual",
      make: "Toyota",
      model: "Corolla",
      version: "1.8 XEi",
      year: 2019,
      plate: "ABC1D23",
    },
    select: { id: true },
  });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (a) => registerSlice(a, "quotes", "create-quote", route()),
    caller: { userId: attendant.id, unitId: unit.id },
  });
  return { app, customerId: customer.id, vehA: vehicle.id };
}

const json = { "content-type": "application/json" };

describeWithDatabase("POST /vehicles/:id/quotes", () => {
  const db = () => prisma as PrismaClient;

  it("freezes the offered price when the catalog later changes", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      const created = await ctx.app.inject({
        method: "POST",
        url: `/vehicles/${ctx.vehA}/quotes`,
        headers: json,
        payload: {
          generatedMessageText: "proposta",
          lines: [{ catalogItemId: "cat-motul-8100-5w40", price: 100 }],
        },
      });

      expect(created.statusCode).toBe(201);
      const quote = oilQuoteSchema.parse(JSON.parse(created.body));
      expect(quote.customerId).toBe(ctx.customerId);
      expect(quote.vehicleId).toBe(ctx.vehA);
      expect(quote.lines[0]?.price).toBe(100);

      const catalog = await tx.catalogItem.findUnique({ where: { id: "cat-motul-8100-5w40" } });
      // By value, not merely "not 100": a read that returned nothing would also
      // satisfy `not.toBe(100)` and the freeze would go unproven.
      expect(catalog?.price.toNumber()).toBe(OIL_CATALOG_PRICE);
      expect(quote.lines[0]?.price).toBe(100);
      await ctx.app.close();
    }));

  it("persists the oil at its offered price and each filter at the catalog price", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);

      const created = await ctx.app.inject({
        method: "POST",
        url: `/vehicles/${ctx.vehA}/quotes`,
        headers: json,
        payload: {
          generatedMessageText: "proposta",
          lines: [
            { catalogItemId: "cat-motul-8100-5w40", price: 100 },
            { catalogItemId: "cat-tecfil-pel108", price: 32 },
            { catalogItemId: "cat-tecfil-gi50-7", price: 45 },
          ],
        },
      });

      expect(created.statusCode).toBe(201);
      const quote = oilQuoteSchema.parse(JSON.parse(created.body));
      expect(quote.lines.map((line) => [line.catalogItemId, line.price])).toEqual([
        ["cat-motul-8100-5w40", 100],
        ["cat-tecfil-pel108", 32],
        ["cat-tecfil-gi50-7", 45],
      ]);
      await ctx.app.close();
    }));

  it("ignores the body price on a filter line and freezes the catalog price", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);

      const created = await ctx.app.inject({
        method: "POST",
        url: `/vehicles/${ctx.vehA}/quotes`,
        headers: json,
        payload: {
          generatedMessageText: "proposta",
          lines: [
            { catalogItemId: "cat-motul-8100-5w40", price: 100 },
            { catalogItemId: "cat-tecfil-pel108", price: 1 },
          ],
        },
      });

      expect(created.statusCode).toBe(201);
      const quote = oilQuoteSchema.parse(JSON.parse(created.body));
      expect(quote.lines[1]).toMatchObject({ catalogItemId: "cat-tecfil-pel108", price: 32 });
      await ctx.app.close();
    }));

  it("persists no filter line when the body sent none", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);

      const created = await ctx.app.inject({
        method: "POST",
        url: `/vehicles/${ctx.vehA}/quotes`,
        headers: json,
        payload: {
          generatedMessageText: "proposta",
          lines: [{ catalogItemId: "cat-motul-8100-5w40", price: 100 }],
        },
      });

      expect(created.statusCode).toBe(201);
      const quote = oilQuoteSchema.parse(JSON.parse(created.body));
      expect(quote.lines).toHaveLength(1);
      await ctx.app.close();
    }));

  it("rejects a body that omits selected options", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);

      const res = await ctx.app.inject({
        method: "POST",
        url: `/vehicles/${ctx.vehA}/quotes`,
        headers: json,
        payload: { generatedMessageText: "proposta" },
      });

      expect(res.statusCode).toBe(400);
      expect(createOilQuoteBodySchema.safeParse({ generatedMessageText: "proposta" }).success).toBe(
        false,
      );
      await ctx.app.close();
    }));

  it("rejects a line whose catalog item is unknown, writing no quote", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);

      const res = await ctx.app.inject({
        method: "POST",
        url: `/vehicles/${ctx.vehA}/quotes`,
        headers: json,
        payload: {
          generatedMessageText: "proposta",
          lines: [{ catalogItemId: "cat-missing", price: 100 }],
        },
      });

      expect(res.statusCode).toBe(400);
      // The refusal left no row: an absence check the fake could not make, since
      // nothing there distinguished "not written" from "written elsewhere".
      expect(await tx.oilQuote.count({ where: { vehicleId: ctx.vehA } })).toBe(0);
      await ctx.app.close();
    }));

  it("rejects a non-numeric price without persisting", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);

      const res = await ctx.app.inject({
        method: "POST",
        url: `/vehicles/${ctx.vehA}/quotes`,
        headers: json,
        payload: {
          generatedMessageText: "proposta",
          lines: [{ catalogItemId: "cat-motul-8100-5w40", price: "cem" }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(await tx.oilQuote.count({ where: { vehicleId: ctx.vehA } })).toBe(0);
      await ctx.app.close();
    }));
});
