# services / list-customer-services

**Purpose.** `GET /customers/:id/services`: a customer's service orders, newest first,
undated last, for the cadastro rail.

**Kind.** HTTP query. Entry points: `listCustomerServices(db, unitId, customerId)` and
`route`.

**Tables written.** None. Reads `customer` (customers', `readableBy`) for its loja, then
`service` and `service_item` — one `db.tx("services", …)` each, as the route's two
store calls were.

**Invariants.**

- Read-only: no route creates or edits a service (the ERP import is the only writer,
  W3-C8). `apps/api/test/services.integration.test.ts` holds that at the app level.
- A customer in another loja, in no loja (`unitId` NULL), or unknown is a 404.

**Tests.** `tests/list-customer-services.integration.test.ts`, 4 cases from
`apps/api/src/customer-services.test.ts`; `tests/list-customer-services.live.test.ts`,
1 case from `apps/api/src/customer-services.live.test.ts`. Assertions unchanged.
