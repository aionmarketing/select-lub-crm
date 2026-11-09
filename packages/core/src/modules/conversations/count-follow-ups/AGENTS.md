# count-follow-ups

**Purpose.** `GET /follow-up-counts` — the four Follow-up counts without the rows, for the navigation badge and the Relatórios alert strip.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (under `db.tx("conversations", …)`): None (the same reads as list-follow-ups).

**Invariants.**

- Derived from the SAME aggregation as the lists, so the badge cannot claim a number the screen does not show.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/count-follow-ups.integration.test.ts` (1, new). The comparison with `GET /follow-ups` is in `apps/api/test/follow-up.integration.test.ts`.

**Blocked on core.** Nothing.
