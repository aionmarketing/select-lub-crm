# create-tag

**Purpose.** `POST /tags` — a new tag definition in the loja.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): `tag`.

**Invariants.**

- A name taken by an ACTIVE tag in the loja answers 409 (the partial unique index); a deactivated tag frees its name.
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
