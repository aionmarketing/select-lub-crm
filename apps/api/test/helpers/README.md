# test/helpers

Shared setup for API integration tests. Not production code.

- **env.ts** — copies `DATABASE_URL_TEST` onto `DATABASE_URL` before Prisma loads
- **reset-db.ts** — `resetTestDatabase()` truncates CRM tables on the test DB, gated on `shouldRunLiveTests()`
- **assert-live-db-ready.ts** — `assertLiveDbReady()` fails loudly (instead of silently skipping) when `shouldRunLiveTests()` says the environment is equipped but `@select-lub/db`'s `prisma` is still null
