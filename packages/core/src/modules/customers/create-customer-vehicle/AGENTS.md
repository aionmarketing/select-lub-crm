# create-customer-vehicle

**Purpose.** Create a vehicle for a customer.

**Kind.** HTTP route, `POST /customers/:id/vehicles`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `vehicle`, `vehicle_field_sync` (plate-origin marks).

**Invariants.**
- Records `PLACA` for each identity key the body lists in `plateSourcedKeys`, `CRM` for the others it sets; keys it omits are left alone. The two writers of `vehicle_field_sync` keep their own `origin` vocabularies.
- Publishes `customers/vehicle-changed` (`created: true`) after the write.
- 404, never 403, for anything outside the caller's unit: the response must not confirm it exists.

**Tests.** 4 cases: `vehicles` (1) and `origin` (2) from `cadastro.vehicles.test.ts` and `cadastro.vehicles-origin.test.ts`, and `new-vehicle` (1, `vehicleFromCreate`, from `apps/api/src/http/cadastro-link.test.ts`). Its `index.ts` also exposes `vehicleFromCreate` for that case (ruling 4). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
