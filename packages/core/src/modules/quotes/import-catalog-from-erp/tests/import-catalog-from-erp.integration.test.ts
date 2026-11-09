/**
 * Test design (testing-strategy)
 *
 * SUT: `importCatalogFromErp` — ERP catalog products into `catalog_item`, `catalog_lubricant`
 *   and `catalog_filter` — through the slice's entry point, which writes each product
 *   through the quotes contract `upsertCatalogProduct` on the real database in a
 *   rolling-back transaction.
 *
 * Ran under module role: `quotes` — asserted, not assumed: the last case records the module
 *   every transaction asked for, and then proves the role refuses a write outside it.
 *
 * Moved from apps/worker/src/omie/import-surfaces.test.ts (adopt-modular-vertical-slices
 * 2B.2): its six catalog-only cases, 6 of that file's 24. There they drove the whole Omie
 * import (`importMockSurfaces`); here they drive the slice's own function with the same
 * products, because the catalog is now the quotes module's to write.
 *
 * **Every product id is this test's own.** The mock products carry the same ids as the
 * demo-seeded catalog (`cat-motul-8100-5w30`, `cat-tecfil-pel108`, `cat-tecfil-gi50-7`), and
 * the downgrade case deletes a lubricant detail. In the worker package nothing else wrote
 * those rows concurrently. In `@select-lub/core` this file runs in parallel with the five
 * quote files, all of which upsert those ids through `seedCatalogItems`, in another row
 * order — the lock pattern that deadlocks (memory: never-write-demo-seeded-rows-in-tests).
 * So each case prefixes the ids it writes. The assertions keep their meaning — which
 * product becomes a lubricant row, which a filter row, which neither — over renamed ids.
 *
 * Oracle: omie-mock — importing is idempotent on the Omie id; a mock product may carry
 * filter fields and then writes exactly one filter detail (tecfil-filter-pricing task
 * 2.4); a product with both kinds writes neither detail; one arriving without a viscosity
 * loses its lubricant detail. And 2B.2: the import writes only `catalog_*`, under the
 * `quotes` role, and a write to `customer` inside it is refused.
 *
 * Axes
 *   A6 product detail — oil / filter / neither / both
 *   A11 catalog downgrade — had a viscosity, returns without; never had one
 *
 * Sampled-cell
 *   fixture Motul              | A6 oil     | a catalog item plus a lubricant row
 *   Tecfil mocks               | A6 filter  | catalog items plus filter rows, no lubricant
 *   both kinds                 | A6 both    | the item, and neither detail
 *   neither kind               | A6 neither | the item, and no detail
 *   oily, then not             | A11        | the lubricant row is dropped
 *   empty classification       | A6 oil     | still a lubricant row
 *   role                       | —          | every transaction asked for `quotes`; a
 *      `customer` write inside one is refused by Postgres — fails if the import ran with
 *      a role that could write `customer`, or none at all
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { mockOmieDataset, type MockCatalogProduct } from "../../../../kernel/clients/erp-mock.js";
import { expect, it } from "vitest";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  withTestTransaction,
} from "../../../../testing/index.js";
import {
  createDb,
  type Db,
  type DbClient,
  type ModuleName,
  type RunInTransaction,
} from "../../../../kernel/db.js";
import { importCatalogFromErp } from "../index.js";

/** Ids unique to one test, so no case writes a demo-seeded or another suite's row. */
function idsFor() {
  const prefix = `t${randomUUID().replace(/-/g, "").slice(0, 8)}-`;
  return (omieId: string) => `${prefix}${omieId}`;
}

/** The mock dataset's products, under this test's ids. */
function mockProducts(id: (omieId: string) => string): MockCatalogProduct[] {
  return mockOmieDataset().products.map((product) => ({ ...product, omieId: id(product.omieId) }));
}

const MOCK_IDS = ["cat-motul-8100-5w30", "cat-tecfil-pel108", "cat-tecfil-gi50-7"];

async function catalogIds(tx: DbClient, ids: readonly string[]): Promise<string[]> {
  const rows = await tx.catalogItem.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
  return rows.map((row) => row.id).sort();
}

async function lubricantIds(tx: DbClient, ids: readonly string[]): Promise<string[]> {
  const rows = await tx.catalogLubricant.findMany({
    where: { catalogItemId: { in: [...ids] } },
    select: { catalogItemId: true },
  });
  return rows.map((row) => row.catalogItemId).sort();
}

async function filterIds(tx: DbClient, ids: readonly string[]): Promise<string[]> {
  const rows = await tx.catalogFilter.findMany({
    where: { catalogItemId: { in: [...ids] } },
    select: { catalogItemId: true },
  });
  return rows.map((row) => row.catalogItemId).sort();
}

function dbOn(tx: DbClient): Db {
  return createDb(tx, runInTransactionOnTx(tx));
}

/**
 * A `Db` that records the module every transaction asks for, and — when `intrude` is set —
 * attempts a write to `customer` INSIDE each transaction, under whatever role it was
 * opened with. That places the deliberate foreign write in the import's own transaction.
 */
function spyDb(tx: DbClient, intrude: boolean) {
  const real = dbOn(tx);
  const modules: ModuleName[] = [];
  const db: Db = {
    client: real.client,
    tx<T>(module: ModuleName, fn: (inner: DbClient) => Promise<T>, run?: RunInTransaction) {
      modules.push(module);
      return real.tx(
        module,
        async (inner) => {
          if (intrude) {
            await inner.customer.create({
              data: { name: "Intrusa", origin: "manual", status: "active" },
            });
          }
          return fn(inner);
        },
        run,
      );
    },
  };
  return { db, modules };
}

/** `it` whose body runs inside a test transaction that always rolls back. */
function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

describeWithDatabase("importCatalogFromErp", () => {
  itInTx("imports the fixture Motul product as a catalog item plus a lubricant-detail row", async (tx) => {
    const id = idsFor();
    await importCatalogFromErp(dbOn(tx), mockProducts(id));

    const ids = MOCK_IDS.map(id);
    expect(await catalogIds(tx, ids)).toEqual([...ids].sort());
    expect(await lubricantIds(tx, ids)).toEqual([id("cat-motul-8100-5w30")]);
    const product = mockOmieDataset().products[0]!;
    expect(product.description).toBe("8100 Eco-nergy");
    expect(product.stock).toBe(0);
    expect("productLine" in product).toBe(false);
  });

  itInTx("imports the Tecfil mock products as catalog items plus filter-detail rows", async (tx) => {
    const id = idsFor();
    await importCatalogFromErp(dbOn(tx), mockProducts(id));

    const ids = MOCK_IDS.map(id);
    expect(await filterIds(tx, ids)).toEqual(
      [id("cat-tecfil-gi50-7"), id("cat-tecfil-pel108")].sort(),
    );
    const lubricants = await lubricantIds(tx, ids);
    expect(lubricants).not.toContain(id("cat-tecfil-pel108"));
    expect(lubricants).not.toContain(id("cat-tecfil-gi50-7"));
  });

  itInTx("rejects a mock product carrying both a viscosity and a filter type, writing neither detail", async (tx) => {
    const id = idsFor();
    await importCatalogFromErp(dbOn(tx), [
      {
        omieId: id("cat-both-fields"),
        brand: "Tecfil",
        description: "Produto inválido",
        price: 10,
        stock: 0,
        active: true,
        viscosity: "5W-30",
        filterType: "OLEO",
        partNumber: "PEL108",
      },
    ]);

    const scope = [id("cat-both-fields")];
    expect(await catalogIds(tx, scope)).toEqual(scope);
    expect(await lubricantIds(tx, scope)).toEqual([]);
    expect(await filterIds(tx, scope)).toEqual([]);
  });

  itInTx("imports a product with no viscosity or filter type as a catalog item without a detail row", async (tx) => {
    const id = idsFor();
    await importCatalogFromErp(dbOn(tx), [
      ...mockProducts(id),
      {
        omieId: id("cat-filtro-oleo-plain"),
        brand: "Tecfil",
        description: "Filtro de óleo PSL560",
        price: 34.9,
        stock: 12,
        active: true,
      },
    ]);

    const scope = [...MOCK_IDS, "cat-filtro-oleo-plain"].map(id);
    expect(await catalogIds(tx, scope)).toEqual([...scope].sort());
    expect(await lubricantIds(tx, scope)).toEqual([id("cat-motul-8100-5w30")]);
    expect(await filterIds(tx, scope)).toEqual(
      [id("cat-tecfil-gi50-7"), id("cat-tecfil-pel108")].sort(),
    );
  });

  itInTx("deletes the lubricant-detail when a previously oily product returns without viscosity", async (tx) => {
    const id = idsFor();
    const db = dbOn(tx);
    await importCatalogFromErp(db, mockProducts(id));
    expect(await lubricantIds(tx, [id("cat-motul-8100-5w30")])).toEqual([id("cat-motul-8100-5w30")]);

    await importCatalogFromErp(db, [
      {
        omieId: id("cat-motul-8100-5w30"),
        brand: "Motul",
        description: "8100 Eco-nergy",
        price: 189.9,
        stock: 0,
        active: true,
      },
      {
        omieId: id("cat-never-oil"),
        brand: "Gen",
        description: "Pano",
        price: 1,
        stock: 0,
        active: true,
      },
    ]);

    const scope = [id("cat-motul-8100-5w30"), id("cat-never-oil")];
    expect(await catalogIds(tx, scope)).toEqual([...scope].sort());
    expect(await lubricantIds(tx, scope)).toEqual([]);
  });

  itInTx("imports a TIDSCI oil with empty classification as a lubricant-detail (quote match is internal/catalog/match.test.ts)", async (tx) => {
    const id = idsFor();
    await importCatalogFromErp(dbOn(tx), [
      {
        omieId: id("123456789012"),
        brand: "Radnaq",
        description: "OLEO RADNAQ 5W30 1L",
        price: 80,
        stock: 3,
        active: true,
        viscosity: "5W30",
        classification: "",
      },
    ]);

    expect(await lubricantIds(tx, [id("123456789012")])).toEqual([id("123456789012")]);
  });

  // add-lubricant-oil-type — omie-mock "Mock catalog product matches the split catalog".
  itInTx("imports the fixture Motul product with oil type SINTETICO", async (tx) => {
    const id = idsFor();
    await importCatalogFromErp(dbOn(tx), mockProducts(id));

    const row = await tx.catalogLubricant.findUnique({ where: { catalogItemId: id("cat-motul-8100-5w30") } });
    expect(row?.oilType).toBe("SINTETICO");
  });

  itInTx("imports an oil without an oil type with none", async (tx) => {
    const id = idsFor();
    await importCatalogFromErp(dbOn(tx), [
      { omieId: id("cat-untyped"), brand: "Gen", description: "Óleo 5W-40", price: 40, stock: 1, active: true, viscosity: "5W-40" },
    ]);

    const row = await tx.catalogLubricant.findUnique({ where: { catalogItemId: id("cat-untyped") } });
    expect(row).toMatchObject({ viscosity: "5W-40", oilType: null });
  });

  itInTx("re-importing an oil follows its current oil type, clearing it when dropped", async (tx) => {
    const id = idsFor();
    const db = dbOn(tx);
    const base: MockCatalogProduct = { omieId: id("cat-retyped"), brand: "Gen", description: "Óleo 5W-30", price: 40, stock: 1, active: true, viscosity: "5W-30" };
    const read = async () => tx.catalogLubricant.findMany({ where: { catalogItemId: id("cat-retyped") } });

    await importCatalogFromErp(db, [{ ...base, oilType: "SEMISSINTETICO" }]);
    expect((await read()).map((row) => row.oilType)).toEqual(["SEMISSINTETICO"]);
    await importCatalogFromErp(db, [{ ...base, oilType: "SINTETICO" }]);
    expect((await read()).map((row) => row.oilType)).toEqual(["SINTETICO"]);
    await importCatalogFromErp(db, [base]);
    expect((await read()).map((row) => row.oilType)).toEqual([null]);
  });

  itInTx("writes under the quotes role, and a write to customer inside it is refused", async (tx) => {
    const id = idsFor();
    const products = mockProducts(id);

    // Positive control first: the same products, through a transaction that attempts
    // nothing foreign, import cleanly — one transaction per product, each asking for the
    // quotes role.
    const clean = spyDb(tx, false);
    await expect(importCatalogFromErp(clean.db, products)).resolves.toMatchObject({
      read: products.length,
    });
    expect(clean.modules).toEqual(products.map(() => "quotes"));

    // Last in the test, because a refused write aborts the transaction it runs in: the
    // same import, with a `customer` insert attempted inside its own transaction. Postgres
    // refuses it under the quotes role, whatever the insert's values.
    const intruding = spyDb(tx, true);
    await expect(importCatalogFromErp(intruding.db, products)).rejects.toThrow(
      /permission denied for table customer/,
    );
  });
});
