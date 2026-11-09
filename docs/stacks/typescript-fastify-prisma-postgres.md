# Stack bindings — TypeScript, Fastify, Prisma, Postgres

How the general rules in [`../architecture/`](../architecture/README.md) bind to
this repository.

## Packages

`packages/core` holds the kernel, the shared kernel and the modules. Modules
span both processes — `conversations` has a worker job and API routes — so they
must live in a package both apps import. `apps/api` and `apps/worker` are
composition roots: they bind ports, register each module's `httpPlugin` or
`jobs`, and contain no handlers. They remain separate Fly deploys.

`packages/shared-types` stays, as the browser-facing barrel re-exporting module
contracts, so `apps/web` does not move.

## Routes

Fastify 5 with `fastify-type-provider-zod` and zod 4. The route schema **is** the
module's public HTTP contract:

```ts
export const route = {
  method: "POST",
  path: "/plate-lookups",
  schema: { body: lookupPlateBody, response: { 200: lookupPlateResponse } },
  handler,
} satisfies SliceRoute<...>;
```

The type provider parses at the entry, which is REPR as this framework spells
it — slices do not hand-call `.parse` in the handler. The zod schema is defined
in the slice and re-exported from the module's `contracts/http.ts`;
`shared-types` re-exports from there for the web. Defining schemas in
`shared-types` instead would invert the dependency: a module would depend on the
web's package.

**Bodies use `z.strictObject`.** Zod 4 objects strip unknown keys by default, so
a client sending a field nobody declared gets silence. `strictObject` makes it a
400. Watch for this when moving a route: a key the web already sends must be
declared, and each stream records any it had to add.

## Database

Prisma 6.19 with a **multi-file schema**: `packages/core/prisma/schema/`, one
`<module>.prisma` per module plus `schema.prisma` for the datasource and
generator. `schema-ownership.test.ts` keeps each file in agreement with the
manifest.

Two consequences of the folder schema, both easy to get wrong:

- Every CLI call needs `--schema prisma/schema`.
- **The migrations directory must be stated.** With a schema folder Prisma looks
  for migrations *inside* it, so `migrate deploy` found none in
  `prisma/migrations` and reported "No pending migrations to apply" against an
  empty database. `packages/core/prisma.config.ts` sets `migrations.path`, which
  also replaces the deprecated `package.json#prisma` block.

Slices never touch `PrismaClient` directly. They call `db.tx("<module>", …)`,
which is also what applies the module's role.

## Tests

Vitest, one project per package. Database-touching tests use the rollback
harness at `@select-lub/core/testing`: a real database, a transaction per test,
rolled back whatever the outcome, per-worktree database, gated by
`DATABASE_URL_TEST`. There is no in-memory store and none is to be added —
`no-memory-store.test.ts` fails if a `memory.ts` appears under any package's
source tree.

A slice's test goes through the slice's `index.ts`, under the module's role.

## Linting

`eslint-plugin-boundaries` enforces the scopes, scoped to `packages/core/src/**`
until wave 5 widens it. One trap worth stating: the plugin resolves specifiers
through `eslint-module-utils`, whose default resolver cannot follow this repo's
NodeNext imports — every internal import is written `./thing.js` while the file
is `thing.ts`. Without `eslint-import-resolver-typescript` configured under
`settings["import/resolver"]`, every dependency looks external and **every rule
silently passes**. Element patterns also match folders, not files: a pattern
ending in `index.ts` classifies nothing.
