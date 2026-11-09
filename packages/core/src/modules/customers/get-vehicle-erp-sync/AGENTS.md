# get-vehicle-erp-sync

**Purpose.** Where a vehicle stands with Omie: never synced, synced (with the last check), failed (with the reason), or fields in conflict.

**Kind.** HTTP route, `GET /vehicles/:id/omie-sync`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (none; it reads): reads only.

**Invariants.**
- The ranking is `buildVehicleOmieSync` in `contracts/http.omie-sync.ts`, shared with any other reader.
- 404, never 403, for anything outside the caller's unit: the response must not confirm it exists.

**Tests.** 6 cases in `route` (from `cadastro.vehicle-sync.route.test.ts`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
