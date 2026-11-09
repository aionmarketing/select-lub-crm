# list-customer-pendings

**Purpose.** List a customer's open reconciliation pendings (CRM value against Omie value, per field).

**Kind.** HTTP route, `GET /customers/:id/reconciliation-pendings`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (none; it reads): reads only.

**Invariants.**
- Includes the titular vehicle's pendings.
- 404, never 403, for anything outside the caller's unit: the response must not confirm it exists.

**Tests.** 2 cases: `route` (1, from `cadastro.test.ts`) and `vehicles` (1, titular-only pendings, from `cadastro.vehicles.test.ts`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
