# list-tag-apply-options

**Purpose.** `GET /tags/apply-options` — the active tags the apply-tag picker offers.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): none (reads `tag`).

**Invariants.**

- Only `active` tags; an inactive tag's open chips stay on their threads.
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
