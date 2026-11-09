# auth

Who is calling and which unit the request is scoped to — the security boundary
every api route sits behind. Only the hook lives here; the routes (`/auth/me`,
`/users`, `/units`) and the tables they read (`user`, `user_unit`, `unit`) are the
`accounts` module's, in `packages/core/src/modules/accounts`.

Moved from `apps/api/src/auth/` in wave 5.2 with its behaviour unchanged. It
replaced the kernel's earlier `kernel/auth.ts`, which no one registered and which
had neither the `X-Unit-Id` resolution nor the 403.

- **hook.ts** — Fastify `onRequest` hook: token → caller → `request.crm*` fields,
  401 / 403. Its caller reads come from accounts' `createCallerDirectory`, passed
  in by `apps/api/src/app.ts`
- **resolve-unit.ts** — `x-unit-id` vs membership, which paths skip the unit
  check (`isUnitExemptPath` matches accounts' paths literally), the `/api` rewrite,
  and `API_PATH_PREFIXES`: a GET or HEAD outside that list is a static asset and
  skips the token check, so a new route's prefix must be added there
- **get-user.ts** — Supabase `getUser`, and the fake token table the tests use
  (exported through `@select-lub/core/testing`)
- **resolve-unit.test.ts** — the pure helpers

The hook's own cases run through the real `buildApp` in `apps/api/test/`
(`accounts.integration.test.ts`, `auth-hook.once.test.ts`, and the 401/403 cases
ruling W2-C9 put beside each module's routes), because only that app registers it.
