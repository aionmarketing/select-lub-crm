# @select-lub/core

The kernel, the shared kernel, and the modules.

- **src/kernel/** — everything a slice may assume: `db.tx` (which puts the
  module's Postgres role on the transaction), HTTP and job registration, events,
  `Result`, the auth hook, logging, config, and every third-party port under
  `clients/`. `kernel/README.md` is the list; nothing outside it is fair game.
- **src/shared/** — the shared kernel: phone canonicalisation, message origin,
  ids. Vocabulary the domain shares, not a `utils` folder.
- **src/modules/** — one folder per module in `ownership.json`, each with
  `contracts/` (public), `internal/` (module-only) and one folder per slice.
  Empty until wave 2.
- **src/kernel/prisma/** — the Prisma client and database tooling (`@select-lub/core/db`):
  the client, `db:migrate` (which applies the module grants), `db:worktree-env`,
  the seed and live-test guards.
- **prisma/** — the multi-file schema (`schema/<module>.prisma`), the migrations and
  the demo seed (`db:seed`, `db:scrub-live`); `prisma.config.ts` points the CLI here.
  `fixtures/` holds the JSON the seed and the oil-quote pipeline read.
- **src/testing/** — the rollback harness. Every database-touching test runs
  inside a transaction that is rolled back, against the real database.
- **test/** — the three structure checks: the generated grants are current, the
  schema and `ownership.json` agree, and a module role actually refuses a
  foreign write.

The package absorbed `packages/{db,omie,motul,tecfil,placas}` over waves 1-5; see
`openspec/changes/adopt-modular-vertical-slices/`.
