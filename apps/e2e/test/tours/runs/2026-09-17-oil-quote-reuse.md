# Tour run — Oil quote, reuse path (the happy path the ledger called untoured)

## Feature

`Montar orçamento` on a vehicle whose specification is already cached: the reuse
prompt, the oil cards, the Tecfil filter slots, the computed totals and the
assembled message — with no provider reached at any point.

Change under tour: `close-stated-coverage-gaps`, section 6 (tasks 6.1 and 6.2).
Base: main at `737a555`, which carries the base-URL seam (#83) and the
`classification` fix (#86).

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Stack | API `127.0.0.1:3100`, SPA `127.0.0.1:5174` |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, every provider credential blanked, **and** `MOTUL_BASE_URL` / `TECFIL_BASE_URL` pointed at `http://127.0.0.1:9/dead` |
| Worker | not started |
| Database | per-worktree local Postgres |
| Seed | task 6.1: plate-less Volkswagen / Polo / `1.0 TSI` / **2021**, with BOTH a `MotulCompatibility` and a `TecfilCompatibility` row |

**The dead loopback is belt to the braces, not the guard.** The guard under test
is structural: `mode=reuse` returns before any provider is reached. The loopback
exists so that if the drive had slipped onto the fresh-resolve path, it would
have failed against a closed port instead of reaching production — and it gives
the negative below a sharper edge, because an *attempt* would have logged.

## Tours

- **Guiado (Negócio)** — the attendant's path: open the quote on a vehicle that
  has been quoted before, take the saved data, read the options, read the
  message that gets sent.
- **Correios (Negócio)** — four outbound integrations sit behind this screen.
  Does taking the saved data reach any of them?
- **Colecionador (Turístico)** — count the cards, and check the arithmetic on
  the one number the customer actually sees.

## Guidebook

- `openspec/specs/oil-quote/spec.md` — a cached specification is offered for
  reuse; cards carry editable prices and assemble the message live; the message
  numbers options in the chosen order.
- `openspec/specs/motul-compatibility/spec.md`, `tecfil-fitment` — a cached
  compatibility answer is reused rather than re-fetched.

## Steps

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | `GET /vehicles/:id/quote-options` with no `mode` | `reuse_prompt`, `motulConsultedAt` AND `tecfilConsultedAt` both non-null | oil-quote — a cached specification is offered for reuse | succeeded |
| 2 | Open the rail and read the vehicle | Listed as `Volkswagen Polo 2021` — it has no plate, so it is labelled by identity | customer-vehicles — a vehicle is identified to the attendant | succeeded |
| 3 | Activate `Montar orçamento` on that row | Dialog `Montar orçamento — Volkswagen Polo 2021`: "Já existe uma consulta salva para este veículo, feita em 17/09/2026", with `Motul: 17/09/2026 — Tecfil: 17/09/2026` and two choices, `Usar dados de 17/09/2026` and `Buscar novamente` | oil-quote — a cached specification is offered for reuse, naming when | succeeded |
| 4 | Activate `Usar dados de …` | `Usando dados salvos em 17/09/2026 — nenhuma nova chamada à Motul`. Grades line: `Viscosidades aceitas: 0W-20 ou 5W-40 ou 0W-40 ou 5W-30 — volume de troca 4 L`. Source line cites CarroRac and the page | oil-quote — reuse states it is reusing and cites the source | succeeded |
| 5 | Read the cards | **Four**: Motul 8100 Eco-nergy, Lubrax Tecno, Motul 8100 X-cess, Ipiranga F1 Master. The inactive `cat-lubrax-essencial-5w30` is **not** offered | oil-quote — active catalogue items matching a listed grade are offered | succeeded |
| 6 | Read the filter slots | `Filtro de óleo` offers `Authomix Filtro de óleo FOL0545 · R$ 33,50`, and the breakdown names `Tecfil: VOLKSWAGEN POLO 1.0 12V 128cv` — the cached fitment | tecfil-fitment — a cached fitment is reused | succeeded |
| 7 | Read one card's arithmetic | `Óleo R$ 52,90/L × 4 L = R$ 211,60 + filtro de combustível R$ 45,00` | oil-quote — price is computed against the service fill | succeeded |
| 8 | Read the assembled message | Four numbered options with totals R$ 364,60 / 256,60 / 344,60 / 272,60. Lubrax checks out: 52,90 × 4 = 211,60, + 45,00 = 256,60 | oil-quote — the message numbers the options in order | succeeded |
| 9 | Grep the API process output for the whole drive | Across **4** captured `quote-options` requests: **0** lines naming Motul or Tecfil, **0** naming `gateway-apim` or `catalogoexpresso`, **0** naming the dead loopback, **0** HTTP 500s | oil-quote — a cache hit reaches no provider | succeeded |

## Diagnosis

**The guard here is structural, and that is the point of the section.** The
existing `Tour dos Correios` in `conversas-oil-quote.tour.spec.ts` asserts that
nothing leaves for Motul and passes only because its vehicle's identity is too
incomplete to resolve — an accident of the fixture. This path passes because
`loadQuoteOptions` returns before the provider is reached. The vehicle here has a
COMPLETE identity, which is what makes the two cases distinguishable: on the
fresh-resolve path this same vehicle would reach the client.

**Step 9's zero is sharper than a plain absence.** Both base URLs pointed at a
closed port, so an attempted call would have produced a connection error in the
same log. Zero lines means no attempt was made, not that an attempt quietly
succeeded elsewhere.

**Both cache halves were needed, and the screen says so.** The Tecfil slots come
back as `cached` and name the cached vehicle labels. With only the Motul row
seeded, the cards would render identically while Tecfil was called live — the
positive signal is the same either way, which is why task 6.1 pins the year at
2021, the only year with both rows.

**The `classification` fix is confirmed end to end, not just in a unit test.**
This exact request returned HTTP 500 before #86: the cached spec carries
`classification: ""`, truthfully, because the cited CarroRac page states grades
and capacity but no API/ACEA class, and the response schema used to demand at
least one character. It now returns 200, and the UI omits the classification
from the grades line rather than printing an empty one.

**No defect found.**

## Why the transcribed tour does not grep the API log

Task 6.3 asked for the negative to be proved by grepping the API process output.
**That is possible in the manual drive and not from inside the tour**, and the
difference is worth stating so nobody tries to restore it:

- In the drive above I start the API myself and redirect its output to a file, so
  I can grep it. That is where step 9's numbers come from.
- The tour runs the API as a Playwright `webServer`. That process's stdout is not
  piped anywhere the test process can read, and piping it means editing
  `tours-config.shared.ts` — which is another session's lane while the
  e2e-dedicated-database work is in flight.

So the transcribed tour uses a different server-side negative, and it is a
stronger one because it does not depend on logging at all: **reusing writes no
new compatibility row.** `insertCompatibility` runs ONLY on the fresh path, so a
`consultedAt` that has not moved is evidence the provider was never consulted.
A log line can be absent because nothing logged; a row that did not appear cannot.

## Why the closed port makes step 9 a positive check

Pointing `MOTUL_BASE_URL` and `TECFIL_BASE_URL` at `http://127.0.0.1:9/dead`
during the drive is what turns "no provider lines" from an absence check into a
positive one. Nothing listens on that port, so an attempted call fails and logs a
connection error in the same capture. Zero lines therefore means **no attempt was
made**, rather than "an attempt was made and nothing recorded it" — which is the
reading an absence check can never rule out.

The same shape as every other two-sided check in this change: arrange for the
thing you fear to leave a mark, then show the mark is absent.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | confirmation | The reuse path reaches no provider, with a structural guarantee rather than a fixture accident. Measured server-side across 4 requests, with attempted calls made detectable by a dead loopback. | Pinned by the tour transcribed below. |
| 2 | confirmation | #86's fix works through the full stack: an empty `classification` now serialises, and the UI omits it rather than printing a blank. | Pinned by task 6.4's reference to the API-level test that shipped with the fix. |
| 3 | note | `Buscar novamente` is one click away from this dialog and IS the live path for a complete-identity vehicle. The fixture comment says so; the tour must never take it. | Recorded in `seed-e2e.ts` beside the fixture and in the tour's header. |

## Transcribed to

`conversas-oil-quote.tour.spec.ts` — task 6.3. Only the steps marked succeeded,
each `expect` citing the scenario named in its row.
