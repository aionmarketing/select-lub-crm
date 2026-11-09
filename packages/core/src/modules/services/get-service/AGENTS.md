# services / get-service

**Purpose.** `GET /services/:id`: one service in full for the Serviços detail region —
its items, customer and vehicle labels, the quote Relatórios attributed it to, and
the vehicle's other services, newest first.

**Kind.** HTTP query. Entry points: `getService(db, unitId, serviceId)` and `route`.

**Tables written.** None. Reads `service`, `service_item`, `customer`, `vehicle`,
`service_quote_attribution` (reports') and `oil_quote` (quotes'), all foreign ones
`readableBy`, in one `db.tx("services", …)`.

**Invariants.**

- A service in another loja is a 404, the same as an unknown one.
- The attribution is READ, never recomputed: Relatórios owns the 30-day rule, and a
  second implementation here would disagree with the funnel the day the window moves.

**Tests.** `tests/get-service.integration.test.ts`, 3 cases, NEW in 3C: no test in
`apps/api` exercised this route (only the web page's mocked tests and the quarantined
Serviços tour reached it), and the move changed how it reads.

**Open question, not decided here.** `vehicleHistory` is the car's other services with
no loja filter, so a car serviced in two lojas shows the other loja's services in its
history. Unchanged by the move and not pinned by the tests either way.
