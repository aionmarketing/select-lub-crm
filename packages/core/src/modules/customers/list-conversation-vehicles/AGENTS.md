# list-conversation-vehicles

**Purpose.** The vehicles of a conversation's customer, for the rail.

**Kind.** HTTP route, `GET /conversations/:id/vehicles`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `customer` and its field-sync rows, when the resync applies an Omie change.

**Invariants.**
- The customer is the conversation's linked one in the caller's unit, else the unit's customer with the conversation's phone (`internal/conversation-customer`, reading the conversation through the conversations contract `getCadastroLink`).
- A customer linked to Omie is refreshed from Omie first (`internal/resync-from-erp`, the dispatch's resync-vehicle-from-erp); the Omie read is outside any transaction and a failure keeps the stored customer.

- Each vehicle whose identity's oil research is attended and not stopped carries `oilResearch: { status: "researching" }`, read through the quotes contract `readActiveOilResearch` (background-oil-research D18) under the `customers` role — `oil_research` and `oil_research_runner` are `readableBy: "*"`. A read only: no write, no research started, no provider. A failure to read lists the vehicles without the field.

**Tests.** 5 cases in `vehicles` (from `cadastro.vehicles.test.ts`); 4 in `oil-research` (the flag). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
