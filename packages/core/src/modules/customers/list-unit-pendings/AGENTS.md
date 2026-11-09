# list-unit-pendings

**Purpose.** The pendings queue: every open pending in the caller's unit, with each customer's name.

**Kind.** HTTP route, `GET /reconciliation-pendings`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (none; it reads): reads only.

**Invariants.**
- Scoped to the caller's current unit; 404 without one.

**Tests.** 2 cases in `route` (from `cadastro.test.ts`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
