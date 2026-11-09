# create-conversation-vehicle

**Purpose.** Create a vehicle for a conversation's customer.

**Kind.** HTTP route, `POST /conversations/:id/vehicles`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `vehicle`, `vehicle_field_sync` (plate-origin marks).

**Invariants.**
- 409 when the conversation has no customer yet (neither linked nor found by phone): the rail saves the customer first.
- Plate-origin marks and `customers/vehicle-changed` as `create-customer-vehicle`.

**Tests.** 2 cases in `vehicles` (from `cadastro.vehicles.test.ts`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
