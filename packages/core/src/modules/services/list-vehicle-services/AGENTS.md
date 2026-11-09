# services / list-vehicle-services

**Purpose.** `GET /vehicles/:id/services`: one vehicle's service orders, newest first.

**Kind.** HTTP query. Entry points: `listVehicleServices(db, unitId, vehicleId)` and
`route`.

**Tables written.** None. Reads `vehicle`, then its customer's loja (`customer`), both
customers' and `readableBy`, then `service` and `service_item` — one
`db.tx("services", …)` each, as the route's three store calls were.

**Invariants.**

- A vehicle's loja is its customer's. Another loja's vehicle, or an unknown one, is a 404.
- Only this vehicle's services — never a sibling car of the same customer.

**Tests.** `tests/list-vehicle-services.integration.test.ts`, 2 cases from
`apps/api/src/services-listing.route.test.ts`, assertions unchanged.
