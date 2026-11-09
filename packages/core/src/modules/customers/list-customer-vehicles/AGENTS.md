# list-customer-vehicles

**Purpose.** List a customer's vehicles.

**Kind.** HTTP route, `GET /customers/:id/vehicles`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (none; it reads): reads only.

**Invariants.**
- Each vehicle carries `plateSourcedKeys`, read from the plate-origin store.
- 404, never 403, for anything outside the caller's unit: the response must not confirm it exists.

**Tests.** 2 cases in `vehicles` (from `cadastro.vehicles.test.ts`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
