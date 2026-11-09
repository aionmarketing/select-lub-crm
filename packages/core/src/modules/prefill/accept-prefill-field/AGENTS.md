# prefill / accept-prefill-field

**Purpose.** `POST /conversations/:id/prefill/accept`: accept one suggested
field — write it to the thread's customer, creating a WhatsApp cadastro and
linking it when there is none — and drop it from the suggestion.

**Kind.** HTTP command over ports. Entry point: `createRoute({ omieAdapter })`.

**Tables written.** `cadastro_prefill_suggestion` (the field stripped). The
customer, its phone and its titular vehicle through `customers`'
`createCadastroStore` and `applyPrefillSuggestion`; the thread link through
`conversations`' `setCustomer`.

**Invariants.**

- `applyPrefillSuggestion` pushes to Omie synchronously — a provider call — so
  it runs with NO prefill transaction open; the strip is its own
  `db.tx("prefill")` afterwards (`internal/accept-field.ts`).
- 409 when the field is not on the suggestion, and nothing is written. 404 for
  an unknown or another loja's conversation, and when the contract answers
  `not_found` (e.g. a year with no vehicle).
- An unavailable Omie still counts as accepted: the field was written locally.

**Tests.** `tests/accept-prefill-field.integration.test.ts`, 6 cases moved from
`apps/api/src/cadastro.prefill.test.ts`. Its first-accept case reads back
through `GET /conversations/:id/vehicles` and is in
`apps/api/test/prefill.integration.test.ts`.

**Blocked on core.** Nothing.
