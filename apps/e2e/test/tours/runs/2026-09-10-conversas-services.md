# Tour run — Services, vehicle drill-ins, returns and reminders

## Feature

The service side of the contact rail — the services preview, the vehicle
drill-in and its per-vehicle history, the service drill-in — plus the vehicle
return those services produce and the reminder form that hangs off it on
Follow-up.

Change under tour: `exploratory-tour-tests`, task 5.5 (retroactive coverage).
Commit: `4efce05` plus the uncommitted tour harness and the task 5.1/5.2 page
objects and seed extension.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3101`, SPA `127.0.0.1:5175`, mock Evolution `127.0.0.1:18082` |
| Why not 3100/5174 | Port 3100 held all session by an orphaned tour API. Same guards on private ports; see `2026-09-10-app-shell.md`. |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, paid-provider credentials blanked |
| Worker | **not started** — reminders are written as scheduled messages and never fire |
| Database | per-worktree local Postgres on 5433 |
| Seed | task 5.2 extension: `E2E Turista` with `ABC1D23` (one service, one overdue return, one reminder) and `XYZ9K88` (deliberately no service) |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | Rail → vehicle → service is the drill-down an attendant makes to answer "when was this car last in", and nothing had walked it in a browser. |
| Colecionador | Turístico | This feature has several *distinct* outputs — a vehicle with history, a vehicle without, a service detail, a return, a reminder summary. Collecting one of each is what catches a screen that renders only the populated case well. |
| Rumo Errado | Decadente | The second vehicle has no services. Drilling into it must produce its own empty state and must **not** show the first vehicle's history. |
| Período Chuvoso | Hoteleiro | The reminder form commits scheduled messages. Abandoning it must leave the return exactly as it was. |

Left out: Museu, Ator Coadjuvante (the schedule dialog that shares this rail is
already covered by the worked example `conversas-schedule.tour.spec.ts`), and
archiving a return — that is the Follow-up tour's subject.

## Guidebook

From `openspec/specs/conversas/spec.md`:

- Two services appear in the preview with no ver todos
- Vehicle row opens the Veículo drill-in / Drill-in shows that vehicle's services only
- Back restores the profile stack
- No services is an empty state

From `openspec/specs/follow-up/spec.md`:

- The form opens without leaving Follow-up
- Prefill comes from the return
- Overdue return defaults ahead of today
- Blank body takes the composed default
- Criar lembrete stays available when reminders exist
- The planned summary updates without a reload

## Steps

### Tour Guiado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open `?conversation=e2e-conv-tour` | Rail listed `Serviços` with `22/02/2026 · Troca de óleo e2e retorno` and a `Programar mensagem` control; no `ver todos` at this count | conversas — Two services appear in the preview with no ver todos | succeeded |
| 2 | Activate the `ABC1D23` vehicle row | Drill-in replaced the rail: `Volkswagen Gol 2019 · ABC1D23`, `Ano 2019`, `Placa ABC1D23`, `Histórico de serviços` listing that one service | conversas — Vehicle row opens the Veículo drill-in | succeeded |
| 3 | Activate `← Voltar` | Profile stack returned intact — contact, tags, both vehicles, `Adicionar veículo`, services | conversas — Back restores the profile stack | succeeded |
| 4 | Activate the service row | Service drill-in: `Veículo Volkswagen Gol 2019 · ABC1D23`, `Quilometragem Não informado`, `Situação done`, `Origem Omie · OS e2e-omie-os-return`, `Itens Nenhum item lançado nesta OS`, `Orçamento de origem Nenhum orçamento atribuído a este serviço` | customer-services — the detail mirrors the OS and invents nothing | succeeded |

### Tour do Rumo Errado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 5 | Drill into `XYZ9K88`, the vehicle with no services | `Nenhum serviço registrado para este veículo`, and **no trace** of `ABC1D23`'s service anywhere in the drill-in | conversas — No services is an empty state; Drill-in shows that vehicle's services only | succeeded |

Steps 2 and 5 together are what make the scoping claim non-vacuous: one vehicle
has a service and the other does not, and each drill-in shows only its own.

### Tour do Colecionador

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 6 | Open `/follow-up` | Counts `Mensagens aguardando resposta 2`, `Orçamentos sem resposta 0`, `Retorno vencido 1`, `Retorno se aproximando 0`. The seeded return appeared under `Retorno vencido` as `E2E Turista · Gol · ABC1D23 · 19 dias em atraso · previsto 22/08/2026`, with the section subtitle `1 cliente · 1 veículo · mais atrasado primeiro` | vehicle-returns — an open, past-due return is vencido; follow-up — the heading names its ordering | succeeded |
| 7 | Activate `Criar lembrete` | Dialog opened **without leaving `/follow-up`**, headed `Criar lembrete`, naming `E2E Turista · Gol · ABC1D23` and `Retorno previsto 22/08/2026`; one notice row defaulted to `2026-09-11` at `09:00`; body empty; `+ Outro aviso` offered with the note `Cada aviso vira uma mensagem programada própria, com o texto já resolvido para o momento dela.` | follow-up — The form opens without leaving Follow-up; Prefill comes from the return; Overdue return defaults ahead of today | succeeded |

The default date is the day *after* the drive's today (2026-09-10), which is the
observable half of "overdue return defaults ahead of today" — the return itself
is 19 days past.

### Tour em Período Chuvoso

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 8 | Activate `Cancelar` on the reminder form | Dialog closed, still on `/follow-up`; the return row was unchanged and carried **no** reminder summary | Período Chuvoso — cancel mid-operation leaves no partial write | succeeded |
| 9 | Re-open the form and activate `Confirmar` with the body left **empty** | Dialog closed; the row gained `1 lembrete · próximo 11/09/2026` **without a reload**; `Criar lembrete` remained available; the return stayed listed under `Retorno vencido` | follow-up — Blank body takes the composed default; The planned summary updates without a reload; Criar lembrete stays available when reminders exist; Existing planned reminders do not hide | succeeded |
| 10 | Read the mock Evolution log | Still empty | the worker is not started, so a reminder is written and never sent | succeeded |

## Diagnosis

**The rail's service row carries no return date.** I went looking for the
vehicle return on the service drill-in and it is not there — the drill-in is
about the OS (vehicle, odometer, status, origin, items, source quote). The
return surfaces on Follow-up, which is where steps 6–9 went. Not a defect;
recorded because the task phrase "vehicle return date" reads as though the rail
shows one, and it does not.

**The seeded reminder does not count as a planned reminder.** The fixture
creates a `ReturnReminderMessage` with no scheduled messages, and before step 9
the row showed no `N lembrete` summary at all. That is consistent with the spec
— a reminder with nothing scheduled is not a *planned* one — and it is what made
step 9's appearance of `1 lembrete` a real change rather than an increment of
something already there.

**Confirming writes rows that accumulate.** Step 9 creates a scheduled message
per notice moment, and the row prints how many. Left alone, a second run would
read `2 lembretes` and any assertion on that summary would drift. Fixed in
`seed-e2e.ts` by clearing the tour customer's scheduled messages before the
reminder rows, and re-verified by re-seeding.

**No console error and no 5xx** across the drive.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | none (defect) | No defect. Drill-ins scope correctly, the empty vehicle states itself, the reminder form prefills from the return, defaults ahead of today, accepts a blank body, and updates the summary live. | — |
| 2 | tooling (mine) | Reminder confirms accumulate scheduled messages across runs and would drift the `N lembrete` summary. | Fixed in `seed-e2e.ts`; verified by re-seeding. |
| 3 | surprise | The `Retorno vencido` count read `1` here against `17` on the developer's own stack earlier in the session, on the same database. The seed does not delete demo returns, so the demo dataset's returns went away by some other route during the session. Not chased further: no tour asserts a literal count, precisely because these move. | Recorded. Worth knowing before anyone writes a test against a Follow-up count. |

## Transcribed to

`apps/e2e/test/tours/conversas-services.tour.spec.ts` — all four tours, from the
succeeded steps above. Step 9 asserts that a reminder summary *appears* where
there was none, not that it reads `1 lembrete · próximo 11/09/2026`: the date
comes from the clock and the count from the fixture, while "confirming adds one
and says so without a reload" is the behaviour.
