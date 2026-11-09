# modules

One folder per module, named as in `ownership.json`. Each has:

- `index.ts` — exports `httpPlugin(app)` and/or `jobs(register)`. The only file
  the composition roots import.
- `contracts/` — the public surface: every function another module may call and
  every event schema this module publishes. Importable by any module.
  `contracts/http.ts` (with its `http.<topic>.ts` files) is the web contract:
  `@select-lub/core/contracts` re-exports it and `packages/shared-types` hands it to
  `apps/web`, so it may import only `zod`, other modules' `contracts/http.ts` and
  `shared/web/` (5.1d; lint-enforced, and walked by `test/web-contracts.test.ts`).
- `internal/` — shared by this module's own slices, importable by nobody else.
- one folder per slice, named as a verb (`lookup-plate`, `drain-outbox`),
  entered only through its `index.ts`, with its tests in `tests/`.

**How a slice gets what it needs.**

- The database: `request.server.db`, bound by the composition root
  (`kernel.bindDb`). Never import a Prisma client into a slice.
- The caller: `kernel.unitIdOf(request)` and the `request.crm*` fields.
- Any port — a kernel client such as the plate provider, or one only this
  module uses, such as an LLM extractor or a count another module still computes
  in `apps/api`: `index.ts` exports `createHttpPlugin(ports)` returning the
  `HttpPlugin`. The composition root passes what `BuildAppOptions` already
  resolves (production adapters, or the test's fakes), so the tests' injection
  path does not change. The ports live in a closure per app, never in a
  module-level variable. The kernel clients' `bind*` binders are bound nowhere
  yet; use their types, not their globals, from an HTTP slice.
- Put the logic in a plain function taking `(db, input, ports?)` where it helps:
  a test calls it directly, and `app.inject` covers the HTTP behaviour.

**Where a slice's tests go.** In the slice's `tests/`, including the HTTP cases:
`buildSliceApp({ db, plugin, caller })` from `@select-lub/core/testing` builds
the kernel app with the handle bound, the plugin registered and the caller
written onto the request. A slice with ports exports a route factory,
`route(ports)`; its tests mount `route(fakes)` through `registerSlice`, because
the boundary rules keep slice tests out of the module's `index.ts`, and the
module's `createHttpPlugin(ports)` calls the same factory. Only the auth hook's own cases (401, 403, `X-Unit-Id`
resolution) stay in `apps/api`, because the hook still lives there.

ESLint's boundary rules enforce the three scopes; `db.tx('<module>', …)` and the
Postgres role enforce which tables the slices may write. Empty until wave 2.
