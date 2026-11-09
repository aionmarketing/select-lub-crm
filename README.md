# Select Lub CRM

CRM for Select Lub (oil-change workshops). WhatsApp via Evolution API + Baileys, shared customer/vehicle cadastro with Omie, assistive (never autonomous) AI. Business context: `AGENTS.md`. Detailed specs: Notion _Hub de Especificações — CRM Select Lub_.

## Prerequisites

- Node.js 22 or newer
- [pnpm 11.23.0](https://pnpm.io/installation) via Corepack (`corepack enable` then `corepack prepare pnpm@11.23.0 --activate`)
- Docker (for local CRM Postgres; Evolution API runs on a hosted provider, not in Compose)

## Setup

```bash
corepack enable
corepack prepare pnpm@11.23.0 --activate
pnpm install
cp .env.example .env
```

Set `AUTHENTICATION_API_KEY` in `.env` to the hosted Evolution instance's API key, and `EVOLUTION_WEBHOOK_SECRET` to a value from `openssl rand -hex 32`. Leave CRM `POSTGRES_*` / `DATABASE_URL` as in the example unless you changed local Postgres. `OPENAI_API_KEY` and `OPENAI_MODEL` are optional and only used by the internal Motul agent helper in `apps/api` — not by `pnpm --filter @select-lub/core motul:demo`.

```bash
docker compose up -d
```

Wait until Compose is healthy (`docker compose ps`). Compose starts **CRM Postgres only** (host port **5433**, to avoid clashing with a local install on 5432). The Evolution API instance is hosted (WhatsEvolution) — the repo no longer ships a local Evolution stack (removed 2026-08-30; the last version with it is in git history).

**Hosted Evolution API v2:** set `SERVER_URL` to the remote origin (no trailing slash), `AUTHENTICATION_API_KEY` to the instance token from that host, and `EVOLUTION_INSTANCE_NAME` to the unencoded panel name (spaces are allowed; worker and API percent-encode the path). A remote host cannot reach `host.docker.internal`. Start the worker (`pnpm dev:worker`), then a public HTTPS tunnel to the worker loopback, for example `cloudflared tunnel --url http://127.0.0.1:3001`, and set `EVOLUTION_WEBHOOK_URL` in local `.env` only to `https://<tunnel-host>/webhooks/evolution`. Register that URL with `POST {SERVER_URL}/webhook/set/{percent-encoded EVOLUTION_INSTANCE_NAME}` (`base64: false`, `Authorization: Bearer` from `EVOLUTION_WEBHOOK_SECRET`). When the tunnel URL changes, run `webhook/set` again. Do not enable `WORKER_HISTORY_BACKFILL` for this hosted trial. Production webhook registration is the worker's Fly URL (see Deployment below) — do not register a tunnel and the Fly worker on the same instance at the same time.

Apply the CRM schema and seed the WhatsApp connection used to resolve webhook `instance` (`EVOLUTION_INSTANCE_NAME`, default `select-lub-poc`):

```bash
pnpm db:migrate
pnpm db:seed
pnpm --filter @select-lub/core db:ping
```

`DATABASE_URL` (CRM Postgres on 5433) is required for the worker webhook. If it is unset, `POST /webhooks/evolution` returns **503**. Authenticated 1:1 `MESSAGES_UPSERT` / `SEND_MESSAGE` events are stored in `webhook_event`, `conversation`, and `message` — not in `artifacts/evolution-webhooks/`.

`DIRECT_URL` is the migrate/direct connection (Supabase session pooler is the runtime fallback when the host has no IPv6). `pnpm db:migrate` uses `DATABASE_URL` from `.env` locally; in CI/operators it should be the direct URL. Published Fly machines never run migrations.

To pair a real WhatsApp number and run PEND-CH-01, follow [docs/poc-evolution-baileys.md](docs/poc-evolution-baileys.md). Create the Baileys instance with `"syncFullHistory": true` (BR-CH-09 — every instance create, test or production). Live messages reach the worker at `POST http://127.0.0.1:3001/webhooks/evolution` with `Authorization: Bearer <EVOLUTION_WEBHOOK_SECRET>`. Pre-CRM chat history is imported later from Evolution REST (`findMessages` / `findChats`), not from the pairing `messages.set` webhook.

WhatsApp media (image, audio, video, document) is **fetch-on-demand**: the CRM does not archive attachments. Viewing a bubble calls Evolution `getBase64FromMediaMessage` while the instance is connected; the webhook stays `"base64": false`. Outbound files may sit on the outbox row until `confirmed` / `blocked` / exhausted `failed`, then the bytes are discarded. The API rejects files larger than **16 MiB** before an outbox row is created.

### Working in a git worktree

`git worktree add` gives you an isolated checkout but **not** an isolated
database. A worktree has no `.env` of its own, so whoever needs one copies the
main checkout's — and every worktree then reads and writes the same rows.
Concurrent sessions overwrite each other, which is the likeliest cause of
flaky parallel test runs.

From inside the new worktree:

```bash
pnpm db:worktree-env
```

That copies the main checkout's `.env` — so credentials and configuration come
across — but rewrites `DATABASE_URL`, `DIRECT_URL`, `DATABASE_URL_TEST` and
`POSTGRES_DB` to a database derived from the worktree's directory name
(`selectlub_<worktree_name>`, hyphens to underscores, hash-suffixed if it would
exceed Postgres' 63-byte identifier limit). It always points at local Compose on
`127.0.0.1:5433`, never at the endpoint it inherited, so a main checkout aimed
at the hosted database still yields a **local** worktree. It refuses to
overwrite an existing `.env` without `--force`.

Then create that database **from the conversation base** and bring it up:

```bash
docker compose exec -T postgres psql -U selectlub -d postgres -c 'CREATE DATABASE "selectlub_my_worktree" TEMPLATE "selectlub_realbase"'
pnpm db:migrate
pnpm db:seed
```

`TEMPLATE` is what gives the worktree real conversations to work with. The seed
creates none — conversations come from WhatsApp or not at all — so a worktree
created empty has nothing for it to decorate, and Conversas plus every screen
hanging off it renders its empty state. See **The conversation base** below for
how `selectlub_realbase` is built.

If you have not built the base yet, drop `TEMPLATE "selectlub_realbase"` and the
worktree still works; it simply has no conversations.

Run `pnpm db:migrate` before `pnpm db:seed`, always: the seed opens vehicle
returns through the services module, under the database's module roles, and
`db:migrate` is what grants them. The seed on a database without them fails
with `permission denied`. (`prisma migrate reset` is covered: its seed hook
runs `pnpm db:migrate-then-seed`.)

`db:seed` refuses any non-loopback host and prints where it writes, so a
worktree still pointed at the hosted database fails loudly instead of seeding
it. It also refuses `selectlub_realbase` by name, whatever the host — see below
for why that one is unrecoverable. Because each worktree owns its database,
`prisma migrate reset` in one cannot affect another.

### The conversation base

`selectlub_realbase` is a local database holding real conversations and no
cadastro. Worktrees are cloned from it; **nothing runs against it**, and it is
never seeded.

Build it once:

```bash
docker compose exec -T postgres psql -U selectlub -d postgres -c 'CREATE DATABASE "selectlub_realbase"'
DATABASE_URL='postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_realbase' \
  pnpm db:migrate
```

Now insert the two rows the import needs. The backfill (channel's
`backfillHistory`) iterates every `whatsapp_connection` row, so a freshly migrated database — which has none —
imports nothing at all and leaves you with an empty base that looks like an
Evolution failure. `whatsapp_connection.unit_id` is a required foreign key, so
the unit has to exist first:

```bash
docker compose exec -T postgres psql -U selectlub -d selectlub_realbase <<'SQL'
INSERT INTO unit (id, name, created_at, updated_at)
  VALUES ('base-unit', 'Select Lub', now(), now());
INSERT INTO whatsapp_connection
    (id, unit_id, instance_name, provider, connection_state, created_at, updated_at)
  VALUES ('base-conn', 'base-unit', 'REPLACE_WITH_EVOLUTION_INSTANCE_NAME',
          'EVOLUTION_BAILEYS', 'CONNECTED', now(), now());
SQL
```

**Both names have to match what the seed looks for, and nothing checks that you
got them right.** `seed.ts` finds its unit by the literal name `Select Lub` and
reconciles the connection by `EVOLUTION_INSTANCE_NAME`; miss either and it
creates its own instead. The clone then holds two units, the seed decorates
conversations in the unit it just made — which has none — and every screen is
empty while the database plainly contains conversations. Use the exact
`EVOLUTION_INSTANCE_NAME` value from the repo-root `.env`.

Then import history from Evolution into it — see `docs/poc-evolution-baileys.md`
for the endpoint itself:

```bash
DATABASE_URL='postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_realbase' \
  pnpm --filter @select-lub/worker backfill:once
```

**Use that script, not the worker's `WORKER_HISTORY_BACKFILL=1` flag.** The flag
runs the backfill inside the full worker, which starts every other loop beside
it. Two of those are actively harmful here: the prefill loop calls the language
model on closed conversation windows, so importing a real history of hundreds of
conversations quietly runs up a token bill; and the worker holds the database
open, which alone prevents the base from ever being cloned, since Postgres
refuses to copy a database that has open sessions. The worker also never exits,
so there is no exit code telling you the import finished. `backfill:once` runs
the import and nothing else, reports the resulting counts, and exits.

Leave `WORKER_HISTORY_BACKFILL` unset in demo. If any `SEED` message exists, the
worker and `backfill:once` refuse the REST import even when the flag is `1`.

After the import, strip real bodies so clones do not inherit them:

```bash
DATABASE_URL='postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub_realbase' \
  pnpm db:scrub-live
```

Empty threads on the base are expected. Confirm: conversations present, no
customers, no `LIVE` messages, and exactly one unit named `Select Lub`.

Two rules, and both matter more than they look:

- **Never seed it.** The seed only decorates conversations that have no customer,
  so cadastro written here is inherited by every database cloned from it
  afterwards and **cannot be removed by re-seeding** — those conversations then
  have customers, so the seed skips them. The only repair is rebuilding the base.
  `db:seed` refuses it by name for exactly this reason. `db:scrub-live` is the
  allowed write against the base besides the import.
- **Never connect to it.** Postgres cannot copy a database that has open
  sessions, so a base someone is working against cannot be cloned.

Worktree clones: `db:scrub-live` (if the copy still has live bodies) then
`db:seed`.

Refresh it by re-running the history import when you want newer conversations,
then scrub again; worktrees created before a refresh keep the set they were
cloned from.

### What is real and what is fake

**Phone numbers are real. Seeded thread bodies are fake. Live WhatsApp bodies stay until scrubbed.**

This split is deliberate:

- **Real** — the phone numbers on conversations, and any `LIVE` messages that
  have not been scrubbed yet.
- **Fake** — customer names, vehicles, plates, services, addresses, units, users,
  Omie identifiers, plate lookups, **and `SEED` message bodies**. After
  `db:scrub-live` then `db:seed`, Relatórios and Conversas follow the seeded
  exchange.

A screenshot of Conversas still contains real phone numbers. Until you scrub,
leftover live bubbles sit on top of the fake thread.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | API + web together (via `concurrently`, labeled/colored output in one terminal). Covers most UI work — worker isn't needed unless you're testing live WhatsApp. |
| `pnpm dev:full` | API + web + worker together — add this when you need live WhatsApp ingest/outbox. |
| `pnpm dev:web` | Vite SPA at http://127.0.0.1:5173 — Conversas at `/`, Relatórios at `/relatorios`, Configurações at `/configuracoes`, Usuários at `/usuarios`, living token gallery at `/galeria`. Proxies `/api` to the Fastify API on port 3000. |
| `pnpm dev:web:antigravity` | The same SPA built with the **antigravity** UI variant: a vertical icon rail instead of the nav row, and Conversas as four independently scrolling columns. Equivalent to `pnpm dev:web --mode antigravity`, which loads `.env.antigravity`. Without the argument the variant is `cursor`, and so is any value that is not exactly `antigravity`. The variant is fixed when the server starts — there is no switch in the UI — while the yellow/black palette switch works on both. `pnpm test:web:antigravity` runs the web suite against it. |
| `pnpm dev:api` | Fastify API at http://127.0.0.1:3000 (`GET /health`, Conversas, `GET /reports/conversations`, `GET /channel/status`) |
| `pnpm dev:worker` | Worker + webhook ingest at http://127.0.0.1:3001 (`POST /webhooks/evolution`; needs `DATABASE_URL`). Outbox drain polls every `WORKER_OUTBOX_POLL_MS` (default 1000 ms) until the `queued` set is empty (cap 50/tick). Ingest retry stays on `WORKER_HEARTBEAT_MS` (default 30 s). Abandoned `claimed` rows older than `WORKER_OUTBOX_CLAIM_TIMEOUT_MS` (default 180000 ms) become `failed` with `send_outcome_unknown` and are never resent automatically; keep it above the 120000 ms media send limit. Pre-CRM history import (`WORKER_HISTORY_BACKFILL=1`) is opt-in: a default `pnpm dev:worker` start does not page Evolution REST. |
| `pnpm lint` | ESLint across the workspace |
| `pnpm test` | Vitest workspace — unit/integration/component tests (no Docker required) |
| `pnpm test:watch` | Same suite in watch mode |
| `pnpm test:coverage` | `pnpm test` plus v8 coverage (`text` + `html` under `coverage/`) |
| `pnpm test:e2e` | Playwright critical-flow specs (`apps/e2e`) against API + Vite; no worker, no live Evolution. Ignores `test/live`. |
| `pnpm test:e2e:live` | Opt-in Programar mensagem (`E2E_LIVE_SCHEDULE=1`): API + Vite + worker, real Evolution. May send one WhatsApp text to **19 00000-0002** (`5519000000002`). Skip unless the flag and local `DATABASE_URL`. Fail if not `CONNECTED` or if `DATABASE_URL` is remote without `LIVE_TESTS_ALLOW_REMOTE=1`. Creates the CRM 1:1 for that dest when seed wiped it (no send at create). Stop any other worker on the same DB first. Never CI. |
| `pnpm test:e2e:tours` | Exploratory tours (`apps/e2e/test/tours`): its own stack on 3100/5174/18081 so it runs beside `pnpm dev`, mock Evolution plus the Omie and plate mocks, paid-provider keys blanked, no worker, no real send. A tour is transcribed from a live browser drive and is fragile by design, so it is excluded from `pnpm test:e2e` and never runs in CI — a failing tour must not block a pull request. Run reports live in `apps/e2e/test/tours/runs/`. |
| `pnpm typecheck` | `tsc --build` for the workspace |
| `pnpm format` | Prettier write |
| `pnpm db:scrub-live` | Delete `LIVE` messages, matching outbox, and live-instance webhook events; keep conversations and `SEED` threads. Same host guard as `db:seed`; allowed on the pristine base. |
| `pnpm db:reconcile-returns` | Runs the vehicle-returns reconcile once over every vehicle with a service or an open return, and nothing else — no Omie. Needs `DATABASE_URL` set in the shell (the repo `.env` is not read), prints `reconcile-returns: writing to <host>`, and applies the module grants first. It is what migration `20260925140000_one_open_return_per_vehicle` names when it refuses a vehicle whose OPEN returns come from different services. |
| `pnpm --filter @select-lub/core motul:demo` | Live Motul Oil Advisor chain for the sample vehicle (needs network; not in CI) |
| `pnpm --filter @select-lub/core tecfil:demo` | Live Tecfil (Catálogo Expresso) filter-fitment chain for the sample vehicle (needs network; not in CI) |

`pnpm test` skips live-database checks when `DATABASE_URL` is unset. API tests that persist to Postgres use `DATABASE_URL_TEST` (a separate `selectlub_test` database — see `apps/api/test/README.md`). Use `db:ping` after Compose is up.

`pnpm dev:web` opens Conversas at `/`. Send is a new message in the thread (text or media), not a WhatsApp-style quote of a specific bubble — that is post-MVP ([GitHub #52](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/52)). The inbox search matches contact name or phone; **Nova conversa** opens or creates a 1:1 thread by phone when the channel is `CONNECTED` and does not send WhatsApp. Channel status is the four-state `CONNECTING` / `CONNECTED` / `DEGRADED` / `DISCONNECTED`. List origem stays desconhecida until classification. The SPA auto-logs in with `VITE_MVP_LOGIN_EMAIL` and `VITE_MVP_LOGIN_PASSWORD` (documented default email `attendant-a@selectlub.example`) and does not show a login form. Visiting `/login` redirects to `/`. If auto-login fails, a Portuguese error is shown and Conversas data is not fetched. Relatórios is at `/relatorios` (nav link from Conversas). Configurações is at `/configuracoes` (Tag and Template CRUD). Usuários is at `/usuarios` (create user and attach/detach units). The living token gallery (primary / secondary / WhatsApp buttons, card, text field) stays at `/galeria`. The SPA sends `Authorization: Bearer` from the Auth session. `X-Unit-Id` is the current unit and must be a membership (else the API returns 403).

Supabase Auth is on. Fastify verifies the access token with `auth.getUser`; Prisma remains the only reader of business tables. Do not enable the PostgREST Data API — it stays off. The SPA uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the publishable/anon key). The Auth service-role key (`SUPABASE_SERVICE_ROLE_KEY`) is API-only for `POST /users` — never a `VITE_` variable. Worker webhooks still use the Evolution secret (`EVOLUTION_WEBHOOK_SECRET` as Bearer on `POST /webhooks/evolution`); they do not require a user JWT.

Isolation check (two users / two units): seed creates units `Select Lub` and `Select Lub 2`. Create Auth users `attendant-a@selectlub.example` (unit 1) and `attendant-b@selectlub.example` (unit 2) in the Auth dashboard — passwords stay out of git. Set `SEED_USER_A_ID` and `SEED_USER_B_ID` to those Auth UUIDs, then `pnpm db:seed`. A's token plus B's unit id must 403.

The auto-login Auth uuid and the seeded CRM `user.id` are the same string on purpose. Fastify loads unit memberships from local Postgres by that uuid, not from Auth. If `SEED_USER_A_ID` is unset, or is a different uuid than the auto-login account, auto-login still succeeds and every unit-scoped route returns 403 — the SPA shell still renders. Copy the Auth dashboard uuid into `SEED_USER_A_ID` (and B) before `db:seed`. Nothing in the schema or the suite checks that match.

`pnpm db:seed` also upserts mock `catalog_item` lubricant rows (oil-quote stand-in for Omie; second run does not duplicate). Seed does **not** insert tags or templates — the catalog starts empty and attendants create names in Configurações. Tags are CRM-internal (same names the workshop uses on WhatsApp, not a WhatsApp-native sync). Conversas has no rail/composer template insert (those surfaces are the oil-quote flow and the per-service Programar mensagem form); previewing a template does **not** send WhatsApp / enqueue the outbox. Relatórios counts **conversas novas** by WhatsApp `first_inbound_at` (not ingest/`created_at` time), **ativas** by a message `providerTimestamp` in the period, first-response from `first_outbound_at - first_inbound_at`, subsequent-response by pairing each inbound to the first later outbound (no consecutive-inbound collapse), sem resposta when the latest message is inbound, taxa de respondidas as novas with a first outbound over novas, plus breakdowns by active tag, campaign/ad ids, and scheduled-message status. REP-11 and REP-12 (retorno a serviço / conversão conversa→serviço) are out of this MVP. conversation `source_type` defaults to `UNKNOWN` (desconhecida) until an ad-evidence pipeline exists. Serviços (`GET /customers/:id/services`, `GET /conversations/:id/services`) are Omie-origin from mock import or demo seed — there is no CRM create or patch route. Theme tokens live in `apps/web/src/theme.ts` — product screens must use that theme instead of inventing local colors. Hex values there are working approximations from the public site; exact brand confirmation is a follow-up. `theme.spacing(1)` is 8px (MUI’s default base). The 4px scale uses half-steps: `spacing(0.5)` = 4px. Do not set `spacing: 4`.

Exercise the live Motul Oil Advisor chain (network required, not part of CI):

```bash
pnpm --filter @select-lub/core motul:demo
```

The sample vehicle is PEUGEOT / 2011 / 207 Passion SW / 1.4i 8V - TU3. `OPENAI_API_KEY` / `OPENAI_MODEL` in `.env` are only for the internal `runMotulAgent` helper in `apps/api`; they are not needed for this demo or for Motul HTTP lookups.

Exercise the live Tecfil (Catálogo Expresso) filter-fitment chain (network required, not part of CI; the API is unauthenticated but not published for programmatic use — see [`docs/tecfil-catalogo-expresso-api.md`](docs/tecfil-catalogo-expresso-api.md#before-you-use-this)):

```bash
pnpm --filter @select-lub/core tecfil:demo
```

The sample vehicle is PEUGEOT / 207 / 2011 / 1.4 8V, resolved with no option picker (every field matches Tecfil's own names exactly).

Omie HTTP is opt-in via vault/env (`OMIE_APP_KEY` / `OMIE_APP_SECRET`). CI keeps those unset and uses the fake adapter (no sockets to Omie). Mock opt-in `OMIE_MOCK=1` (default off) serves clients, OS, catalog products, vehicle ids, and duplicate candidates without credentials; configured credentials always win over the mock flag. `OMIE_MOCK_DATASET=tidsci` (local only) serves a generated JSON dump from `tid_archive` instead of the small fixture — generate with `pnpm --filter @select-lub/core tidsci:generate` (`TID_ARCHIVE_DATABASE_URL`, optional `OMIE_MOCK_TIDSCI_PATH`, `--limit` / `--refresh-catalog`); missing JSON throws. Worker startup one-shot pull is off unless `WORKER_OMIE_PULL=1`. Incremental poll is off unless `WORKER_OMIE_POLL=1`; `WORKER_OMIE_POLL_MS` sets the interval (default 3600000). Enabling the poll makes the CRM call Omie periodically (real HTTP with credentials, otherwise the mock when `OMIE_MOCK=1`).

Plate lookup is opt-in via `APIBRASIL_BEARER_TOKEN`. Unset with no `PLACAS_MOCK=1` leaves `POST /plate-lookups` unavailable. Credentials win over the mock flag. Every uncached live call spends prepaid credit; cache hits and mock answers do not. `API_PLACAS_TOKEN` (API Placas / `wdapi2.com.br`) is post-MVP: the factory ignores it and it MUST NOT be set on Fly. After a Fly deploy, apply the additive `plate_lookup` migration from an operator machine with the same `DATABASE_URL="<production DIRECT_URL>" pnpm db:migrate` command as any other pending migration — never from the published Fly machines.
## Deployment

What runs where: `apps/web` (SPA `dist/`), `apps/api`, and `apps/worker` publish on **Fly.io** region `gru` (São Paulo). The Evolution API instance is hosted by **WhatsEvolution**. CRM Postgres is the dedicated **Supabase** project. Production secret values are not stored in this repository.

**Two published links, one product.** The SPA ships in two UI variants (see `pnpm dev:web:antigravity` above), and each has its own origin:

| Link | Fly app | Variant | Config |
| --- | --- | --- | --- |
| `https://select-lub-crm-api.example.invalid` | `select-lub-crm-api` | `cursor` (default) | `apps/api/fly.toml` |
| `https://select-lub-compare-antigravity.example.invalid` | `select-lub-compare-antigravity` | `antigravity` | `apps/api/fly.toml` with `--app` |

Both run the same API image built from the same commit, point at the same CRM Supabase database, and share the single `select-lub-crm-worker` — publishing the second origin adds no worker machine. Only the bundled SPA differs, chosen by the `VITE_UI_VARIANT` build arg. There is deliberately one Fly config for both: the wrapper passes `--app`, which overrides the file's `app =` line, so a memory or `min_machines_running` change reaches both origins instead of drifting between two copies. The antigravity app was created for a 2026-09 comparison with `OMIE_MOCK=1` set as a **secret**; a deploy never clears secrets, so if that app is ever re-created, check `flyctl secrets list` for `OMIE_MOCK` before publishing — it would make one link serve the mock Omie source while the other serves the real one, with nothing in `/health` or the smoke to show it.

**Postgres URLs.** Runtime (`DATABASE_URL`) is the direct connection when Fly can reach Supabase over IPv6, or the session-mode pooler when the host is IPv4-only. `DIRECT_URL` is the direct connection used for `prisma migrate` from CI or an operator machine. Migrations never run on the Fly machines.

**Deploy commands.** Run them from a clean checkout of the commit you intend to publish:

```bash
pnpm deploy:worker
pnpm deploy:api
pnpm deploy:api:antigravity
```

Each refuses before contacting Fly when the working tree is dirty, when `HEAD` is not contained in `origin/main`, or when an SPA build input is missing, and names what is wrong. It never prints a secret value. The api targets require `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MVP_LOGIN_EMAIL` and `VITE_MVP_LOGIN_PASSWORD` in the environment (or in the repo `.env`) — **the MVP e-mail and password are build inputs of the bundle, not runtime configuration**: Vite inlines them, the SPA has no login form by design, and a deploy without them publishes a link that loads and then cannot sign anyone in. `pnpm deploy:worker` also runs `fly scale count 1` for the reason below. The raw equivalent is `fly deploy . --app <app> --config apps/api/fly.toml --build-arg ...`; prefer the wrapper, which is what stamps `GIT_COMMIT` and the variant.

**Which commit is live.** `GET /health` on either api origin returns `{ status, database, commit, uiVariant }`, and `GET /health` on `https://select-lub-crm-worker.example.invalid` returns `{ status, commit }`. `commit` is the full SHA the image was built from, or `unknown` when an image was built without it — reported rather than omitted, so a check against an expected SHA fails instead of passing vacuously.

**Verifying a deploy.** A deploy counts as verified when the read-only remote smoke passes against every origin:

```bash
E2E_BASE_URL=https://select-lub-crm-api.example.invalid pnpm test:e2e:remote
E2E_BASE_URL=https://select-lub-compare-antigravity.example.invalid E2E_EXPECT_VARIANT=antigravity pnpm test:e2e:remote
```

It starts no servers and writes nothing: it checks the health commit and variant, that opening the link reaches Conversas through auto-login with no credential form, that the six product routes render with that variant's shared navigation, and that the Conversas list, Follow-up counts and Relatórios summary answer 2xx. `E2E_EXPECT_COMMIT` defaults to the checkout's `HEAD`; `E2E_WORKER_URL` defaults to the published worker. `pnpm test:e2e` never collects it.

**Release order.** Merge to `main` → CI green on `main` → apply pending migrations (below) → `pnpm deploy:worker` → `pnpm deploy:api` → `pnpm deploy:api:antigravity` → confirm one worker machine → remote smoke on both origins.

**Schema vs image.** Apply pending Prisma migrations from an operator machine — never from the Fly machines. Set `DATABASE_URL` in the shell to the production `DIRECT_URL` so `db:migrate` does not fall through to the repo-root `.env` Compose URL (`127.0.0.1:5433`):

```bash
DATABASE_URL="<production DIRECT_URL>" pnpm db:migrate
```

Do not use the local Compose database URL (`127.0.0.1:5433`) for that command.

When a pending migration only adds a column with a database default (the live image does not query that column yet), apply it on production `DIRECT_URL` **before** treating the new image that first reads the column as operational. If the published image is already ahead of the schema, apply pending migrations immediately. Do **not** run `db:seed` (or the demo seed) against production.

The SPA is built with an empty `VITE_API_BASE` so requests go to `/conversations` on that origin (the `/api` prefix is also rewritten, matching the Vite dev proxy). Missing or wrong `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` fails auto-login with a Portuguese error — it does not render a silent empty Conversas screen.

**Evolution webhook events (production requirement).** The production instance's webhook (`POST {SERVER_URL}/webhook/set/{instance}`, pointed at the worker's `/webhooks/evolution`) must subscribe at least `QRCODE_UPDATED`, `CONNECTION_UPDATE`, `MESSAGES_UPSERT`, `MESSAGES_UPDATE` and **`SEND_MESSAGE`** — the full list and body are in [docs/poc-evolution-baileys.md](docs/poc-evolution-baileys.md) (`webhook/set`). `SEND_MESSAGE` is not optional: the drain confirms a send before it publishes the event that inserts the thread message, so when that insert fails, or Evolution's send response has no usable timestamp, the `SEND_MESSAGE` webhook for the same provider id is what puts the bubble in the thread. Without it those sends are delivered but never appear in Conversas. Re-check the subscription whenever the webhook is re-registered.

**Worker is exactly one machine.** The outbox claim has taken `FOR UPDATE SKIP LOCKED` since 2026-09-25, so two drains no longer claim one row, but running more than one worker is still not a supported layout ([GitHub #8](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/8)): keep it at one. After deploy, `fly scale count 1` on the worker (`pnpm deploy:worker` does this). The worker is always-on (`auto_stop_machines = false`): its outbox drain, ingest retry, and connection-state reconcile are timer-driven, and nothing wakes a stopped machine (an attendant send only writes a Postgres row). Both api origins autostop when idle (`auto_stop_machines = true`, `min_machines_running = 0`): the first request after a gap pays a cold start of ~1–3s. Set `min_machines_running = 1` on an api `fly.toml` to revert that if the delay is unwanted. An open Conversas WebSocket counts as an active connection and prevents a stop mid-use.

**The worker needs 1 GB.** `apps/worker/fly.toml` sets the VM to 1024 MB (raised from 512 MB, owner's ruling, 2026-09-25) because the worker parses manufacturer PDF manuals in a child process capped at `MANUAL_PARSE_MEMORY_MB` of address space (1024 by default, about 300 MB resident at the cap). The change takes effect on the next `pnpm deploy:worker`; until then the machine keeps 512 MB. Raise the VM and `MANUAL_PARSE_MEMORY_MB` together, never one without the other. `MANUAL_INGESTION_ENABLED=false` stops the ingestion.

**Background oil research runs on the worker only** (`background-oil-research`). The worker researches the oil spec of every registered car with a complete identity (make, year, model, version) in the background, one identity at a time, and a quote only reads what it stored.

- **The switch is `OIL_RESEARCH_ENABLED`.** Research stays off unless it is exactly `"true"` — in `.env.example`, in development and in every test env — so a seeded database never researches the demo fleet on someone's key. `apps/worker/fly.toml` sets `OIL_RESEARCH_ENABLED = "true"` under `[env]`, so production researches from the deploy on. Setting it to `false` on the worker is the rollback: research stops; cars already researched still open on their stored options, and the rest say the automatic research is not running and the request stays queued.
- **The budget is `OIL_RESEARCH_DAILY_BUDGET_USD`, US$ 2.00 a day** (America/Sao_Paulo day), and it holds **only the backfill** — the paced sweep through cars nobody is waiting on. Research someone is waiting on (a quote opened, "Buscar novamente", a car registered in the last 24 h, a manual upgrade) is exempt and never paused by it, but its spend is metered and counted in the day's total, so on a busy day the backfill stops sooner. The setting parses strictly: anything but a number ≥ 0 written with a dot is logged and the default is used; `0` stops only the backfill. Spend is priced at the international list, the upper bound.
- **The keys are the worker's:** `OPENAI_API_KEY` (every model call, the web search and the Tecfil picker; the research model is `OIL_RESEARCH_MODEL`, default `gpt-6.1-sol` at effort `medium`). Without `OPENAI_API_KEY` the runner claims nothing and logs `no_key`; the worker's other loops and its `/health` keep running. Any `WEB_SEARCH_*` or `OIL_RESEARCH_*` override in force belongs on the worker, since the api calls no provider for quotes. The one exception is `WEB_SEARCH_MISS_TTL_HOURS`, which the api also reads (to decide when a quote-open re-opens a car whose search found nothing): change it on both or on neither.
- **Research runs on OpenAI `gpt-6.1-sol` at `medium`** (`switch-oil-research-to-openai`; GLM was removed). **Rollback of that switch is a `git revert` of its PR B plus `pnpm deploy:worker`** (and the api origins), not a setting: the GLM code returns with the revert, and the owner sets `GLM_API_KEY` again on the worker if it had been unset. Rows written under GLM stay readable either way: their recorded cost still counts toward the day, and the duration estimate samples only the model in force.
- **The shutdown grace is `kill_timeout = 30`** in `apps/worker/fly.toml`. On the stop signal the run in progress is released at once — back in the queue, due now, its attempt refunded — and the process exits only after that release has committed. A machine killed harder leaves its run to be reclaimed when its lease expires (12 min at the default effort), with that attempt counted.

**The first release of background research** (PRs 1–4 of `background-oil-research`, deployed as one release, cut from `main` at or after PR 4's merge) goes in this order: apply the migrations on production first (`DATABASE_URL="<production DIRECT_URL>" pnpm db:migrate`, below), then `pnpm deploy:worker`, then `pnpm deploy:api` and `pnpm deploy:api:antigravity`. The worker goes first, with research on, so the api never answers "not running" for every uncached car; the api's and the worker's `/health` `commit` then match. The owner's check before it (task 3.9, confirmed 2026-09-30): the worker holds the key, and neither api app sets an `OIL_RESEARCH_*` or `WEB_SEARCH_*` override that the worker would lack.

**Secrets (names only — set with `fly secrets set`, never commit values).** Both api origins take the same set:

- api (each origin): `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `AUTHENTICATION_API_KEY`, `SERVER_URL`, `EVOLUTION_INSTANCE_NAME`; optionally `APIBRASIL_BEARER_TOKEN` (plate lookup stays inactive without it) and `OMIE_APP_KEY` / `OMIE_APP_SECRET` (fake Omie source without them — see below). A quote needs no provider key: it reads the stored research and calls no provider (see *Background oil research* above)
- worker: `DATABASE_URL`, `AUTHENTICATION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET`, `SERVER_URL`, `EVOLUTION_INSTANCE_NAME`, `OPENAI_API_KEY` (every prefill job fails without it; background oil research and reading stored manuals, `quotes/run-oil-research` and `quotes/read-manuals`, claim nothing and log that they are waiting without it, while the rest of the worker runs), and `OMIE_APP_KEY` / `OMIE_APP_SECRET` only when `WORKER_OMIE_POLL=1`
- CI: `FLY_API_TOKEN`, `DEPLOYED_DATABASE_URL` (read-only migration-status check; named distinctly from `DATABASE_URL` so no test job can pick it up)

`OMIE_APP_KEY` / `OMIE_APP_SECRET` are read wherever `createOmieAdapter()` runs — the api at startup (`apps/api/src/app.ts`) for cadastro sync and prefill, and the worker's Omie pull. Without both, the adapter silently falls back to the fake Omie source; `OMIE_MOCK=1` selects it explicitly. So they are optional on the api only in the sense that the app still boots — set them on both api origins or on neither, never on one. When the two api origins' `flyctl secrets list` digests differ for a name, the links are not the same product; align them before deploying.

`SUPABASE_URL` and the publishable/anon key are not secret but must be supplied (build-args for `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`; runtime env for the API). `SUPABASE_SERVICE_ROLE_KEY` is API-only and never has a `VITE_` prefix.

**PEND-CH-02 / PEND-CH-03** (session backup/SLA with the vendor, named re-pair responder) remain open on [GitHub #21](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/21). This hosting layout does not close those items.

## Layout

```
apps/web                 React + Vite
apps/api                 Fastify
apps/worker              webhook / outbox process
apps/e2e                 Playwright (Page Object Model; Conversas critical-flow specs)
packages/core            kernel (db roles, http, jobs, Prisma client + seed, third-party clients incl. the Omie mock)
                         + 11 modules of vertical slices; Prisma schema per module and migrations in prisma/
packages/shared-types    barrel over @select-lub/core/contracts, the only core entry apps/web uses
```
