# worker (`@select-lub/worker`)

Long-running process: Evolution webhook HTTP plus timer loops. Exactly one machine (no `SKIP LOCKED` yet).

- **src/** — the composition root (`index.ts`, `worker.ts`): the webhook app and every loop, from `@select-lub/core`
- **test/** — the webhook app and loop suites
- **dist/** — compiled output; do not edit

History REST backfill (`WORKER_HISTORY_BACKFILL=1`) is opt-in and stays unset in
demo. If any message has origin `SEED`, the job does not run — including
`backfill:once`.

## Tests

Suites that touch a store run against the real Prisma adapters on the
worktree's Postgres, inside a per-test transaction that rolls back
(`@select-lub/core/testing`; see `apps/api/test/README.md` for the harness, the
gate and the hazards). Docker's Postgres must be up; without a database
configured the suites skip and say so, and a non-loopback host fails naming
the host. Set up a worktree once with `pnpm db:worktree-env`
then `pnpm db:migrate`. Evolution and Omie are ports and stay
stubbed; there is no in-memory store.

`ingest.live.test.ts` and core's `conversations-status.live.test.ts` predate the harness and
resolve their connection by `EVOLUTION_INSTANCE_NAME`, so they need the demo
seed; a root `pnpm test` seeds, a package-scoped `pnpm --filter` run does not.
They also run in their own `--no-file-parallelism` pass, which is why the
`test` script has two commands; see `apps/api/test/README.md` for why.

**The backfill suite needs a database with no seed-origin messages.** The
worker skips its history backfill when any message has origin `SEED`, an
unscoped count that production really does perform, so the test that exercises
the backfill asserts a count of zero as a precondition rather than depending on
it silently. The demo seed leaves that count at zero, but the demo-seed and scrub live
suites (`packages/core/src/kernel/prisma`) commit seed-origin rows, so running those first on the same database
makes this test fail with a count it did not create. That is the environment,
not the test: rebuild the database (`dropdb`, `createdb`, `db:migrate`,
`db:seed`) and run again. Under the root script the order saves you, because
the worker's own suites run before any live file.
