# update-customer

**Purpose.** Edit a customer's fields from the rail or the customer card.

**Kind.** HTTP route, `PATCH /customers/:id`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `customer`, `customer_phone`, `customer_email`, `customer_field_sync`, `customer_reconciliation_pending`.

**Invariants.**
- The edit goes through the cadastro engine's `applyCrmEdit` (`contracts/cadastro-engine`): a shared field on a customer linked to Omie is pushed to Omie SYNCHRONOUSLY through the adapter `createHttpPlugin` was given, outside any transaction (4B ruling Q1a; never the process-wide ERP port, W2-C6). Omie unreachable → 503 with the saved customer; a two-sided change → an open pending, no push.
- Publishes `customers/customer-changed` after the CRM save, on 200 and on 503. No subscriber yet.
- 404, never 403, for anything outside the caller's unit: the response must not confirm it exists.

**Tests.** 56 cases in `tests/`: the engine's `applyCrmEdit` / ingest / pending / vehicle-column cases (27, `update-customer.engine*`, from `apps/api/src/cadastro/omie/engine.test.ts`), `field-sync` (11, from `field-sync-hardening.test.ts`), `omie-http` (1, from `apply-http.test.ts`), `prefill-persist` (9, `persistPrefillAccept`, from `prefill-persist.test.ts`), `route` (7, from `cadastro.test.ts`) and `vehicles` (1, from `cadastro.vehicles.test.ts`). The engine suites drive the cadastro engine (`contracts/cadastro-engine`) on the real cadastro store. Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
