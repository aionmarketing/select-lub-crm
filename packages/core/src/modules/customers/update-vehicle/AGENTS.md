# update-vehicle

**Purpose.** Edit a vehicle's fields.

**Kind.** HTTP route, `PATCH /vehicles/:id`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `vehicle`, `customer` (titular shared fields), both `*_field_sync`, both `*_reconciliation_pending`.

**Invariants.**
- Through `applyVehicleFieldEdit`: a shared field of the TITULAR vehicle goes through the customer's Omie sync, synchronously (503 with the saved vehicle when unreachable); another vehicle's fields are local.
- Then the plate-origin writes, as on create. Publishes `customers/vehicle-changed` (`created: false`).
- A vehicle has no unit of its own; it inherits its titular customer's.

**Tests.** 21 cases: `vehicles` (6) and `vehicles-dual-change` (2, the #102 3.2 dual-change guard) from `cadastro.vehicles.test.ts` and `cadastro.vehicle-sync.route.test.ts`, `origin` (2) from `cadastro.vehicles-origin.test.ts`, `n-vehicles` (7) from `apps/api/src/cadastro/omie/n-vehicles.test.ts`, and `origin-store` (4, both writers of `vehicle_field_sync`) from `apps/api/src/cadastro/origin.test.ts`. Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
