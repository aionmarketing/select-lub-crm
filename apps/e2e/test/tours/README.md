# e2e/test/tours

Exploratory tour specs — transcribed from a live drive, quarantined from CI.

```bash
pnpm tours:supabase:start   # once: local Supabase Auth on 127.0.0.1:54321
pnpm test:e2e:tours
pnpm tours:supabase:stop    # when done
```

## Sign-in is local

Tours sign in to a Supabase Auth on this machine, as a committed test user —
never to the hosted project, and never with the `.env`'s `VITE_MVP_LOGIN_*`
(OpenSpec `tours-local-supabase`). `pnpm tours:supabase:start` runs the pinned
Supabase CLI with the auth-only config in `apps/e2e/supabase/` (Auth, its
Postgres on 54322 and the gateway on 54321; nothing else) and creates the test
user through the admin API. Before every run `run-tours.mjs` reads the local
keys with `supabase status`, makes sure that user exists, and assigns the tour
auth env (`tour-auth-env.ts`) — local URL and anon key for the SPA and the API,
the test user's login, `SEED_USER_A_ID` for the seed, and the LOCAL service-role key for the API
(the Usuarios tours create users through it, so creation lands in the local
Auth). `tours-config.shared.ts` assigns it again after its `.env` load, so a
hosted value in the shell or the `.env` loses everywhere. With local Supabase
down, the runner exits naming the start command; it never falls back to the
`.env`. Tours run with no `.env` at all.

The tours get their own database, `<worktree>_tours`: the seed writes the test
user's CRM row with the same fixed email `pnpm test:e2e` writes for the hosted
attendant under a different id, so one shared database failed whichever suite
seeded second. Every tour also fails on a browser request to `*.supabase.co`;
the API's server-side verification is pinned by `test/tour-auth-guard.test.ts`.

One tour has its own command, because it needs an API process whose
`EVOLUTION_INSTANCE_NAME` names a DISCONNECTED instance:

```bash
pnpm test:e2e:tours:disconnected
```

It runs on its own ports (3101 / 5175 / 18082) and is excluded from the main
config, which would drive it against a CONNECTED instance and fail it for the
wrong reason. Both configs share `tours-config.shared.ts`; the provider
credential list lives there ONCE, on purpose.

One file per screen region (`<area>.tour.spec.ts`), one `test()` per tour. Run
one tour with `pnpm test:e2e:tours --grep "Rumo Errado"`.

**No `--` separator, and `--grep` matches titles.** pnpm forwards a literal `--`
into the runner's argv and Playwright then reads everything after it as
positional file filters, so `... -- --list` silently starts the whole stack
instead of listing. And every tour is titled `Tour <name>: …`, so
`--grep conversas-inbox` matches nothing — that is a filename. To run one file,
pass its path from inside `apps/e2e`.

## Not a merge gate

A tour walks a feature the way a person would, so a non-functional UI change can
turn it red. That is fine on demand and unacceptable on a pull request, so
`playwright.config.ts` ignores `**/tours/**` and `test/ci-excludes-live.test.ts`
fails if the default config ever collects one. Never add a tour to the default
suite; if a tour finds something worth gating, pin it with a Vitest or
default-suite test instead.

That one `testIgnore` line quarantines **two** suites for **two different**
reasons, and neither weakens the other. `tours/` is excluded because it is
fragile by design. `live/` is excluded because it is expensive and
irreversible — it sends real WhatsApp messages through the hosted Evolution
instance. If anyone proposes relaxing the line so a suite can run, the answer is
that each suite already has its own config and its own command
(`playwright.tours.config.ts` + `run-tours.mjs`, `playwright.live.config.ts` +
`run-live.mjs`); use those.

## Its own stack, and no way out to a provider

`playwright.tours.config.ts` starts API `3100`, Vite `5174`, mock Evolution
`18081`, all with `reuseExistingServer: false`, so tours run beside `pnpm dev`
(3000/5173) and can never attach to a dev API pointed at the hosted Evolution.
The tour API starts with `OMIE_MOCK=1` and `PLACAS_MOCK=1` and with
`OPENAI_API_KEY`, `APIBRASIL_BEARER_TOKEN`, `OMIE_APP_KEY` and
`OMIE_APP_SECRET` blanked, so a tour of plate lookup or cadastro sync reaches a
mock or the spec's unavailable path. No worker, no real WhatsApp send.

**Blank the name the code reads, not the one that sounds right.** This list said
`PLACAS_TOKEN` until 2026-09-14. Nothing in the repo reads that name, so it
bought nothing: `resolvePlacasAccess` reads `APIBRASIL_BEARER_TOKEN`, and it
resolves credentials BEFORE the mock opt-in, so `PLACAS_MOCK=1` is ignored
whenever that token is set. On a machine whose `.env` carries it — this one does
— the cadastro tour was using the real, credit-metered APIBrasil while this file
claimed otherwise. It cost nothing only because both plates it touches were
already cached; a cold cache would bill on every run.

**Motul and Tecfil are covered by a redirect, not by this list**: neither takes
a credential, and their hosts are compiled into their clients. The tour API sets
`MOTUL_BASE_URL` and `TECFIL_BASE_URL` to a loopback port nothing listens on
(`tour-provider-env.ts`), and `test/tour-provider-guard.test.ts` proves it on the
client call path — the real clients, driven with that env, build loopback URLs
and never their compiled-in hosts. That test was seen red with the redirects
removed, naming both providers. It runs in `pnpm test`, not in a tour: the
evidence has to be server-side, because the browser request listener cannot see
a call the API makes.

The oil quote itself reaches neither (background-oil-research: the quote reads
caches and research state only), but it QUEUES research, and the tour stack is
provider-free there only because it runs no worker — a dev worker on the same
database would research any complete car a tour opens, with whatever env that
worker has. Keep the tours on their own database.

Do not run the tours and `pnpm test:e2e` at the same time: both seed the same
local database with the same fixture ids.

**And do not run `pnpm test` straight after a tour run.** Its second phase
includes `packages/core/test/demo-seed.live.test.ts`, which measures whether
seeding changed anything across all 43 models — a measurement that is only
meaningful on a database nothing else has just written to. A tour leaves rows
the demo seed then cleans up, so the comparison correctly reports a conversation
count that moved, and the run goes red for a reason that has nothing to do with
the code. Observed on 2026-09-13: `Conversation: expected 31 to be 32` straight
after a tour run, exit 0 on the very next run with no change. Let the database
settle — re-run `pnpm test`, or run it before the tours rather than after.

## Three phases

Explore live, record always, transcribe what succeeded. The procedure is
`skills/testing-exploratory-tours/SKILL.md` and the tour catalogue is its
`references/tours-catalogue.md`.

1. **Explore** — drive the running app with a Playwright browser tool, choosing
   tours with an intention, diagnosing console and network as you go.
2. **Record** — every drive leaves a run report in `runs/`, green or not.
3. **Transcribe** — the spec is written from the steps the report marks
   succeeded, and each `expect` cites the OpenSpec scenario the report named for
   that step. Never assert a value because the drive displayed it.

## Spec header

`Feature`, `Run report` (path), `Guidebook` (spec scenarios walked), `Tours`
(each with one line of why), `Findings`, `Out of scope`.

Every tour also inherits the cross-cutting invariants from `fixtures.ts`: no
uncaught page error, no console error outside the commented allow-list, no HTTP
500 or above, and `mainPane` for the no-blank-pane check.

## Coverage ledger

One row per capability under `openspec/specs/` — every directory holding a
`spec.md`, named by its path there (the module grouping directories such as
`quotes/` hold no spec of their own and get no row). "Manual only" means the capability
has no browser-reachable surface a tour could drive, or needs a fixture the tour
stack deliberately refuses to carry — the reason is always stated, so an absent
tour is a decision on the record rather than an oversight.

Last full pass: **2026-10-04** (change `close-stated-coverage-gaps`, task 4.2):
`pnpm test:e2e:tours` and `pnpm test:e2e:tours:disconnected`, each run twice in a
row. Before that, **2026-09-10** (change `exploratory-tour-tests`).
The pass is not all green, and the reds predate it: both main-config runs failed
the same three tours — `follow-up.tour.spec.ts:126` (Rumo Errado, archiving) and
`relatorios.tour.spec.ts:75` and `:126` — and those two files fail identically
on `main` at `9f3b8807` (A/B run the same day). **Diagnosed 2026-10-04 without running a tour:**
`relatorios.tour.spec.ts:75` was the seed putting every conversation on one
day, and `follow-up.tour.spec.ts:126` was the tour archiving the first overdue
customer, who is the demo seed's Omie mock customer and not the tour's — see the
"Update 2026-10-04" sections of `runs/2026-09-10-relatorios.md` and
`runs/2026-09-10-follow-up.md`. **Still open:** `relatorios.tour.spec.ts:126`
(Rumo Errado). The empty cut it asserts is real — the report answers the 2019
window with an empty cut in 25–120 ms — so no data explains the red; the earlier
note puts it on a 5 s first-render timeout, suspected to be auth latency to the
remote Supabase. Not touched until a run with network timing on a local
Supabase can show where the time goes. The first run also failed
`conversas-services.tour.spec.ts:96` and `:140` and `servicos.tour.spec.ts:43`.
The second run passed them, so they read as first-run contention rather than a
defect. The disconnected config was green both times (2/2). **Orchestrator
ruling 2026-10-04:** the three reds belong to `main` and are out of scope for
`close-stated-coverage-gaps`. A separate task fixes those tours.

| Spec directory | Tour file | Reason | Last run |
| --- | --- | --- | --- |
| `accounts/auth` | `app-shell.tour.spec.ts`, `usuarios.tour.spec.ts` | Auto-login, the `/login` redirect, the team listing and the duplicate-e-mail refusal. Completing a create is out: the stack shares the project's Supabase. | 2026-09-10 |
| `channel/whatsapp-channel` | `conversas-channel-down.tour.spec.ts` | The disconnected refusals: composer absent with a Portuguese reason, the WhatsApp Web fallback pinned to the conversation's own number, and `Confirmar` disabled in the schedule dialog — with nothing written. **Run by `pnpm test:e2e:tours:disconnected`, not the main tour command.** The old reason here was wrong: the obstacle was never that the seed forces `CONNECTED`, it is that `channelStatus()` resolves the connection by the CONFIGURED instance name rather than by unit, so the state is a property of the API process and needs its own config. | 2026-09-16 |
| `conversations/conversas` | `conversas-inbox.tour.spec.ts`, `conversas-cadastro.tour.spec.ts`, `conversas-services.tour.spec.ts` | List, search, thread, send, tags, cadastro, vehicles, drill-ins. | 2026-09-10 |
| `conversations/follow-up` | `follow-up.tour.spec.ts`, `conversas-services.tour.spec.ts` | Counts, sections, card filter, links back, archiving, and the reminder form. | 2026-09-10 |
| `conversations/tags-templates` | `configuracoes.tour.spec.ts`, `conversas-inbox.tour.spec.ts` | Catalog create, refusals, deactivation, and the apply/filter path in the inbox. | 2026-09-10 |
| `customers/customer-vehicles` | `conversas-cadastro.tour.spec.ts` | Vehicle list and add-from-rail. | 2026-09-10 |
| `demo-seed` | manual only | A seeding capability with no screen of its own. Covered by the `packages/core` seed tests (`src/kernel/prisma`, `prisma/seed`). | — |
| `deploy` | manual only | Infrastructure; nothing to drive in a browser. | — |
| `design-system` | `app-shell.tour.spec.ts` | Palette switch, its persistence, and the garbage-id fallback. The token gallery at `/galeria` is not toured — it is a developer surface, not an attendant one. | 2026-09-10 |
| `design-system/mvp-screen-designs` | manual only | The canvas artboards, not the SPA: a design artifact reviewed against the PDF export, with no screen a tour could drive. The shipped screens it specifies are toured under their own rows. | — |
| `erp/omie-mock` | manual only | A test double. Its effect is visible wherever `OMIE_MOCK=1` is in force, which is every tour. | — |
| `erp/omie-sync` | `conversas-omie.tour.spec.ts` | The all-customers pendings panel, and resolving one field. Pins that the count is of FIELDS not customers — the fixture holds two conflicts on one customer, so resolving one moves the count, which a customer count would not — and that resolve is per-field: the other conflict stays open AND its column keeps the CRM value. Ingest that OPENS a pending is a function, not a route, so no browser reaches it. | 2026-09-16 |
| `module-boundaries` | manual only | Code structure — table ownership, import direction, slice shape. Enforced by ESLint boundaries, database grants and the per-slice integration tests; nothing to drive in a browser. | — |
| `plate-lookup/plate-lookup` | `conversas-cadastro.tour.spec.ts` | Mock hit and mock miss, both through the rail's add-vehicle form. | 2026-09-10 |
| `prefill/assistive-prefill` | `conversas-cadastro.tour.spec.ts` | The per-conversation extraction switch, **and ghost accept and dismiss**. The ghost needed no model: the seed writes the suggestion row directly, which is the product of an extraction rather than a simulation of one, so both tours run with `OPENAI_API_KEY` blank. Accept is pinned against the stored cadastro, refuse against it staying unset. | 2026-09-16 |
| `quotes/motul-client-resilience` | manual only | Provider-client behaviour. The tour stack cannot reach Motul by design, so a tour could only observe the refusal — which `conversas-oil-quote.tour.spec.ts` already does. | — |
| `quotes/motul-compatibility` | manual only | Catalog data, no screen. Reachable only through a quote with catalog rows the stack refuses to carry. | — |
| `quotes/motul-flatten` | manual only | Data transformation; unit-tested. | — |
| `quotes/motul-recommendation` | manual only | Needs live Motul data. See `conversas-oil-quote.tour.spec.ts`'s "Out of scope". | — |
| `quotes/oil-quote` | `conversas-oil-quote.tour.spec.ts` | Since background-oil-research the quote itself calls no provider: the incomplete identity (marca e versão), a researched car opening on its options with no polling, an uncached car `researching` with research not running, the per-vehicle targeting, the provider guard, **and the happy path** (close-stated-coverage-gaps 3.2): the four active cards offered and the inactive Lubrax Essencial not, the price before and after the oil-filter choice computed from the catalogue, an edited price kept, and the message carrying each card's price; since add-lubricant-oil-type (run `runs/2026-10-10-oil-quote-oil-type.md`) each card's pt-BR oil type against the seed and the message's name-with-viscosity and Tipo line, omitted for the untyped Ipiranga. The cached-row tour's no-provider guarantee is structural — the quote path calls no client — not the incomplete-identity accident the 2026-09 Correios tour relied on; the server-side evidence is `test/tour-provider-guard.test.ts`, which proves Motul and Tecfil are redirected to a loopback. **It is provider-free only while no worker shares the tour database:** opening the Kwid queues a research of it, and a dev worker pointed at the same database would run that research for real — web search, OpenAI and Tecfil, with that worker's env. `seed-e2e.ts` clears that research state each run. Still untoured, because each needs a worker running research live: a research under way, and the refetch POST completing. | 2026-10-10 |
| `quotes/oil-source-candidates` | manual only | An insert-only table of manual leads that the spec says is NOT shown to the attendant ("candidates are not shown to the attendant in this change"); covered by its module tests. | — |
| `quotes/oil-spec-web-search` | manual only | Runs in the worker's background research, never in a tour: the tour stack runs no worker and blanks `OPENAI_API_KEY`, and a live search would be paid, off-box traffic. Covered by the quotes module tests with the search client faked. | — |
| `quotes/tecfil-compatibility` | manual only | Catalog data, no screen. Same reasoning as `motul-compatibility`. | — |
| `quotes/tecfil-fitment` | manual only | Catalog data, no screen. | — |
| `repo-foundation` | `conversas-schedule.tour.spec.ts` | Its browser-facing requirement is the critical-attendant-flow coverage the worked example walks. | 2026-09-10 |
| `reports/relatorios` | `relatorios.tour.spec.ts` | Filters, regions, reaggregation, the clear control, the empty cut. | 2026-09-10 |
| `scheduling/scheduled-messages` | `conversas-schedule.tour.spec.ts` | Confirm-without-send, the occupied-service block, cancel. Due dispatch needs the worker and lives in `test/live/`. | 2026-09-10 |
| `services/customer-services` | `conversas-services.tour.spec.ts`, `servicos.tour.spec.ts` | Rail preview, vehicle and service drill-ins, and the standalone read-only screen. | 2026-09-10 |
| `services/vehicle-returns` | `conversas-services.tour.spec.ts`, `follow-up.tour.spec.ts` | The overdue return, its reminder, and archiving it off the queue. | 2026-09-10 |
| `shared-types` | manual only | A contract package; typecheck and unit tests are its coverage. | — |

## Browser tool on this machine

| What | Value |
| --- | --- |
| Preferred | Playwright MCP (`@playwright/mcp`), user scope for Claude Code and Cursor |
| Version at setup | MCP `0.0.80`, bundled Playwright `1.63.0-alpha-2026-08-31`, Chromium build `1243` |
| Fallback | Claude Code Browser pane. Under viewport emulation, click by explicit screenshot-frame coordinates: a `ref` click resolves to page-space coordinates and lands off-target. |

MCP tools attach when a session starts, so a session opened before the server was
added will not see them. If the first navigation fails with a missing browser
executable, install the Chromium build that the MCP's bundled Playwright pins.
