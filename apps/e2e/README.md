# e2e (`@select-lub/e2e`)

Playwright critical-flow specs against API + Vite (no worker, no live Evolution).

- **test/** — fixtures, SQL seed, and `conversas-*.spec.ts` (default config ignores `test/live` and `test/tours`)
- **test/live/** — opt-in Programar mensagem against real Evolution + worker
- **test/tours/** — exploratory tours transcribed from a live drive, plus their run reports in `runs/`; never collected by CI
- **playwright.config.ts** — starts a loopback Evolution mock, the API (`SERVER_URL` pointed at that mock), and Vite
- **playwright.live.config.ts** — API + Vite + worker, real `SERVER_URL`, no mock Evolution
- **playwright.tours.config.ts** — same shape as the default, on ports 3100/5174/18081 with the Omie and plate mocks on and paid-provider keys blanked
- **mock-evolution.mjs** — `connectionState` → `open` so enqueue/schedule write Postgres only (port from `E2E_EVOLUTION_PORT`, default 18080)

Run from the repo root after Compose Postgres is up, migrated, and demo-seeded:

```bash
pnpm test:e2e
```

Live Programar mensagem (not CI). Sets `E2E_LIVE_SCHEDULE=1`, starts the worker, and may send **one** WhatsApp text to **19 00000-0002** (`5519000000002`). Skip unless that flag is set and `DATABASE_URL` is local. Fail if the instance is not `CONNECTED` or if `DATABASE_URL` is remote without `LIVE_TESTS_ALLOW_REMOTE=1`. If seed wiped the CRM row for that dest, the fixture creates the 1:1 (no WhatsApp send at create). Stop any other worker (`pnpm dev:worker`) on the same DB first.

```bash
pnpm test:e2e:live
```

Exploratory tours. Own stack on 3100/5174/18081, so it runs beside `pnpm dev`; mock Evolution and mock providers only, no worker, no real send. Fragile by design and excluded from `pnpm test:e2e` and CI — `test/ci-excludes-live.test.ts` fails if the default config ever collects one. Drive first, write the run report in `test/tours/runs/`, then transcribe. See `test/tours/README.md` and `skills/testing-exploratory-tours/SKILL.md`.

Tours sign in to a **local** Supabase Auth, never the hosted project: start it once (Docker must be up), run the tours, stop it when done.

```bash
pnpm tours:supabase:start   # Auth on 127.0.0.1:54321 + the tour test user
pnpm test:e2e:tours
pnpm tours:supabase:stop    # removes the three local Supabase containers
```

`pnpm test:e2e:tours` refuses to start while local Supabase is down. It signs in as the committed test user in `tour-auth-env.ts` and overrides every Supabase / login variable the `.env` holds, so it runs with no `.env` at all and never sends the production login. Tours use their own `<worktree>_tours` database. See `test/tours/README.md`.

`pnpm test:e2e` (and CI) still auto-logs in with `VITE_MVP_LOGIN_EMAIL` / `VITE_MVP_LOGIN_PASSWORD` plus `VITE_SUPABASE_*` from the gitignored `.env` (repository secrets in CI). Do not put those values in git.
