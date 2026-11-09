# e2e/test

Playwright fixtures. Default spec files import `test` from `fixtures.ts`. Live specs import `test` from `live/fixtures.ts` (no e2e SQL seed). Tour specs import `test` from `tours/fixtures.ts`, which extends the default one with the cross-cutting invariants every tour asserts.

- **fixtures.ts** — Conversas page object, authed `crmApi`, per-test SQL seed
- **ids.ts** — stable e2e customer/conversation/service ids
- **seed-e2e.ts** — Prisma upserts (nameless customer, free/occupied services, CONNECTED)
- **pages/** — locators per screen
- **live/** — opt-in Programar mensagem (`pnpm test:e2e:live`); ignored by `pnpm test:e2e`
- **tours/** — exploratory tours (`pnpm test:e2e:tours`) and their run reports; ignored by `pnpm test:e2e` and by CI
- **remote/** — read-only smoke against a PUBLISHED origin (`E2E_BASE_URL pnpm test:e2e:remote`); ignored by `pnpm test:e2e`. Own fixtures: no seed, no `@select-lub/db`, no local server. `remote-is-read-only.test.ts` enforces that
- **supabase-token.ts** — the password grant, shared by `fixtures.ts` and the remote suite (which must not import `fixtures.ts`, since that reaches Prisma)
