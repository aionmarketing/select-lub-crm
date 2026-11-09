# prefill / get-prefill

**Purpose.** `GET /conversations/:id/prefill`: the rail's view of the assistive
cadastro suggestion — `extracting`, `pending` with its fields, `failed` or
`empty` — with the Sugerir dados do cliente switch.

**Kind.** HTTP query. Entry point: `route`.

**Tables written.** None.

**Invariants.**

- The conversation is scoped to the caller's loja through `conversations`'
  `getCadastroLink`; another loja's is a 404, the same as an unknown one.
- A job in flight wins over pending keys (`extracting`); an empty `{}`
  suggestion is `empty`, not `pending`; `failed` only when no keys remain.

**Tests.** `tests/get-prefill.integration.test.ts`, 8 cases moved from
`apps/api/src/cadastro.prefill.test.ts`.

**Blocked on core.** Nothing.
