# Tour run — Relatórios (period filters, KPI bands, empty period)

## Feature

The manager's dashboard: the period and dimension filters, the six named
regions of metrics, the clear control that counts what it clears, and what the
screen does when the cut is empty.

Change under tour: `exploratory-tour-tests`, task 5.8 (retroactive coverage).
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
| Seed | task 5.2 extension; the unit now has one tag, so the `Tag` filter is enabled rather than disabled |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | A dashboard is read before it is used. Walking the default period through every region is what checks the screen a manager actually opens. |
| Colecionador | Turístico | This screen's whole purpose is several distinct outputs — six regions, three tables, two KPI bands, a funnel. Changing granularity and watching the period table reaggregate is the collector's version of "are these really different outputs, or one output drawn six times?" |
| Rumo Errado | Decadente | Ask for a period with nothing in it. A metrics screen's characteristic failure is answering zero when it means "no data", and that is a lie a manager acts on. |
| Período Chuvoso | Hoteleiro | Set a filter, change your mind, clear it. The screen must land exactly where it started, not somewhere that merely looks similar. |

Left out: Museu, Ator Coadjuvante, and the attribution-rule versioning
scenarios, which are API-level and have no control on this screen.

## Guidebook

From `openspec/specs/relatorios/spec.md`:

- Manager can open Relatórios from the app
- Changing granularity reaggregates
- Granularity day week month without double-count
- A set filter is distinguishable
- Clear appears only when something is set, and counts what it clears
- The clear control names the number of set filters
- Empty cut is not fake metrics
- The alert strip sits above the filters
- The strip survives an empty cut
- Sections are named, not parked behind a disclosure
- The corner mark explains the metric
- The period table sits behind the Leads mark

## Steps

### Tour Guiado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open `/relatorios` | All six regions rendered and named: `Alertas de follow-up`, `Indicadores principais`, `Funil de Vendas`, `Tabela de Origem`, `Atendimento e clientes`, `Tags e mensagens programadas` — each visible, none behind a disclosure | relatorios — Manager can open Relatórios; Sections are named, not parked behind a disclosure | succeeded |
| 2 | Read the filter row and the KPI band | Defaults `Início 2026-09-04`, `Fim 2026-09-11`, `Granularidade Dia`, `Origem/Tag/Campanha = Todas`; eight metric values rendered; **no** clear control anywhere | relatorios — Clear appears only when something is set | succeeded |
| 3 | Read the corner marks | Ten explainer controls, one per metric, each named `O que é <metric>` | relatorios — The corner mark explains the metric | succeeded |
| 4 | Activate `O que é Total de Leads` | The `Conversas por período` table appeared behind the mark, three daily rows: `08/09 4`, `09/09 1`, `10/09 1` | relatorios — The period table sits behind the Leads mark | succeeded |

### Tour do Colecionador

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 5 | Change `Granularidade` from `Dia` to `Mês` | The period table collapsed from **three** daily rows to **one** monthly row, `01/09 6` — and `6` is exactly `4 + 1 + 1`. `Total de Leads` stayed `6` across the change | relatorios — Changing granularity reaggregates; Granularity day week month without double-count | succeeded |

Step 5 is the non-vacuous one: the row count changes while the total does not,
which is what separates a genuine reaggregation from a re-render.

### Tour em Período Chuvoso

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 6 | Set `Origem` to `Anúncio` | A clear control appeared reading **`Limpar 1 filtro`** — naming the count, not just offering a reset. The KPI band moved: `Total de Leads 6 → 3`, `Taxa de Conversão 17% → 33%`, unanswered `2 → 1` | relatorios — A set filter is distinguishable; The clear control names the number of set filters; Origin filter narrows the cut | succeeded |
| 7 | Activate `Limpar 1 filtro` | `Origem` returned to `Todas`, the clear control disappeared, and every KPI returned to its step-2 value (`6`, `17%`, `2`) | relatorios — Clear appears only when something is set | succeeded |

Step 6's KPI movement is what makes step 7's restoration meaningful: the screen
demonstrably changed and demonstrably changed back.

### Tour do Rumo Errado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 8 | Set the period to `2019-01-01` → `2019-01-07`, a window with no data | **No metric cards rendered at all** — not a single zero. The screen said `Nenhuma conversa no recorte selecionado. Ajuste o período ou os filtros.` | relatorios — Empty cut is not fake metrics | succeeded |
| 9 | Read the alert strip during the empty cut | Still present above the filters, still reading `1 retornos vencidos · 0 orçamentos sem resposta · 2 mensagens aguardando resposta`, annotated `deste momento · não muda com os filtros abaixo` | relatorios — The alert strip sits above the filters; The strip survives an empty cut | succeeded |

Step 8 is the one worth having. A dashboard that prints `0` for an empty period
is indistinguishable from one reporting a real zero, and the difference is a
decision a manager makes. This screen refuses to draw the cards.

## Diagnosis

**The explainer marks are icon buttons.** Their visible text is `i`; the metric
name lives in `aria-label`. A text-based locator finds nothing, which briefly
looked like the marks being absent. The page object uses role-and-name, which is
what the accessibility tree actually exposes — and unlike the vehicle-row case
in `2026-09-10-conversas-cadastro.md`, here the `aria-label` *adds* the name
rather than replacing a visible one, so there is no Label-in-Name problem.

**The `Limpar` control does not count the period.** Changing `Início`/`Fim`
alone never produced a clear control; only `Origem` did. That is consistent with
the spec, which asks the control to count *set filters* against a period that
always has a value, but it is worth stating because "I changed something and no
clear appeared" reads like a bug for a moment.

**No console error and no 5xx** across the drive.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | none (defect) | No defect. The dashboard reaggregates without double-counting, narrows on a filter, names how many filters it will clear, restores exactly on clear, and refuses to invent metrics for an empty period. | — |
| 2 | surprise | The period is not counted among the filters the clear control offers to clear, so a manager who has narrowed only the dates has no one-click way back to the default window. Consistent with the spec as written; recorded in case the intent was otherwise. | Recorded. No scenario to pin against. |

### Update 2026-10-04 — Colecionador red, diagnosed from code and the scratch database

The Colecionador tour failed every run on `expect(dailyRows).toBeGreaterThan(1)`
(`periodRows` read 1). The screen is not at fault: the "Conversas por período"
table is still behind the Leads mark and reaggregates (the 2026-09-24 note that
the 2026-09-06 artboard revision removed it is wrong; the page and the spec
scenario "The period table sits behind the Leads mark" both still have it). The
fixture is at fault: `seed-e2e.ts` stamped every conversation's
`firstInboundAt` with the first run's `now`, only on create, so a fresh
database has ONE daily bucket and ONE monthly bucket, and an old one has none in
the default window. This drive saw `08/09 4, 09/09 1, 10/09 1` only because that
database had been seeded across three days. Fixed in the seed (`seed-novas.ts`,
three São Paulo days, written on update too) and pinned by `seed-novas.test.ts`;
the tour is unchanged.

## Transcribed to

`apps/e2e/test/tours/relatorios.tour.spec.ts` — all four tours, from the
succeeded steps above. Step 5 asserts that the daily row count exceeds the
monthly row count and that the KPI is unchanged, rather than asserting `3` and
`1`: the numbers are the fixture's, while "coarser granularity means fewer
buckets and the same total" is the contract. Step 6 likewise asserts that the
KPI *moved* and then *returned*, never the literal `6` or `3`.
