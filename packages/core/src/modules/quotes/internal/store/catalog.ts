/**
 * The internal catalog a quote is priced from: every item with its lubricant or
 * filter detail, and one item by id.
 */
import type { DbClient } from "@select-lub/core/db";
import { oilTypeSchema, type CatalogItem, type OilType } from "../../contracts/http.js";
import { iso, type DecimalLike } from "./column-readers.js";
import type { OilQuoteStore } from "./store.js";

function toCatalogDto(row: {
  id: string;
  brand: string;
  description: string;
  price: DecimalLike;
  stock: DecimalLike;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CatalogItem {
  return {
    id: row.id,
    brand: row.brand,
    description: row.description,
    price: row.price.toNumber(),
    stock: row.stock.toNumber(),
    active: row.active,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * Reads `catalog_lubricant.oil_type` into the contract's union. The column's CHECK admits only
 * the three values or NULL, so the parse cannot fail on a migrated database; it is the typed
 * boundary, the way `filterType` is a string column narrowed here.
 *
 * @param value - The stored column.
 * @returns The oil type, or `null` when the lubricant has none.
 */
function readOilType(value: string | null): OilType | null {
  return oilTypeSchema.nullable().parse(value);
}

/**
 * @param prisma - The client the quote runs on.
 * @returns The catalog half of {@link OilQuoteStore}.
 */
export function catalogQueries(
  prisma: DbClient,
): Pick<OilQuoteStore, "listCatalog" | "getCatalogItem"> {
  return {
    async listCatalog() {
      const rows = await prisma.catalogItem.findMany({
        include: { lubricant: true, filter: true },
      });
      return rows.map((row) => ({
        ...toCatalogDto(row),
        lubricant: row.lubricant
          ? {
              catalogItemId: row.lubricant.catalogItemId,
              viscosity: row.lubricant.viscosity,
              classification: row.lubricant.classification,
              oilType: readOilType(row.lubricant.oilType),
            }
          : null,
        filter: row.filter
          ? {
              catalogItemId: row.filter.catalogItemId,
              filterType: row.filter.filterType as "OLEO" | "COMBUSTIVEL",
              partNumber: row.filter.partNumber,
            }
          : null,
      }));
    },
    async getCatalogItem(id) {
      const row = await prisma.catalogItem.findUnique({ where: { id } });
      return row ? toCatalogDto(row) : null;
    },
  };
}
