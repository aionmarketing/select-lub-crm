# api/src

The api's composition root. Everything it runs is `@select-lub/core`'s: the kernel
(Fastify, the auth hook, `/health`, the SPA) and each module's `httpPlugin`.

- **app.ts** — `buildApp`: binds the database, registers the auth hook and `/health`,
  hands each module its ports and registers its `httpPlugin`, then serves the SPA
- **index.ts** — process entry: loads `.env`, refuses to start without a database, `listen`
- **startup.ts** — that refusal (`assertDatabaseConfigured`)

Tests are in `../test/`, on the worktree's database through the rollback harness.
