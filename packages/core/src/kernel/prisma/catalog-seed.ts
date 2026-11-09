/**
 * Mock catalog standing in for the future Omie product import (oil-quote D2). Each row
 * seeds a generic `CatalogItem` plus at most one detail child: `CatalogLubricant` when the
 * row carries oil fields, or `CatalogFilter` (tecfil-filter-pricing D12) when it carries
 * filter fields. A lubricant row's `price` is the price of ONE LITRE; a filter row's
 * `price` is one filter and is never multiplied. A row must not carry both — `seedCatalogItems` rejects one that does.
 */
export type CatalogSeedRow = {
  id: string;
  brand: string;
  description: string;
  price: number;
  stock: number;
  active: boolean;
  /** Oil viscosity (e.g. `5W-30`); present exactly when the row is a lubricant. */
  viscosity?: string;
  classification?: string;
  /**
   * Base-oil type (add-lubricant-oil-type); lubricant rows only. Absent means the row has no
   * recorded type. Demo values for a mocked catalog (ruling 6, 2026-10-10), not a statement
   * about the real products.
   */
  oilType?: SeedOilType;
  /** Filter kind; present exactly when the row is a filter. */
  filterType?: "OLEO" | "COMBUSTIVEL";
  /** The item's own part number, compared against Tecfil numbers and cross-references. */
  partNumber?: string;
};

/** The stored oil-type values. The quotes contract's `oilTypeSchema` is the authority; the kernel mirrors it. */
export type SeedOilType = "SINTETICO" | "SEMISSINTETICO" | "MINERAL";

export const CATALOG_SEED_ROWS: CatalogSeedRow[] = [
  {
    id: "cat-motul-8100-5w30",
    brand: "Motul",
    description: "8100 Eco-nergy",
    viscosity: "5W-30",
    classification: "API SERVICE SQ-RC, ILSAC GF-7A",
    oilType: "SINTETICO",
    price: 79.9,
    stock: 0,
    active: true,
  },
  {
    id: "cat-lubrax-tecno-5w30",
    brand: "Lubrax",
    description: "Tecno",
    viscosity: "5W-30",
    classification: "API SERVICE SQ-RC, ILSAC GF-7A",
    oilType: "SEMISSINTETICO",
    price: 52.9,
    stock: 0,
    active: true,
  },
  {
    id: "cat-motul-8100-5w40",
    brand: "Motul",
    description: "8100 X-cess",
    viscosity: "5W-40",
    classification: "API SN",
    oilType: "SINTETICO",
    price: 74.9,
    stock: 0,
    active: true,
  },
  {
    id: "cat-ipiranga-5w40",
    brand: "Ipiranga",
    description: "F1 Master",
    viscosity: "5W-40",
    classification: "API SN",
    // No oil type on purpose: the demo's untyped card and message (ruling 1).
    price: 56.9,
    stock: 0,
    active: true,
  },
  {
    id: "cat-lubrax-essencial-5w30",
    brand: "Lubrax",
    description: "Essencial",
    viscosity: "5W-30",
    classification: "API SERVICE SQ-RC, ILSAC GF-7A",
    oilType: "MINERAL",
    price: 44.9,
    stock: 0,
    active: false,
  },
  // Oil filters the committed Tecfil capture fits to the seeded Polo 2021 1.0 TSI.
  // Two of them on purpose: PSL545 is Tecfil's own number and FOL0545 is the Authomix
  // cross-reference the same capture recorded, so the oil-filter chooser has something to
  // choose between.
  {
    id: "cat-tecfil-psl545",
    brand: "Tecfil",
    description: "Filtro de óleo PSL545",
    filterType: "OLEO",
    partNumber: "PSL545",
    price: 38.9,
    stock: 0,
    active: true,
  },
  {
    id: "cat-authomix-fol0545",
    brand: "Authomix",
    description: "Filtro de óleo FOL0545",
    filterType: "OLEO",
    partNumber: "FOL0545",
    price: 33.5,
    stock: 0,
    active: true,
  },
  {
    id: "cat-tecfil-pel108",
    brand: "Tecfil",
    description: "Filtro de óleo PEL108",
    filterType: "OLEO",
    partNumber: "PEL108",
    price: 32,
    stock: 0,
    active: true,
  },
  {
    id: "cat-authomix-fol0108",
    brand: "Authomix",
    description: "Filtro de óleo FOL0108",
    filterType: "OLEO",
    partNumber: "FOL0108",
    price: 28.9,
    stock: 0,
    active: true,
  },
  {
    id: "cat-tecfil-gi50-7",
    brand: "Tecfil",
    description: "Filtro de combustível GI50/7",
    filterType: "COMBUSTIVEL",
    partNumber: "GI50/7",
    price: 45,
    stock: 0,
    active: true,
  },
];

type CatalogItemWrite = {
  brand: string;
  description: string;
  price: number;
  stock: number;
  active: boolean;
};

type LubricantWrite = { viscosity: string; classification: string; oilType: SeedOilType | null };

type FilterWrite = { filterType: string; partNumber: string };

/**
 * Upserts the mock catalog rows as generic items plus at most one detail child, so a second
 * seed run does not duplicate any table. A row carrying both lubricant and filter fields is
 * rejected before anything is written for it.
 *
 * @param prisma - Prisma client with `catalogItem`, `catalogLubricant`, and `catalogFilter` delegates.
 * @param rows - Rows to seed; defaults to {@link CATALOG_SEED_ROWS}.
 * @throws When a row carries both lubricant fields (`viscosity`) and filter fields (`filterType`).
 */
export async function seedCatalogItems(
  prisma: {
    catalogItem: {
      upsert: (args: {
        where: { id: string };
        create: CatalogItemWrite & { id: string };
        update: CatalogItemWrite;
      }) => Promise<unknown>;
    };
    catalogLubricant: {
      upsert: (args: {
        where: { catalogItemId: string };
        create: LubricantWrite & { catalogItemId: string };
        update: LubricantWrite;
      }) => Promise<unknown>;
    };
    catalogFilter: {
      upsert: (args: {
        where: { catalogItemId: string };
        create: FilterWrite & { catalogItemId: string };
        update: FilterWrite;
      }) => Promise<unknown>;
    };
  },
  rows: CatalogSeedRow[] = CATALOG_SEED_ROWS,
) {
  for (const row of rows) {
    const isLubricant = row.viscosity !== undefined;
    const isFilter = row.filterType !== undefined;
    if (isLubricant && isFilter) {
      throw new Error(
        `catalog seed row "${row.id}" carries both lubricant and filter fields`,
      );
    }

    const item = {
      brand: row.brand,
      description: row.description,
      price: row.price,
      stock: row.stock,
      active: row.active,
    };
    await prisma.catalogItem.upsert({
      where: { id: row.id },
      create: { id: row.id, ...item },
      update: item,
    });

    if (isLubricant) {
      // `oilType` in both branches, so a row seeded before the column existed gets its type on re-seed.
      const lubricant = { viscosity: row.viscosity!, classification: row.classification ?? "", oilType: row.oilType ?? null };
      await prisma.catalogLubricant.upsert({
        where: { catalogItemId: row.id },
        create: { catalogItemId: row.id, ...lubricant },
        update: lubricant,
      });
    } else if (isFilter) {
      const filter = { filterType: row.filterType!, partNumber: row.partNumber! };
      await prisma.catalogFilter.upsert({
        where: { catalogItemId: row.id },
        create: { catalogItemId: row.id, ...filter },
        update: filter,
      });
    }
  }
}
