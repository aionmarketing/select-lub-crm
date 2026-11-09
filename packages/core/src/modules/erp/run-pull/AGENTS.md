# run-pull

**Purpose.** Pull the ERP into the CRM: clients first (full, or incremental from the last
completed run's watermark), then, on the mock only, service orders, catalog products,
vehicle ids and duplicate candidates; then reconcile vehicle returns.

**Kind.** Worker entry point, not a registered job. `runPull(db, mode, env, source?, matchScope?, log?)`
is what `apps/worker/src/index.ts` passes to `startWorker`'s `runOmiePull` option, as
`runPull(db, mode, process.env, undefined, undefined, log)` — so no `matchScope`, and
matching is database-wide; `log` is the worker's own, which receives the match pass's
`omie_match_no_key customer=<id>` lines — which keeps
its `WORKER_OMIE_PULL` (one full pull at start) and `WORKER_OMIE_POLL` /
`WORKER_OMIE_POLL_MS` (incremental timer) flags. `runOmiePull(input)` is the same pull over
injected stores; the tests drive it.

Access comes from the environment, as before: credentials → HTTP, `OMIE_MOCK=1` → the
in-process mock, neither → no-op. No test sets credentials, so none reaches a real Omie
tenant. One mock-mode case passes no source, so the path production takes (the pull
builds the mock from `env`) stays covered; it renames the catalog in the import store.

**Files.** `index.ts` is the entry point. `pull.ts` (`pullOmieClients`, `matchUnlinkedCustomers`)
and `import-surfaces.ts` (`importMockSurfaces`) came from `@select-lub/omie` in 5.1b with
their bodies unchanged; the pull reaches the cadastro engine's `ingestOmieSnapshot` through
`customers/contracts/cadastro-engine`, and its stores' types through
`customers/contracts/cadastro-store/port.ts` and `erp/contracts/{sync-run-store,import-surfaces-store}.ts`.

**Tables written**, each through the contract of the module that owns it, one `db.tx` per
store call:

| Store | Contract | Role | Tables |
|---|---|---|---|
| cadastro | `customers/contracts/import-from-erp` | `customers` | `customer`, `vehicle`, both `*_field_sync`, both `*_reconciliation_pending` |
| service orders | `services/contracts/import-from-erp` | `services` | `service`, `service_item` |
| catalog | `quotes/contracts/upsert-catalog-product` | `quotes` | `catalog_*` |
| runs, errors | `erp/contracts/record-sync-run` | `erp` | `sync_execution`, `integration_error` |
| reconcile | `services/contracts/reconcile-vehicle-returns` | `services`; reminder stops nested under `scheduling` | `vehicle_return`, `scheduled_message` |

**Invariants.**
- `sync_execution` and `integration_error` are written only under `module_erp`.
- Every other write runs under its owner's role, the reconcile's included: `vehicle_return`
  under `services`, and its reminder stops through `scheduling`'s contract, nested in the
  same per-vehicle transaction (W3-C3, resolved in 3C).
- No transaction spans an ERP call (W2-C12): each store call is its own `db.tx`.
- The catalog stays pull-driven, and `quotes/import-catalog-from-erp` stays unregistered
  (W2-C10), so the catalog is imported once per pull.
- There is no `list-sync-executions` slice: the only read of `sync_execution` is this
  pull's own watermark (`latestCompleted`), part of the recorder port, and nothing lists
  runs over the API.

**Tests** (`tests/`, 49 cases, all on the real database under the roles above):
`run-pull` 7, `run-pull.clients` 10, `run-pull.fake-sync` 10, `run-pull.surfaces` 9 +
`run-pull.surfaces-items` 4 + `run-pull.surfaces-reimport` 5, moved from `apps/worker/src/omie/` (`run-pull`, `pull`,
`fake-sync`, `import-surfaces`); plus `run-pull.roles` 4, which records which module each
write ran under and proves the erp tables refuse every other role. Every mock source's
catalog products carry ids unique to its test, so these files cannot deadlock with the
quotes suites that seed the same catalog ids.

**Matching is scoped in tests, database-wide in production.** Every pull runs
`matchUnlinkedCustomers`, which updates each candidate it links or pushes and holds those
rows until the test rolls back. Database-wide, every pull-running test locked every unlinked
demo customer and the files queued behind one another, which an advisory lock and a 180 s
timeout used to make orderly. Since the cleanup after wave 5 each test passes a
`MatchCandidateScope` of its own customers (or none) through `runPull` / `runOmiePull` /
`pullOmieClients`; the worker passes none, so production still matches every unlinked
customer, pinned by the "keeps production's matching database-wide" case. The advisory lock
is gone: alone, the nine files ran 18–19 s instead of 48 s, 55/55.

The five files that import the mock surfaces (`run-pull.integration`, `surfaces`,
`surfaces-items`, `surfaces-reimport`, `roles`) used to write the mock dataset's own
identifiers, which the demo seed writes too, so they waited on each other's rows and kept a
180 s `SURFACE_TEST_TIMEOUT_MS`. Each test now imports under ids of its own
(`tests/scoped-mock.ts`, over `createMockOmie(env, { idPrefix })`), and the timeout is gone.
Alone, the nine files went from 18.4 / 18.6 s to 4.2 / 4.15 s (alternating runs, 57/57);
each surface file from 6–17 s to 1–1.6 s. The one case that drives the production path
(`runOmiePull` with no `source`) still imports the dataset's own ids, by design.
`tests/run-pull.match-scope.integration.test.ts` drives `runPull` → `runOmiePull` → the
match pass with a scope.

**Blocked on core.** The pull still selects its ERP from the environment
(`resolveOmieAccess`, `createMockOmie`, `createHttpOmieAdapter`) rather than through the
kernel's `ErpPort`, which carries only `get`/`put`; listing clients, service orders and
products through the port is still open: 5.1b moved the Omie client into the kernel
(`kernel/clients/erp-mock`) without changing that.
