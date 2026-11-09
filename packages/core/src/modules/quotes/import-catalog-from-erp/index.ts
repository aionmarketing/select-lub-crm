/**
 * `import-catalog-from-erp` — a worker job that writes the ERP's product list into the
 * quotes catalog.
 *
 * {@link importCatalogFromErp} is the plain function a test calls directly; {@link job}
 * wraps it for the kernel's job registry. Each product goes through the quotes contract
 * `upsertCatalogProduct`, which runs its own `db.tx("quotes", …)` — one short transaction
 * per product, never one wrapped around the loop, so no transaction spans the list and no
 * `db.tx` is nested inside another.
 *
 * Exported through the module's `createJobs(deps)` but NOT registered by `apps/worker` yet:
 * today the Omie pull imports the catalog through the same contract, on its own schedule
 * and `WORKER_OMIE_*` flags, and registering this as well would import every product twice
 * per pull. Wave 3A decomposes the pull and registers it (2B.2, option 1).
 */
import type { MockCatalogProduct } from "../../../kernel/clients/erp-mock.js";
import type { Db } from "../../../kernel/db.js";
import type { Job } from "../../../kernel/jobs.js";
import { upsertCatalogProduct } from "../contracts/upsert-catalog-product.js";

/** Tick interval when none is given: hourly, the Omie pull's own incremental cadence. */
export const IMPORT_CATALOG_EVERY_MS = 3_600_000;

/** What the job needs, held in the closure `createJobs` builds. */
export type ImportCatalogDeps = {
  db: Db;
  /** Lists the ERP's catalog products. Bound to the ERP port once 3A settles its shape. */
  listProducts: () => Promise<readonly MockCatalogProduct[]>;
  everyMs?: number;
};

/** How one import went, counted per product. */
export type ImportCatalogResult = { read: number; created: number; updated: number };

/**
 * Writes each product into the catalog under the `quotes` role.
 *
 * @param db - The database handle; every write goes through `db.tx("quotes", …)`, so a
 *   write to a table outside the quotes module is refused by Postgres.
 * @param products - The ERP's products, keyed by their Omie id.
 * @returns How many were read, created and updated.
 */
export async function importCatalogFromErp(
  db: Db,
  products: readonly MockCatalogProduct[],
): Promise<ImportCatalogResult> {
  const result: ImportCatalogResult = { read: products.length, created: 0, updated: 0 };
  for (const product of products) {
    const outcome = await upsertCatalogProduct(db, product);
    result[outcome] += 1;
  }
  return result;
}

/**
 * The job, for the kernel's registry.
 *
 * @param deps - The database handle, the product source and an optional interval.
 * @returns A job named `quotes/import-catalog-from-erp`.
 */
export function job(deps: ImportCatalogDeps): Job {
  return {
    name: "quotes/import-catalog-from-erp",
    everyMs: deps.everyMs ?? IMPORT_CATALOG_EVERY_MS,
    run: async () => {
      await importCatalogFromErp(deps.db, await deps.listProducts());
    },
  };
}
