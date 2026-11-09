# Tour run — Conversas cadastro rail (contact, vehicles, plate lookup, prefill switch)

## Feature

The contact rail beside an open thread: click-to-edit cadastro fields, the
vehicle list and its add form, the plate lookup that fills a vehicle's identity,
and the switch that opts a conversation into cadastro extraction.

Change under tour: `exploratory-tour-tests`, task 5.4 (retroactive coverage).
Commit: `4efce05` plus the uncommitted tour harness and the task 5.1/5.2 page
objects and seed extension.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3101`, SPA `127.0.0.1:5175`, mock Evolution `127.0.0.1:18082` |
| Why not 3100/5174 | Port 3100 held all session by an orphaned tour API. Same guards on private ports; see `2026-09-10-app-shell.md`. |
| Provider guard | `PLACAS_MOCK=1` (in-process canned dataset, never HTTP), `OMIE_MOCK=1`, `OPENAI_API_KEY`/`GLM_API_KEY` blanked |
| Worker | not started |
| Database | per-worktree local Postgres on 5433 |
| Seed | `seedE2eFixtures()` with the task 5.2 extension: `E2E Turista` with vehicles `ABC1D23` and `XYZ9K88` |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | The rail's whole job is editing a cadastro without leaving the conversation, and no browser test had walked edit → save → vehicle add in one pass. |
| Correios | Negócio | The plate lookup is this screen's one outbound integration. The Correios tour follows data in and out of a system boundary — here, plate in, identity fields out, and the question of whether anything actually left the box. |
| Rumo Errado | Decadente | A plate the provider does not know. The screen must say so and stay usable rather than hang or invent a car. |
| Período Chuvoso | Hoteleiro | The prefill switch is per-conversation state that must survive a reload, and turning it on must not itself write a cadastro. |

Left out: Colecionador (deferred to the services and quote tours, which have the
several-outputs shape), Museu, and the Omie reconciliation pendings — the seeded
customer is CRM-origin, so no pending is reachable from this fixture.

## Guidebook

From `openspec/specs/conversas/spec.md`:

- Rail is read-only until Editar is clicked
- Editar reveals inputs in place
- Unlinked shared field persists without Omie
- Two vehicles appear on the rail
- Add vehicle from the rail
- Add does not send WhatsApp
- Default off / Toggle persists for that conversation / Turning on does not write cadastro

From `openspec/specs/plate-lookup/spec.md` — the mock path and the
not-found path.

## Steps

### Tour Guiado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open `?conversation=e2e-conv-tour` | Rail rendered read-only: `E2E Turista`, `11999000005`, `País: BR`, tag chip, **both** seeded vehicles, the seeded service, `Nenhuma mensagem programada` | conversas — Rail is read-only until Editar is clicked; Two vehicles appear on the rail | succeeded |
| 2 | Activate `Editar` | Inputs appeared in place, name field (`conversas-cadastro-name`) pre-filled `E2E Turista`, `Salvar` offered | conversas — Editar reveals inputs in place | succeeded |
| 3 | Change the name to `E2E Turista Editado`, activate `Salvar` | Rail returned to read-only showing the new name; no Omie call and no error | conversas — Unlinked shared field persists without Omie | succeeded |

### Tour dos Correios

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 4 | Activate `Adicionar veículo` | Dialog `Adicionar veículo` opened with Placa, Marca, Modelo, Versão, Ano, Quilometragem, and the note `O espelhamento de veículo no Omie ainda não foi confirmado (GitHub #29). O veículo é gravado no CRM.` | conversas — Add vehicle from the rail | succeeded |
| 5 | Type plate `DEF2E34` and blur the field | Lookup ran and filled `Marca HONDA`, `Modelo CIVIC`, `Ano 2001`, each marked `Atualizado pela placa` with a `Usar … da placa` toggle. `Versão` stayed empty — `DEF2E34` is the dataset's deliberately version-less row | plate-lookup — a mock hit fills the identity fields **[corrected 2026-09-16: it was NOT a mock hit. `HONDA CIVIC 2001` is the real registered vehicle; the canned dataset says `HONDA FIT 1.5` 2019. This drive reached the live, credit-metered APIBrasil — the tour config blanked `PLACAS_TOKEN`, which nothing reads, while `resolvePlacasAccess` reads `APIBRASIL_BEARER_TOKEN` and resolves credentials before the mock opt-in. `plate_lookup_call` holds the billed hop at 12:36:32.930Z. The step still succeeded and the scenario it cites still holds — what is wrong is the attribution of the source. Credential fixed in f6addf6; the spec now pins the canned values, and the seed deletes the cache row.]** | succeeded |
| 6 | Activate `Salvar veículo` | Dialog closed; the rail listed a third vehicle, `DEF2E34` | conversas — Add vehicle from the rail | succeeded |
| 7 | Read the mock Evolution log and grep the API log for provider hosts | Evolution log empty; two `/plate-lookups` requests recorded; **zero** matches for `apibrasil`, `placas.com` or `api-placas` | conversas — Add does not send WhatsApp; plate-lookup — the mock never calls HTTP | succeeded |

### Tour do Rumo Errado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 8 | Type plate `TES7T01` (absent from the canned dataset) and blur | The screen stated `A consulta não devolveu dados para esta placa.` and offered `Consultar de novo`; the identity fields stayed empty rather than being invented; the form remained usable | plate-lookup — a miss is stated, not guessed | succeeded |

### Tour em Período Chuvoso

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 9 | Read the `Sugerir dados do cliente` switch | Present at the bottom of the rail stack and **off** | conversas — Switch sits at the bottom of the stack; Default off | succeeded |
| 10 | Turn it on | Switch on; the cadastro name was still `E2E Turista Editado` and no extraction began | conversas — Turning on does not write cadastro | succeeded |
| 11 | Reload the conversation | Switch still on | conversas — Toggle persists for that conversation | succeeded |

## Diagnosis

**The plate lookup is a blur lookup, and that cost a step.** Filling the plate
field and waiting produced nothing; the field's handler is `onBlur`
(`apps/web/src/conversas/vehicle-plate-fields.tsx:192`). Playwright's `fill()`
does not blur, so the first attempt looked like a dead integration and was not.
Tabbing out ran it. The transcribed spec blurs explicitly for the same reason —
a spec that only fills would assert against a lookup that never happened.

**The vehicle dialog is portalled outside `main`.** An early read scoped to the
`main` landmark reported "no form appeared" when the dialog was in fact open at
the document root. Nothing to fix in the app — MUI dialogs are portals — but the
page object locates it from the page, not from `main`.

**Accept and dismiss of prefill ghosts were not reachable.** Task 5.4 names them,
but a ghost needs a `CadastroPrefillSuggestion` row, which is produced by an AI
extraction, and the tour stack blanks `OPENAI_API_KEY` and `GLM_API_KEY` on
purpose. Turning the switch on is therefore as far as this stack goes; the
ghosts' accept and dismiss remain untoured and are named as such in the spec
header. Seeding a suggestion row directly would make the tour assert against a
fixture rather than against the extraction that produces one, so I did not.

**No console error and no 5xx** across the drive.

**Transcription found what the drive could not: the vehicle row's accessible
name does not contain its visible label.** Locating the row by role and name
failed. The row renders `ABC1D23 ›` but carries
`aria-label="Ver Volkswagen Gol 2019"`, and an `aria-label` *replaces* the text
for name computation — so the plate, which is what the row visibly leads with
and what an attendant reads, is absent from the accessible name. Recorded as
finding 4. The page object matches on rendered text instead.

**The prefill switch is a controlled MUI switch, and driving its input lies.**
While diagnosing a failing assertion I toggled the hidden `input` directly and
watched `checked` go `false → true → false` with **zero** PATCH requests: the
native checkbox flips while React's handler never runs, so the DOM reports a
toggle that was never persisted. Clicking the *label* — what the live drive did
— fires the PATCH. The transcribed tour clicks the label and then confirms the
flag through `GET …/prefill`, which is a stronger oracle than reloading and
believing the checkbox, because the switch flips optimistically.

**`GET …/prefill` was requested 340 times during the drive.** That is a refetch
cadence on an idle screen, not a leak, and no scenario forbids it. Noted as
finding 5 in case it is unintentional.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | none (defect) | No defect in the cadastro rail. Edit, save, vehicle add, plate hit, plate miss, and the prefill switch all behaved as specified. | — |
| 2 | tooling (mine) | The vehicles tour adds a car, so re-running it grew the customer by one vehicle per run and would have drifted any "two vehicles" assertion. Fixed in `seed-e2e.ts` with a `deleteMany` scoped to this customer and to rows the fixture does not own. | Fixed in the seed; verified by re-seeding. |
| 3 | coverage gap | Assistive-prefill ghost accept and dismiss are unreachable on a stack with no AI key. | Named in the spec header's "Out of scope" and in the coverage ledger, so the gap is visible rather than silently absent. |
| 4 | defect — fixed (accessibility) | The vehicle row's `aria-label="Ver <make> <model> <year>"` replaces its visible label, so the plate the row leads with (`ABC1D23`) is not in its accessible name. A speech-input user saying "Ver ABC1D23" cannot activate it, and a screen-reader user never hears the plate — which is the field that distinguishes one of this customer's three cars from another. This is the WCAG 2.5.3 *Label in Name* shape. Both variants are affected: `vehicles.rail-row.cursor.tsx:46` and `vehicles.rail-row.antigravity.tsx:64`. | **Fixed 2026-09-12**, once the owner settled the wording question that was blocking it — by deciding there should be no wording at all. The `aria-label` is REMOVED from both variants rather than reworded, so the accessible name falls back to the row's visible text and the two can no longer drift apart. That is why this needed an owner: rewording would have invented a requirement no scenario states, whereas deleting the override just stops the component overriding what it already displays. The chevron stays `aria-hidden`. **Pinned** by `apps/web/src/conversas/vehicles.rail-row.a11y.test.tsx`, now six executing cases (both variants × name-contains-plate, no-control-named-without-the-plate, and a plate-less vehicle still having a non-empty name) — restoring the `aria-label` turns two of them red. Six assertions in `ConversasPage.veiculo.test.tsx` and `ConversasPage.prefill-switch.test.tsx` that located the row by `"Ver Toyota Corolla 2019"` now use the plate, which is what a person actually sees. |
| 5 | surprise | `GET /conversations/:id/prefill` was requested **340 times** across the drive on an otherwise idle screen. No scenario forbids it and nothing failed; flagged only in case the cadence is unintentional. | Recorded here. |

## Transcribed to

`apps/e2e/test/tours/conversas-cadastro.tour.spec.ts` — all four tours, from the
succeeded steps above. Step 5 asserts that the identity fields become non-empty
and are flagged as plate-sourced, not that they read `HONDA`/`CIVIC`: the canned
value belongs to the fixture, while "a hit fills the fields" is the behaviour.
