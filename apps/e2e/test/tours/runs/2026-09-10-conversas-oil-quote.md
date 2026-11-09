# Tour run — Montar orçamento (oil quote) on a stack with no paid providers

## Feature

The oil-quote dialog opened from a vehicle on the contact rail: which vehicle it
opens for, what it shows when the catalog cannot supply options, and — the point
of touring it on this stack — that it reaches no paid provider to find out.

Change under tour: `exploratory-tour-tests`, task 5.6 (retroactive coverage).
Commit: `4efce05` plus the uncommitted tour harness and the task 5.1/5.2 page
objects and seed extension.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3101`, SPA `127.0.0.1:5175`, mock Evolution `127.0.0.1:18082` |
| Why not 3100/5174 | Port 3100 held all session by an orphaned tour API. Same guards on private ports; see `2026-09-10-app-shell.md`. |
| Provider guard | `OPENAI_API_KEY`, `GLM_API_KEY`, `PLACAS_TOKEN`, `OMIE_APP_KEY`, `OMIE_APP_SECRET` **blanked**; `OMIE_MOCK=1`, `PLACAS_MOCK=1` |
| Worker | not started |
| Database | per-worktree local Postgres on 5433 |
| Seed | task 5.2 extension. No `MotulCompatibility` or `CatalogItem` rows exist for either seeded vehicle — deliberately, since seeding them would mean seeding catalog data the tour stack must not fetch. |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | Open the quote from a vehicle and read what it says. On this stack the guidebook path *is* the unavailable path, and that is the one worth pinning: it is what an attendant sees whenever the catalog has nothing. |
| Correios | Negócio | This feature has four outbound integrations (Motul, Tecfil, OpenAI, GLM). The Correios tour watches the boundary: with every credential blanked, the question is whether the screen degrades or reaches out anyway. |
| Ator Coadjuvante | Entretenimento | Each vehicle row has its own `Montar orçamento`, all in one rail. The risk is the dialog opening for the wrong car — invisible when a customer has one vehicle, obvious when they have two. |
| Período Chuvoso | Hoteleiro | The dialog's only exit on this path is `Fechar`. Closing must leave the rail intact and write nothing. |

Left out: Rumo Errado (with no cards there is no illegal ordering to attempt),
Colecionador (there is one output on this stack, not several), and Museu.

## Guidebook

From `openspec/specs/oil-quote/spec.md`:

- No compatible item is an empty state
- Unset GLM key does not invent a spec
- Missing motor liters is a Portuguese failure

From `openspec/specs/conversas/spec.md`:

- Each vehicle offers Montar orçamento — Trigger opens the quote for the clicked vehicle

## Steps

### Tour Guiado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open `?conversation=e2e-conv-tour` and activate `Montar orçamento` on `ABC1D23` | Dialog opened, titled `Montar orçamento — Volkswagen Gol 2019 · ABC1D23` | conversas — Each vehicle offers Montar orçamento | succeeded |
| 2 | Read the dialog body | Exactly one line, in Portuguese: `Não há especificação Motul para este veículo. Nenhuma opção é exibida.` No cards, no prices, no invented litreage; the only control is `Fechar` | oil-quote — No compatible item is an empty state; Unset GLM key does not invent a spec | succeeded |

### Tour dos Correios

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 3 | Grep the API log for provider hosts and read the mock Evolution log | Exactly one request, `GET /vehicles/e2e-veh-a/quote-options`. **Zero** matches for `motul.`, `tecfil.`, `openai.com`, `api.z.ai`, `bigmodel` or `glm`. Evolution log empty. | oil-quote — the quote is assembled from the catalog, and a blanked key is a refusal rather than a call | succeeded |

### Tour do Ator Coadjuvante

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 4 | Close, then activate `Montar orçamento` on the **second** vehicle `XYZ9K88` | Dialog titled `Montar orçamento — Volkswagen Saveiro 2021 · XYZ9K88` — the clicked car, not the first one — with the same Portuguese refusal | conversas — Trigger opens the quote for the clicked vehicle | succeeded |

Steps 1 and 4 are the pair that makes this non-vacuous: two vehicles, two
titles, each matching the row that was activated.

### Tour em Período Chuvoso

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 5 | Activate `Fechar` | Dialog closed; the rail returned intact with both vehicles, their quote triggers, and the services block; no quote row was written | Período Chuvoso — leaving mid-operation writes nothing | succeeded |

## Diagnosis

**The message is about the Motul specification, not about a missing key.** Task
5.6 anticipated "the spec's no-key error in Portuguese". What the screen
actually says is `Não há especificação Motul para este veículo.` — the catalog
has no `MotulCompatibility` row for a 2019 Gol or a 2021 Saveiro, so the refusal
happens before any key is needed. The outcome the spec cares about is the same
(a Portuguese statement, no cards, nothing invented), but the reason differs and
the transcribed tour says so rather than claiming to have exercised the no-key
branch.

**The happy path is untoured, and cannot be toured on this stack.** Cards,
editable prices, and the assembled message (`Cards carry editable prices and
assemble the message live`, `Message numbers options in chosen order`, `Price
edit stays in the quote`) all need `MotulCompatibility` and `CatalogItem` rows
for the vehicle. Seeding those would mean seeding the catalog the guard exists
to keep out, and asserting against a fixture catalog would tell us about the
fixture rather than about Motul. Named explicitly in the spec header and in the
coverage ledger so the gap is visible.

**The seeded `OilQuote` snapshot is not surfaced by this screen.** The seed
writes a quote header for the tour customer, and nothing on the rail renders it:
the rail's blocks are contact, tags, vehicles, services, scheduled messages and
the prefill switch. A stored quote shows through a service's `Orçamento de
origem` and through Follow-up's `Orçamentos sem resposta`, neither of which
attributes this one. Not a defect — no scenario says the rail lists past quotes.

**A near-miss worth naming: the transcription nearly reported an app defect that
was mine.** The first run of the Ator Coadjuvante spec opened the *Saveiro's*
quote when asked for the Gol's, which reads exactly like "the trigger opens the
wrong vehicle" — the very defect this tour exists to catch. It was the locator:
scoping with `filter({ hasText: plate })` matches every ancestor up to the rail,
and the Veículos block contains both vehicles' triggers, so the filter returned
a sibling's button. The live drive had clicked positionally and seen the correct
titles, which is what said the app was right and the spec was wrong. Fixed by
scoping to the innermost element containing both this plate's row control and a
quote trigger. Had the drive not already established the app's behaviour, this
would have been reported as a defect.

**No console error and no 5xx** across the drive.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | none (defect) | No defect. The quote refuses in Portuguese, shows no cards, invents no litreage, opens for the clicked vehicle, and reaches no provider. | — |
| 2 | coverage gap | The quote's whole happy path — cards, price editing, message assembly — is unreachable on a stack whose guard is the point. It needs a catalog fixture, and that is a decision about what the tour stack is allowed to contain, not something to settle inside a tour. | Named in the spec header's "Out of scope" and in the coverage ledger. Raised in this change's findings roll-up for the spec owner. |

## Transcribed to

`apps/e2e/test/tours/conversas-oil-quote.tour.spec.ts` — all four tours, from
the succeeded steps above. The refusal is asserted as the exact Portuguese
sentence because that copy *is* the specified behaviour ("a Portuguese
failure"), while the dialog titles are asserted as "contains the clicked
vehicle's plate" rather than as the full make-model-year string.
