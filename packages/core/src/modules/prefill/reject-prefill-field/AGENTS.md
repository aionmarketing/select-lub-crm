# prefill / reject-prefill-field

**Purpose.** `POST /conversations/:id/prefill/reject`: drop one suggested field
without writing cadastro.

**Kind.** HTTP command. Entry point: `route`.

**Tables written.** `cadastro_prefill_suggestion`.

**Invariants.**

- The membership check, the strip and the view share one `db.tx("prefill")`
  (they were separate calls).
- A field that is not pending leaves the suggestion unchanged and answers 200.
- 404 for an unknown or another loja's conversation.

**Tests.** `tests/reject-prefill-field.integration.test.ts`, 2 cases moved from
`apps/api/src/cadastro.prefill.test.ts`.

**Blocked on core.** Nothing.
