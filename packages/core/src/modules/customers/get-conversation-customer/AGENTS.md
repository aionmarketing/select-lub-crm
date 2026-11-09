# get-conversation-customer

**Purpose.** A conversation's customer and its open pendings, for the rail's Contato card.

**Kind.** HTTP route, `GET /conversations/:id/customer`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `customer` and its field-sync rows, when the resync applies an Omie change.

**Invariants.**
- Same resolution and resync as `list-conversation-vehicles`. Its `index.ts` also exposes `resolveCadastroCustomer` and `refreshLinkedCustomer` for this slice's tests (ruling 4).

**Tests.** 23 cases: `route` (5, from `cadastro.test.ts`), `link` (8, `resolveCadastroCustomer` and `refreshLinkedCustomer`, from `apps/api/src/http/cadastro-link.test.ts`) and `from-snapshot` (10, `ingestOmieSnapshot` and the store's `upsertByOmieId`, from `apps/api/src/cadastro/omie/from-snapshot.test.ts` — the written oracle for the union `upsertByOmieId`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
