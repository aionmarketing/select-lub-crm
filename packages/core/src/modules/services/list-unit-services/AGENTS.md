# services / list-unit-services

**Purpose.** `GET /services`: the unit's Serviços ledger — filtered by São Paulo
period, the search box (customer name, plate, Omie id) and the return-state filter,
ordered newest first with undated services last, and paged by cursor.

**Kind.** HTTP query. Entry points: `listUnitServices(db, unitId, query)` and `route`.

**Tables written.** None. Reads `service` and `service_item`, joined with `customer`
and `vehicle` (customers', `readableBy`), and — only when the return-state filter is
asked for — `vehicle_return`, in one `db.tx("services", …)`, as the old store call was
one operation.

**Invariants.**

- The period is bounded coarsely in SQL and exactly in memory (`internal/unit-listing.ts`),
  so a São Paulo calendar day is never clipped by a UTC comparison.
- The return-state filter classifies the STORED return date through
  `contracts/return-state.ts`, the same function Follow-up's sections use. It matches a
  service only when that service is the one its vehicle's OPEN or ARCHIVED return was
  dated from; SUPERSEDED never matches.
- Totals are taken over the whole match, before the cursor cut.

**Tests.** `tests/list-unit-services.integration.test.ts` (1 case from
`apps/api/src/services-listing.route.test.ts`); `tests/unit-listing-filters` and
`tests/unit-listing-search.integration.test.ts` (9 + 10 cases from
`apps/api/src/services/unit-listing.test.ts`, over `tests/unit-ledger.fixture.ts`).
Assertions unchanged.
