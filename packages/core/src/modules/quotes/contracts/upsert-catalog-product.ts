/**
 * Writes one ERP catalog product into the quotes catalog, under the `quotes`
 * role. The only way another module writes `catalog_item`, `catalog_lubricant`
 * or `catalog_filter`.
 *
 * Its caller is the ERP pull (`erp/run-pull`'s `createSurfaceImportStore`),
 * which keeps its schedule and its `WORKER_OMIE_*` flags. The
 * `import-catalog-from-erp` slice drives the same function as a job, which is
 * exported but not registered, so the catalog is never imported twice in one
 * pull (adopt-modular-vertical-slices 2B.2, option 1; kept pull-driven in 3A).
 *
 * Moved unchanged from `import-prisma.ts`: an existing item is updated in place
 * and keeps its id (the Omie id); a product with a viscosity and no filter type
 * is a lubricant, carrying the product's oil type or none (add-lubricant-oil-type); a
 * product with a filter type and no viscosity is a filter; a
 * product arriving WITHOUT a viscosity loses any lubricant detail left from an
 * earlier import; a product carrying both writes neither detail.
 */
import type { MockCatalogProduct } from "../../../kernel/clients/erp-mock.js";
import type { Db } from "../../../kernel/db.js";

/**
 * Upserts one catalog product and its detail row.
 *
 * @param db - The database handle; the write runs on `db.tx("quotes", …)`, so
 *   any table outside the quotes module is refused by Postgres.
 * @param product - The ERP product, keyed by its Omie id.
 * @returns Whether the catalog item was created or updated.
 */
export async function upsertCatalogProduct(
  db: Db,
  product: MockCatalogProduct,
): Promise<"created" | "updated"> {
  return db.tx("quotes", async (prisma) => {
    const existing = await prisma.catalogItem.findUnique({ where: { id: product.omieId } });
    const data = {
      brand: product.brand,
      description: product.description,
      price: product.price,
      stock: product.stock,
      active: product.active,
    };
    if (existing) {
      await prisma.catalogItem.update({
        where: { id: product.omieId },
        data,
      });
    } else {
      await prisma.catalogItem.create({
        data: { id: product.omieId, ...data },
      });
    }
    const viscosity = product.viscosity?.trim() ?? "";
    const hasViscosity = viscosity !== "";
    const hasFilter = product.filterType !== undefined;
    if (hasViscosity && !hasFilter) {
      // `oilType` in both branches: a re-import follows the product, clearing a type it dropped.
      const lubricant = { viscosity, classification: product.classification ?? "", oilType: product.oilType ?? null };
      await prisma.catalogLubricant.upsert({
        where: { catalogItemId: product.omieId },
        create: { catalogItemId: product.omieId, ...lubricant },
        update: lubricant,
      });
    } else {
      if (!hasViscosity) {
        await prisma.catalogLubricant.deleteMany({ where: { catalogItemId: product.omieId } });
      }
      if (hasFilter && !hasViscosity) {
        const filter = { filterType: product.filterType!, partNumber: product.partNumber ?? "" };
        await prisma.catalogFilter.upsert({
          where: { catalogItemId: product.omieId },
          create: { catalogItemId: product.omieId, ...filter },
          update: filter,
        });
      }
    }
    return existing ? "updated" : "created";
  });
}
