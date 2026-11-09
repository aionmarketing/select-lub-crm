# testing

The rollback harness, moved here from `packages/db/src/testing` in wave 1.

It moved because a slice's test runs under its module's Postgres role, and
`db.tx` — the thing that sets the role — is kernel code in this package. Leaving
the harness in `packages/db` would have made `db` depend on `core`, and `core`
already depends on `db`; TypeScript project references reject the cycle.

Nothing about the harness itself changed. `describeWithDatabase`,
`withTestTransaction`, `runInTransactionOnTx` and the seeds behave exactly as
before; the 73 files that imported `@select-lub/db/testing` now import
`@select-lub/core/testing` and assert the same things.

Beside the seeds, three fixture files that more than one slice or app uses:

- **evolution-payloads.ts** — Evolution webhook envelopes and `findMessages` rows (moved from
  `apps/worker/src/ingest/` in 4A)
- **multipart.ts** — a hand-built `multipart/form-data` body for the media send route
- **follow-up-scenario.ts** — the Follow-up queue as real rows, for the follow-up slices and
  `apps/api/test/follow-up.integration.test.ts`

Seeds run as the login role, not a module role — `db.tx` resets the role in a
`finally` precisely so a test can seed and assert on tables the slice's module
does not own. See design.md D2.
