# list-tags

**Purpose.** `GET /tags` — the loja's tag definitions, for the admin screen, sorted by `sortOrder` then name.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): none (reads `tag`).

**Invariants.**

- Another loja's tags are never listed.
- No unit resolved answers an empty list, as before.
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
