# kernel/prisma

The Prisma client and the database tooling around it, exported as
`@select-lub/core/db`. Absorbed from `packages/db/src` in wave 5.1c; the schema,
migrations and seed are `packages/core/prisma/`, the fixtures `packages/core/fixtures/`.
A slice reaches the database through `db.tx` (`kernel/db.ts`), never through
`prisma` directly.

- **index.ts** — the barrel behind `@select-lub/core/db`
- **client.ts** — the `prisma` singleton; `null` when `DATABASE_URL` is unset
- **transaction.ts** — `DbClient`, `RunInTransaction`, `runInTransactionFor`, `TRANSACTION_OPTIONS`
- **database-target.ts** / **live-test-gate.ts** / **seed-permission.ts** — the one
  definition of a loopback host, and the guards built on it: live tests fail on a
  remote host, `db:seed` and `db:scrub-live` refuse one
- **migrate-deploy.ts** — `db:migrate`: `prisma migrate deploy`, then `db/grants.generated.sql`
- **live-seed-once.ts** — the root vitest `globalSetup`: migrate and seed once per run
- **worktree-env.ts** / **worktree-env-plan.ts** / **worktree-database.ts** — `db:worktree-env`
- **ping.ts** — `db:ping`, a `SELECT 1`
- **catalog-seed.ts** / **plan-whatsapp-connection-seed.ts** — pieces of `db:seed`
- **scrub-live.ts** — `db:scrub-live`: delete live ingest, keep `SEED` threads
- **oil-source-blocklist.ts** / **oil-source-fixtures.ts** / **source-tier.ts** /
  **tecfil-capture-fixtures.ts** — the oil-quote fixtures and tiers the seed and
  the API both read
