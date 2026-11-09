# API tests and the database

Every suite that exercises a store runs against the **real Prisma adapter on
the worktree's Postgres**, inside a transaction that is rolled back when the
test ends. There is no in-memory store to fall back to: `buildApp` takes one
database client and builds every store from it, and the API refuses to start
without `DATABASE_URL`.

The harness lives in `packages/core/src/testing/` and is imported as
`@select-lub/core/testing`:

```ts
describeWithDatabase("conversations routes", () => {
  it("lists the unit's conversations", () =>
    withTestTransaction(prisma!, async (tx) => {
      const unit = await seedUnit(tx);
      const user = await seedUser(tx, { units: [unit.id] });
      const app = await buildApp({ db: tx, runInTransaction: runInTransactionOnTx(tx), getUser });
      // ...
    }));
});
```

Rows written inside the transaction are invisible to other connections and
gone when it ends, so files run in parallel with no cleanup step and no
seeding order. Everything a test reads, it creates inside its transaction;
never assert on demo-seed rows (see "Which command seeds" below).

## Environment

| Env var | Purpose |
| --- | --- |
| `DATABASE_URL` | Dev server and worker. |
| `DATABASE_URL_TEST` | Preferred by the harness when set. Falls back to `DATABASE_URL`. |

Each git worktree gets its own database from
`pnpm db:worktree-env`, which writes the `.env` for
that worktree; run it once after creating a worktree, then `db:migrate`.

## Gating

The gate is the one every writing suite in the repository uses
(`shouldRunLiveTests`):

- no `DATABASE_URL` and no `DATABASE_URL_TEST`: the suites **skip** and say so;
- a **loopback** host (Docker's Postgres): the suites run;
- a **non-loopback** host: the suites **fail**, naming the host, because the
  most likely misconfiguration is the repository's own `.env` pointing at a
  hosted database. `LIVE_TESTS_ALLOW_REMOTE=1` overrides for a disposable
  remote database.

A laptop without Docker skips rather than fails. CI provisions `postgres:16`
and runs everything.

## Which command seeds

The demo seed's presence depends on **how vitest is invoked**, not on the
environment:

- `pnpm test` / `pnpm test:coverage` at the repo root (what CI runs) goes
  through the root `vitest.config.ts`, whose `globalSetup`
  (`packages/core/src/kernel/prisma/live-seed-once.ts`) migrates and seeds once, best-effort.
- `pnpm --filter @select-lub/api test` uses this package's config, skips that
  `globalSetup`, and sees whatever the worktree database holds; a freshly
  migrated one is empty.

Tests that create every row they read pass under both. To prove a suite does,
create a scratch database, migrate it, confirm it is empty, run the suite
against it, confirm it is still empty afterwards, drop it.

## Hazards the harness cannot hide

- **A constraint violation aborts the transaction.** Prisma's interactive
  transaction has no savepoint, so a test that asserts a rejected write cannot
  run any statement afterwards; the next one fails on the abort, with a
  misleading error. Give such an assertion a test of its own, last in it.
- **The clock is Postgres's.** `vi.setSystemTime` does not move `NOW()`, and
  `@updatedAt` columns cannot be aged through Prisma; seed rows at offsets from
  the real clock, or use raw SQL to backdate.
- **The channel probe is live.** `buildApp`'s default `channelConnected` calls
  the configured Evolution instance. A test on a channel-state path builds the
  store explicitly with the probe it wants and passes it through the `stores`
  override.
- **Never write demo-seeded rows.** Updating or deleting a seeded row from
  inside a test transaction deadlocks against sibling files (`25P02` from an
  unrelated line). Create your own rows with generated ids and instance names.

## Live suites

The `*.live.test.ts` files predate the harness and run outside it, with
hand-written cleanup in `afterAll`. They are gated the same way, and they
**run in their own pass with file parallelism off**, which is why this
package's `test` script has two commands rather than one.

That mirrors what the repository's root `test` script does, and for the same
measured reason: two live files mutating the same demo rows while both run is
a race the root config's comment documents. A plain `vitest run` here would
reintroduce it, so a package-scoped gate would differ from CI in the one way
that matters. CI runs the root script, so it already has this guarantee.

**A dropped connection is not this race.** On Windows with Docker Desktop,
concurrent load can make the loopback forwarder drop a connection, and Prisma
reports it as `Can't reach database server at 127.0.0.1:5433` while the
container is healthy and `psql` connects. Measured on 2026-09-19: four API
suites running at once against separate databases, one of them failing inside
a route's `findMany` with that error, nothing at all in the Postgres log
because the connection never arrived. It surfaces through HTTP as a 500.

Both tiers ride over it now (`packages/core/src/testing/connect-retry.ts`). The
harness retries opening its transaction; the live suites wrap the shared client
with `withConnectRetry`, so the retry is in the client the test and the route
handler both use. That matters, because the drop that failed them happened
inside a route, where a test has nothing to wrap.

Only a dropped connection is replayed, never a statement the server answered,
so a write that landed is not repeated. Every retry prints a line: a retry that
papers over a drop in silence leaves you unable to tell "the retry saved us"
from "it never fired". Measured on 2026-09-19 across eight serialized live
passes: three of them hit a drop, four retries in total, and all eight passed.
Before the wrapping, roughly one pass in three failed.

It remains a local environment artifact and has never occurred on CI, whose
Linux runner reaches its Postgres service without a forwarder. Do not cap
worker counts or change production code because of it. If you see the retry
line often, check that Docker Desktop is healthy.
