# update-tag

**Purpose.** `PATCH /tags/:id` — renames, recolors, reorders or (de)activates a tag.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): `tag`.

**Invariants.**

- Another loja's tag answers 404.
- A rename onto an active tag's name answers 409.
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
