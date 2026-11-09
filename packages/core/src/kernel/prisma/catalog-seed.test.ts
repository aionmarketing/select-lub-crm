/**
 * Test design (testing-strategy)
 *
 * Setup: in-memory upsert fakes for catalogItem, catalogLubricant, and catalogFilter;
 * no Postgres.
 *
 * Oracle: split-catalog-lubricant-detail task 1.2 / demo-seed delta — each seeded oil
 * writes a generic item plus one lubricant-detail child; a second run duplicates
 * neither table. tecfil-filter-pricing task 2.3 / design D12 — each seeded filter
 * writes a generic item plus one filter-detail child, brand and type carried
 * verbatim; a row cannot carry both a lubricant-detail and a filter-detail.
 *
 * Axes
 *   A1 run count — 1 vs 2
 *   A2 table — catalog item vs lubricant-detail child vs filter-detail child
 *   A3 filter type — OLEO (two brands, one a cross-reference pair) vs COMBUSTIVEL
 *   A4 row validity — lubricant-only / filter-only / both fields set
 *
 * Outputs: O1 unique ids equal to CATALOG_SEED_ROWS length; O2 item shape (no
 * viscosity/filterType leaking onto the generic item); O3 lubricant-detail shape;
 * O4 filter-detail shape (filterType + partNumber); O5 thrown error, no writes for
 * that row
 *
 * Sampled-cells
 *   first run inserts every id             | A1 1 | A2 item        | O1 eight ids
 *   Motul oil has a lubricant child only    | A1 1 | A2 lubricant   | O2+O3
 *   Tecfil PEL108 has a filter child only   | A1 1 | A3 OLEO        | O2+O4
 *   Authomix FOL0108 is the OLEO 2nd brand  | A1 1 | A3 OLEO        | O4 partNumber
 *   Tecfil GI50/7 is COMBUSTIVEL            | A1 1 | A3 COMBUSTIVEL | O4 filterType
 *   second run does not duplicate           | A1 2 | A2 all three   | O1/O3/O4 counts held
 *   both-fields row is rejected             | A4 both              | O5 | silent write
 *
 * Out of scope: live Prisma seed.ts (exercised by demo-seed.live.test.ts); the
 * Prisma import surface's own filter write, covered where that store is exercised.
 */
import { describe, expect, it } from "vitest";
import { CATALOG_SEED_ROWS, seedCatalogItems, type CatalogSeedRow } from "./catalog-seed.js";

function fakeCatalog() {
  const items = new Map<string, Record<string, unknown>>();
  const lubricants = new Map<string, Record<string, unknown>>();
  const filters = new Map<string, Record<string, unknown>>();
  return {
    items,
    lubricants,
    filters,
    catalogItem: {
      async upsert(args: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        items.set(args.where.id, { id: args.where.id, ...args.update });
      },
    },
    catalogLubricant: {
      async upsert(args: {
        where: { catalogItemId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        lubricants.set(args.where.catalogItemId, {
          catalogItemId: args.where.catalogItemId,
          ...args.update,
        });
      },
    },
    catalogFilter: {
      async upsert(args: {
        where: { catalogItemId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        filters.set(args.where.catalogItemId, {
          catalogItemId: args.where.catalogItemId,
          ...args.update,
        });
      },
    },
  };
}

const LUBRICANT_ROW_COUNT = CATALOG_SEED_ROWS.filter((row) => row.viscosity !== undefined).length;
const FILTER_ROW_COUNT = CATALOG_SEED_ROWS.filter((row) => row.filterType !== undefined).length;

describe("seedCatalogItems", () => {
  it("inserts every seeded catalog id", async () => {
    const fake = fakeCatalog();

    await seedCatalogItems(fake);

    expect([...fake.items.keys()].sort()).toEqual(
      [...CATALOG_SEED_ROWS.map((row) => row.id)].sort(),
    );
  });

  it("writes a lubricant-detail child for the Motul oil and no filter-detail", async () => {
    const fake = fakeCatalog();

    await seedCatalogItems(fake);

    expect(fake.items.get("cat-motul-8100-5w30")).toEqual({
      id: "cat-motul-8100-5w30",
      brand: "Motul",
      description: "8100 Eco-nergy",
      price: 79.9,
      stock: 0,
      active: true,
    });
    expect(fake.lubricants.get("cat-motul-8100-5w30")).toEqual({
      catalogItemId: "cat-motul-8100-5w30",
      viscosity: "5W-30",
      classification: "API SERVICE SQ-RC, ILSAC GF-7A",
      oilType: "SINTETICO",
    });
    expect(fake.filters.has("cat-motul-8100-5w30")).toBe(false);
  });

  it("writes the oil type in both the create and the update branch, null when the row has none", async () => {
    // A row seeded before `oil_type` existed is reached by the update branch only; a type left
    // out of it would stay null forever (add-lubricant-oil-type, demo-seed "Re-seeding fills
    // the type on an existing row").
    const calls: Array<{ id: string; create: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const fake = fakeCatalog();
    fake.catalogLubricant.upsert = async (args) => {
      calls.push({ id: args.where.catalogItemId, create: args.create, update: args.update });
    };

    await seedCatalogItems(fake);

    const byId = new Map(calls.map((call) => [call.id, call]));
    expect(byId.get("cat-lubrax-tecno-5w30")?.create.oilType).toBe("SEMISSINTETICO");
    expect(byId.get("cat-lubrax-tecno-5w30")?.update.oilType).toBe("SEMISSINTETICO");
    expect(byId.get("cat-ipiranga-5w40")?.create.oilType).toBeNull();
    expect(byId.get("cat-ipiranga-5w40")?.update.oilType).toBeNull();
  });

  it("seeds two oil types among the active 5W-30 oils and one active oil with no type", () => {
    const active = CATALOG_SEED_ROWS.filter((row) => row.viscosity !== undefined && row.active);
    const typesAt5w30 = new Set(active.filter((row) => row.viscosity === "5W-30").map((row) => row.oilType));
    expect(typesAt5w30).toEqual(new Set(["SINTETICO", "SEMISSINTETICO"]));
    expect(active.filter((row) => row.oilType === undefined).map((row) => row.id)).toEqual(["cat-ipiranga-5w40"]);
  });

  it("writes a filter-detail child for the Tecfil oil filter and no lubricant-detail", async () => {
    const fake = fakeCatalog();

    await seedCatalogItems(fake);

    expect(fake.items.get("cat-tecfil-pel108")).toEqual({
      id: "cat-tecfil-pel108",
      brand: "Tecfil",
      description: "Filtro de óleo PEL108",
      price: 32,
      stock: 0,
      active: true,
    });
    expect(fake.filters.get("cat-tecfil-pel108")).toEqual({
      catalogItemId: "cat-tecfil-pel108",
      filterType: "OLEO",
      partNumber: "PEL108",
    });
    expect(fake.lubricants.has("cat-tecfil-pel108")).toBe(false);
  });

  it("seeds the Authomix cross-reference as a second active OLEO candidate", async () => {
    const fake = fakeCatalog();

    await seedCatalogItems(fake);

    expect(fake.items.get("cat-authomix-fol0108")).toMatchObject({
      brand: "Authomix",
      active: true,
    });
    expect(fake.filters.get("cat-authomix-fol0108")).toEqual({
      catalogItemId: "cat-authomix-fol0108",
      filterType: "OLEO",
      partNumber: "FOL0108",
    });
  });

  it("seeds the Tecfil fuel filter as COMBUSTIVEL", async () => {
    const fake = fakeCatalog();

    await seedCatalogItems(fake);

    expect(fake.filters.get("cat-tecfil-gi50-7")).toEqual({
      catalogItemId: "cat-tecfil-gi50-7",
      filterType: "COMBUSTIVEL",
      partNumber: "GI50/7",
    });
  });

  it("does not duplicate any table on a second run", async () => {
    const fake = fakeCatalog();

    await seedCatalogItems(fake);
    await seedCatalogItems(fake);

    expect(fake.items.size).toBe(CATALOG_SEED_ROWS.length);
    expect(fake.lubricants.size).toBe(LUBRICANT_ROW_COUNT);
    expect(fake.filters.size).toBe(FILTER_ROW_COUNT);
  });

  it("rejects a row carrying both lubricant and filter fields, writing neither the item nor a detail", async () => {
    const fake = fakeCatalog();
    const badRow: CatalogSeedRow = {
      id: "cat-both-fields",
      brand: "Tecfil",
      description: "Linha inválida",
      viscosity: "5W-30",
      classification: "API SN",
      filterType: "OLEO",
      partNumber: "PEL108",
      price: 10,
      stock: 0,
      active: true,
    };

    await expect(seedCatalogItems(fake, [badRow])).rejects.toThrow(/both/);

    expect(fake.items.has("cat-both-fields")).toBe(false);
    expect(fake.lubricants.has("cat-both-fields")).toBe(false);
    expect(fake.filters.has("cat-both-fields")).toBe(false);
  });
});
