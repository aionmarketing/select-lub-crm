# create-template

**Purpose.** `POST /templates` — a new reply template in the loja.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): `template`.

**Invariants.**

- Only the two known variables (`{{nome_cliente}}`, `{{placa}}`) are accepted; the body schema refuses any other with 400.
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
