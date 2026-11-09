# kernel

The only API a slice may assume. Anything not listed here is a core change, not
a slice change: record it under your slice's "Blocked on core" heading.

**Database** (`db.ts`)

- `createDb(client, runInTransaction?)` → `Db`; `db.client` for a health check only.
- `db.tx(module, fn, runInTransaction?)` — transaction, `SET LOCAL ROLE module_<name>`,
  `fn`, then the caller's role back (or `RESET ROLE` at top level) in a `finally`. A
  foreign write fails here, not in review. Calls sharing one transaction (the test
  harness, or a contract called inside another module's `db.tx`) run one at a time.
  A nested call reached through a client object the kernel does not recognise (a
  Proxy or recording wrapper) asks the database which role is in effect, so its exit
  still restores the caller's role instead of resetting it.
- **Never await a provider inside `db.tx`** — no HTTP, LLM, Evolution or Omie call.
  In production `db.tx` is `prisma.$transaction` with `TRANSACTION_OPTIONS`: it
  waits up to 10 s for a pooled connection, then may run 5 s, holding that
  connection for the whole wait. The harness allows
  60 s and its fakes answer instantly, so no test shows the mistake. Give each
  store operation its own `db.tx`, and run independent ones in parallel. Group
  statements in one `db.tx` only when they must commit or fail together: one
  transaction runs its statements one after another on one connection.
- `withModuleRole(module, fn, runInTransaction)` — the same without the handle.

**Prisma client** (`prisma/`, exported as `@select-lub/core/db`) — `prisma` (the
singleton; `null` without `DATABASE_URL`), `Prisma`, `PrismaClient`, `DbClient`,
`RunInTransaction`, `shouldRunLiveTests`, the database-target guards and the seed
helpers. Absorbed from `@select-lub/db` in wave 5.1c; a slice reaches the database
through `db.tx`, never through `prisma` directly.
- `ModuleName`, `Owned<M>`, `MODULE_NAMES`, `OWNED`, `roleFor(module)` — generated
  from `ownership.json`; never edit `db.modules.generated.ts`.

**HTTP** (`http.ts`)

- `buildApp({ mediaMaxBytes, corsOrigins, quiet? })` — Fastify with the zod type
  provider attached and no routes on it.
- `registerSlice(app, module, slice, route)` — mounts one slice.
- `SliceRoute` = `{ method, path, schema, handler }`, exported as `route` from a
  slice's `index.ts`. Bodies use `z.strictObject`.
- `HttpPlugin` — a module's `httpPlugin` export. `stripApiPrefix(url)` keeps the
  query string (`/api?q=1` → `/?q=1`).
- `registerApiHealth(app, db)`, `registerWorkerHealth(app)` (`health.ts`) — `GET
  /health` with the commit (and, on the api, `SELECT 1` and the UI variant).
- `resolveSpaRoot(override, candidate)`, `registerSpa(app, dir)` (`spa.ts`) — the
  built SPA, and `index.html` for any GET outside the API prefixes.
- `buildWebhookApp({ db? })`, `WEBHOOK_BODY_LIMIT` (`webhook-app.ts`) — the
  worker's instance: 50 MiB body limit, no CORS or multipart, `/health` on it.

**Request** (`request.ts`)

- `bindDb(app, db)` — the composition root decorates the app once, before any
  plugin registers. A handler reads `request.server.db` and calls
  `request.server.db.tx("<module>", …)`. Per app, not process-global, so each
  test's app carries its own transaction-bound handle.
- `unitIdOf(request)` — the unit the request is scoped to. `request.crmUserId`,
  `crmEmail`, `crmName`, `crmUnitIds` and `crmCurrentUnitId` are declared here;
  `auth/hook.ts` sets them.

**Jobs** (`jobs.ts`)

- `createJobRegistry()` → `{ register, start, registered }`. `start()` → `{ stop }`;
  `stop()` clears every timer at once, aborts the signal every tick was handed, and
  resolves when every tick in flight has settled (never rejects). Await it before tearing down what a tick still uses — subscribers, the
  database client.
- `Job` = `{ name, everyMs, run(signal) }`, one tick at a time. `signal` is aborted by
  `stop()`; a job that can run for minutes releases its claim on it, and settles only
  once that release has committed. A job may ignore it. `RegisterJob` is what a
  module's `jobs(register)` receives.
- For the worker's composition root: `singleFlight(run)` (skip a call while one
  runs), `runOnce(label, log, run)` (a start-up task logged `start` / `done` /
  `failed <message>`), `createStop({ running, log, after, exit })`, `messageOf`.
- `resolveWorkerSettings(options?, env?)` (`worker-settings.ts`) — every loop's
  interval and flag, from the option, else `WORKER_*`, else the default; the oil
  research switch and settings (`OIL_RESEARCH_*`) too.
  `resolveWorkerHost(env?)` (`bind-host.ts`) — `WORKER_HOST` or `127.0.0.1`.

**Events** (`events.ts`)

- `defineEvent(name, schema)` — `name` is `<module>/<event>`.
- `publish(event, payload)` parses then awaits every subscriber;
  `subscribe(event, fn)` → unsubscribe; `capture(event, fn)` → payloads;
  `resetSubscribers()` for tests.

**Result** (`result.ts`) — `ok`, `err`, `isOk`, `isErr`, `Result<T, E>`.

**Auth** (`auth/`, see its README) — the security boundary.

- `registerAuthHook(app, { getUser, authStore })` — 401 without a bearer or with an
  unknown one; loads the CRM profile; resolves `X-Unit-Id` against the memberships,
  403 outside them. `/health` and GETs outside the API prefixes skip it.
- `resolveCurrentUnit(header, memberships)` (`auth/resolve-unit.ts`) — the hook's
  unit rule: the header when it is a membership, else the sole membership, else
  `null`. Accounts' `/auth/me` answers with the same rule by calling it.
- `GetUser`, `AuthUser`, `createSupabaseGetUser()`, `CallerDirectory` (accounts'
  `createCallerDirectory` satisfies it). The fake token table is in `@select-lub/core/testing`.
- Moved from `apps/api` in wave 5.2, unchanged; the earlier `kernel/auth.ts` hook,
  registered nowhere and without the 403, is gone.

**Logging** (`logger.ts`) — `fastifyLoggerOptions`, `fastifyLoggerRedactPaths`,
`omitSensitiveLogFields(fields)`, `formatSafeLogLine(fields)`.

**Config** (`config.ts`) — `requireString` (throws `MissingConfigError`),
`optionalString`, `integer`, `flag`. Blank counts as absent everywhere.

**Third parties** (`clients/`) — `bindErp`/`erp()`, `createErpFromOmie()`,
`bindPlacas`/`placas()`, `createProductionPlacas()`, `motul.*`, `tecfil.*`, `placasProviders.*`,
and `omie.*`. The Motul, Tecfil and plate clients live in `clients/{motul,tecfil,placas}/`
(wave 5.1a; see `clients/README.md`). `omie.*` is `erp-mock.ts`, the barrel over `erp-mock/`:
`createOmieAdapter`, `createFakeOmie`, `createMockOmie`, `mockOmieDataset`, `emptySnapshot`, the
wire mapping and the `OmieAdapter`/`OmieSyncPort` types — absorbed from `@select-lub/omie` in
5.1b. Inside core import `kernel/clients/erp-mock.js`; outside it, `clients.omie` from
`@select-lub/core`.
Bind at the composition root; an unbound port throws rather than faking.
