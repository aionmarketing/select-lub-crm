# import-catalog-from-erp

**Purpose.** Keep the quotes catalog in step with the ERP's product list: every product
becomes a catalog item, a lubricant when it carries a viscosity, a filter when it carries a
filter type, neither when it carries both or none.

**Kind.** Worker job, `quotes/import-catalog-from-erp`, hourly by default. Entry points:
`importCatalogFromErp(db, products)`, the logic a test calls directly, and `job(deps)`, which
the module's `createJobs(deps)` registers. **Not registered by `apps/worker`:** the ERP
pull (`erp/run-pull`) imports the catalog through the same contract, on its own schedule and
`WORKER_OMIE_*` flags; registering this too would import every product twice per pull.
Wave 3A kept the catalog pull-driven (W2-C10): the pull counts catalog reads and writes into
its run's totals and records their errors against the run id, which this job would lose.

**Tables written** (`quotes`-owned, through the contract `upsertCatalogProduct`, one
`db.tx("quotes", …)` per product): `catalog_item`, `catalog_lubricant`, `catalog_filter`.

**Invariants.**
- Only `catalog_*` is written, under the `quotes` role; a write to any other module's table
  inside the import is refused by Postgres. The test proves it with a `customer` insert.
- Idempotent on the Omie id: an item is updated in place and keeps its id.
- A product arriving without a viscosity loses any lubricant detail left from an earlier
  import; a product carrying both kinds writes neither detail.
- An oil's lubricant detail carries the product's oil type, or none; a re-import follows the
  product, clearing a type it no longer carries (add-lubricant-oil-type).
- One transaction per product, never one around the loop: no `db.tx` spans the list and
  none is nested in another.

**Tests.** `tests/import-catalog-from-erp.integration.test.ts`, 10 cases: the 6 catalog
cases moved from `apps/worker/src/omie/import-surfaces.test.ts`, on per-test ids so no case
writes a demo-seeded catalog row, the role case, and three oil-type cases.

**Blocked on core.** `listProducts` is injected: the kernel's `ErpPort` does not list
products yet, and its shape is wave 3A's to settle.
