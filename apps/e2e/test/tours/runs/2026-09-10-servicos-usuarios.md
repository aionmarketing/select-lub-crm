# Tour run — Serviços (read-only) and Usuários (team and units)

## Feature

Two read-mostly screens toured in one session because each is small:
`/servicos`, the unit-wide list of Omie-owned service orders with its filters
and detail pane, and `/usuarios`, the team table with its unit editor and
create form.

Change under tour: `exploratory-tour-tests`, task 5.10 (retroactive coverage).
Commit: `4efce05` plus the uncommitted tour harness, the task 5.1/5.2 page
objects and seed extension, and the task 5.7 archive fix.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3101`, SPA `127.0.0.1:5175`, mock Evolution `127.0.0.1:18082` |
| Why not 3100/5174 | Port 3100 held all session by an orphaned tour API. Same guards on private ports; see `2026-09-10-app-shell.md`. |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, paid-provider credentials blanked |
| Worker | not started |
| Database | per-worktree local Postgres on 5433 |
| Seed | task 5.2 extension: the service `e2e-omie-os-return` on `E2E Turista` / `ABC1D23` |
| Constraint | **No Supabase account may be created.** The tour stack shares the project's Supabase, so the create form is driven only down its refusal path. |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | Both screens are things people read: find a service and read it; see who is on the team. Walking that is the whole guidebook. |
| Rumo Errado | Decadente | A search that matches nothing, and an e-mail that already exists. Both are refusals, and refusals are where read-mostly screens go wrong. |
| Período Chuvoso | Hoteleiro | The unit editor is the only write on Usuários that a tour may safely make. Opening it, changing a toggle and cancelling must leave the membership exactly as it was. |
| Desinteressado | Hoteleiro | Serviços claims to be read-only. The tour's job is to look for a write and fail to find one. |

Left out: Colecionador, Museu, and completing a user create — see the
constraint above. Also out: paging the service list, which needs more rows than
this seed carries.

## Guidebook

From `openspec/specs/customer-services/spec.md`:

- Standalone Serviços screen lists all customers' services
- Selecting a row shows its detail beside the list
- No search result is distinguished from an empty unit
- The screen offers no write

From `openspec/specs/auth/spec.md`:

- Users and units are listable for the Usuários screen
- List returns users with their memberships
- Units are named, not just identified
- No secret material is returned
- Duplicate e-mail is 409

## Steps

### Tour Guiado — Serviços

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open `/servicos` | Heading `Serviços`, a summary line of the shape `N serviços · R$ …`, four filters (`Cliente, placa ou OS`, `De`, `Até`, `Situação`) and a list of rows | customer-services — Standalone Serviços screen lists all customers' services | succeeded |
| 2 | Search `e2e-omie-os-return` | Narrowed to exactly one row: `22/02/2026 · E2E Turista · done · Volkswagen Gol 2019 · ABC1D23 · Troca de óleo e2e retorno` | customer-services — the search matches the OS number | succeeded |
| 3 | Select that row | Detail rendered beside the list, naming the customer, the vehicle, the status, `Origem Omie · OS e2e-omie-os-return`, its items block and its source-quote block | customer-services — Selecting a row shows its detail beside the list | succeeded |

### Tour do Desinteressado — Serviços

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 4 | Look for any way to change the service | None. The detail carries the note `Somente leitura — a OS é mantida no Omie`, and the only controls are the two navigation links and the list's own filters | customer-services — The screen offers no write | succeeded |

### Tour do Rumo Errado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 5 | Search `zzzz-nao-existe-servico` | Zero rows, summary `0 serviços · R$ 0,00`, and the explicit `Nenhum serviço para esses filtros` / `Ajuste a busca ou o período para ver outros serviços.` — copy that names the *filters* as the cause, distinguishing it from a unit with no services at all | customer-services — No search result is distinguished from an empty unit | succeeded |
| 6 | On `/usuarios`, submit the create form with the existing e-mail `attendant-a@selectlub.example` | Refused. The table stayed at four rows, no `Tour Duplicado` appeared, and the screen showed a `role="alert"` reading **`Não foi possível criar o usuário`** | auth — Duplicate e-mail is 409 | succeeded |

### Tour Guiado — Usuários

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 7 | Open `/usuarios` | Table `Usuários` with columns `Nome`, `E-mail`, `Unidades`, four rows, each naming its units by name and offering `Editar unidades`. No password, hash or token anywhere in the rendered rows | auth — Users and units are listable; List returns users with their memberships; Units are named, not just identified; No secret material is returned | succeeded |

### Tour em Período Chuvoso — Usuários

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 8 | Open `Editar unidades` on `Atendente A`, toggle the `Select Lub` chip, then activate `Cancelar` | Dialog `Unidades — Atendente A` closed; the row still read `Select Lub`, membership unchanged | Período Chuvoso — cancel mid-operation leaves no partial write | succeeded |

## Diagnosis

**Both navigation links on the Serviços detail go to a bare `/`.**
`Abrir conversa` and `Programar mensagem` are both hardcoded `to="/"`
(`apps/web/src/ServicosPage.tsx:408`), so neither carries the customer: an
attendant who found a service and wants its conversation lands on the unfiltered
inbox and must search again. Worth stating carefully, because the second one is
*defensible*: `conversas` — "Rail can schedule and cancel a message" enumerates
exactly three entry points to the schedule form and says "any entry point beyond
the three enumerated here SHALL be treated as a defect". Serviços is not among
them, so a `Programar mensagem` here that actually opened the form would be a
defect. Navigating to Conversas, where a legal entry point lives, is a
reasonable reading. Losing the customer on the way is the part that is hard to
defend, and `Abrir conversa` has no such excuse. Recorded as finding 1.

**Usuários shows a refusal; Configurações does not.** Step 6's duplicate e-mail
produced a real `role="alert"`. The duplicate *tag* in
`2026-09-10-configuracoes.md` produced nothing at all. So the alert pattern
exists in this codebase and is used on one screen and not the other — which
makes that report's finding 1 a consistency gap rather than a missing
capability.

**The database drifted under the session.** Serviços reported `34 serviços ·
R$ 13.200,00` early in the day and `7 serviços · R$ 0,00` by this drive, and the
Usuários rows moved from `+2 fora do seu acesso` to `+39`. Nothing in
`seedE2eFixtures` deletes demo services or creates units, so another process was
writing to the shared local database during the session. It changed no outcome
here — every tour in this batch asserts deltas and shapes rather than literals,
precisely so that it cannot — but it is the reason to keep doing that. Recorded
as finding 3.

**No 5xx.** The only console error across the drive was the expected 409 from
step 6.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | surprise (usability) | The Serviços detail's `Abrir conversa` and `Programar mensagem` both navigate to `/` with no customer or conversation, so the context found on this screen is dropped on the way. `Programar mensagem` is partly explained by the enumerated-entry-point rule; `Abrir conversa` is not. | No scenario states where these links should land, so nothing is pinned and no production code changed — pinning `to="/"` would freeze the behaviour, and changing it needs a spec decision about whether Serviços may carry a conversation target. Raised in this change's findings roll-up. |
| 2 | none (defect) | No defect on either screen. Serviços lists, searches, details and refuses to write; Usuários lists memberships by name with no secret material, refuses a duplicate e-mail, and leaves a membership untouched on cancel. | — |
| 3 | tooling / environment | The shared local database changed under the session from outside these tours. | Recorded. It is the standing argument for the delta-and-shape assertion style these tours use. |

## Transcribed to

`apps/e2e/test/tours/servicos.tour.spec.ts` and
`apps/e2e/test/tours/usuarios.tour.spec.ts` — two files, as task 5.10 asks,
from the succeeded steps above. Neither asserts a row count, a currency total or
a unit tally: finding 3 is exactly why. The Usuários file never completes a
create.
