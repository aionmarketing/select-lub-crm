# resolve-pending

**Purpose.** Resolve one open pending: keep the CRM value, take Omie's, or type a new one.

**Kind.** HTTP route, `POST /customers/:id/reconciliation-pendings/resolve`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `customer`, `vehicle`, both `*_field_sync`, both `*_reconciliation_pending`.

**Invariants.**
- Through `resolvePending`: choosing CRM or an edited value pushes to Omie synchronously (503 with the saved customer when unreachable). Needs a signed-in user (`crmUserId`), who is recorded as the resolver.
- Publishes `customers/customer-changed` (source `pending-resolve`) after the save.
- 404, never 403, for anything outside the caller's unit: the response must not confirm it exists.

**Tests.** 18 cases: `choices` / `failures` / `guards` (3 + 5 + 6, `resolvePending` on the real store, from `apps/api/src/cadastro/omie/resolve-pending.test.ts`) and `route` (4, from `cadastro.test.ts`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
