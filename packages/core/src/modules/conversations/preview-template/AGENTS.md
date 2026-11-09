# preview-template

**Purpose.** `POST /conversations/:id/templates/:templateId/preview` — renders an active
template of the loja with the thread's `{{nome_cliente}}` and `{{placa}}`.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `createRoute(ports)`.

**Tables written.** None (reads `conversation`, `template`).

**Invariants.**

- Another loja's conversation or template, or an inactive template, answers 404.
- A value the thread lacks leaves its `{{token}}` in place — never an empty gap, an invented
  plate, or the contact's phone.
- The customer values come through the `templateValues` port and are read OUTSIDE any
  `db.tx`; the port is the api's until customers (4B) exposes a contract.

**Tests.** `tests/`; the cases that need a linked customer and vehicle live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
