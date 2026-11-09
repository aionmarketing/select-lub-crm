# list-templates

**Purpose.** `GET /templates` — the loja's reply templates, by name.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): none (reads `template`).

**Invariants.**

- Another loja's templates are never listed.
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
