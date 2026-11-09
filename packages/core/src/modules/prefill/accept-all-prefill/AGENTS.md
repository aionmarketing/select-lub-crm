# prefill / accept-all-prefill

**Purpose.** `POST /conversations/:id/prefill/accept-all`: accept every pending
field in the closed v1 order, as if Aceitar were clicked top to bottom.

**Kind.** HTTP command over ports. Entry point: `createRoute({ omieAdapter })`.

**Tables written.** `cadastro_prefill_suggestion`. Everything else as in
`accept-prefill-field`, through the same `internal/accept-field.ts`.

**Invariants.**

- Each field is its own accept: the Omie push outside any prefill transaction,
  then the strip. The first refusal stops the walk and leaves the later fields
  pending; the earlier ones stay written.
- The customer is resolved (or created) once, before the walk.
- No pending field is a no-op 200 with the current view.

**Tests.** `tests/accept-all-prefill.integration.test.ts`, 7 cases moved from
`apps/api/src/cadastro.prefill.test.ts`.

**Blocked on core.** Nothing.
