# db

Generated SQL applied to the database after migrations.

- **grants.generated.sql** — the module roles and their grants, written by
  `pnpm gen:grants` from `ownership.json`. Not edited by hand;
  `packages/core/test/grants.test.ts` fails when it is stale.
  `pnpm db:migrate` applies it after
  `prisma migrate deploy`, on every run.
