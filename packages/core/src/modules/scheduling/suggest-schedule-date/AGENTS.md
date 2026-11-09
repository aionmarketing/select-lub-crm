# scheduling / suggest-schedule-date

**Purpose.** `GET /services/:id/suggest-schedule-date`: the date Programar
mensagem pre-fills from a service — the matching interval rule's period after
`performedAt`, or six months.

**Kind.** HTTP query. Entry points: `suggestScheduleDate(tx, unitId, serviceId)`
and `route`.

**Tables written.** None. Reads `service` and `interval_rule` (services',
`readableBy`).

**Invariants.**

- The service must be the caller's loja's (404 otherwise); one with no
  `performedAt` is a 400.
- Every rule is read, unscoped, and `suggestDate` (services' `contracts/http.return-due.ts`)
  picks one; with none matching the source is `six_months`.

**Tests.** `tests/suggest-schedule-date.integration.test.ts`, 2 cases moved from
`apps/api/src/scheduled.route.test.ts`, assertions unchanged.
