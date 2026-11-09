# list-follow-ups

**Purpose.** `GET /follow-ups` — the loja's Follow-up queue: unanswered quotes, overdue and upcoming returns, messages waiting for a reply; with `?closed=1`, the entries closed out of it.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (under `db.tx("conversations", …)`): None (reads `oil_quote`, `vehicle_return`, `scheduled_message`, `conversation`, `message`, `customer`, `follow_up_closed_entry`).

**Invariants.**

- Closed is the exact complement of open, from one predicate (`internal/follow-up-aggregate.ts`).
- Counts equal the listed lengths after the cap.
- A reminder counts as planned only while SCHEDULED and ahead of now.
- A quote's loja is reached through its conversation's connection; another loja's never appears.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/list-follow-ups.integration.test.ts` (8), moved from `apps/api/src/follow-up.route.test.ts`, over `seedFollowUpScenario` in `@select-lub/core/testing`. The aggregation's pure cases are `packages/core/test/conversations-follow-up-{aggregate,returns}.test.ts`.

**Blocked on core.** Nothing.
