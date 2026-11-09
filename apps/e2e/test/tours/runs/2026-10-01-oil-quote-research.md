# Tour run — Oil quote after background-oil-research (task 5.5)

## Feature

`Montar orçamento` once the quote calls no provider (background-oil-research
D15, D17): a car with missing identity fields, a car with both cache rows, and a
complete car with no cache row, on a stack with no worker.

Change under tour: `background-oil-research`, PR 5b (tasks 5.2–5.5). Base: main
at `d7aad649`.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP**, role-based snapshots |
| Stack | API `127.0.0.1:3100`, SPA `127.0.0.1:5174` (`cursor` variant), mock Evolution `18081` |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, `OPENAI_API_KEY`, `GLM_API_KEY`, `APIBRASIL_BEARER_TOKEN`, Omie keys blanked |
| Worker | not started, so research reads `paused: stopped` (D15 rule 1: no runner row) |
| Database | the worktree's own e2e database on local Compose (`…_e2e`), provisioned and seeded by `seed-e2e.ts` |
| Seed | vehicle A: Gol 2019 with no make and no version; Polo 2021 with its Motul and Tecfil rows; **new** Renault Kwid `1.0 SCe Intense` 2023, complete, no cache row |

## Tours

- **Guiado (Negócio)** — the three cars an attendant meets.
- **Correios (Negócio)** — does opening any of them reach Motul, Tecfil, OpenAI or GLM?
- **Ator Coadjuvante / Período Chuvoso** — unchanged from the 2026-09-10 run.

## Guidebook

`openspec/changes/background-oil-research/specs/quotes/oil-quote/spec.md` and
`…/conversations/conversas/spec.md` (scenarios named per step).

## Steps

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open Conversas on `e2e-conv-tour`; read Veículos | Four rows: `ABC1D23`, `XYZ9K88`, `Volkswagen Polo 2021`, `Renault Kwid 2023`, each with `Montar orçamento`; no research line on any | conversas — each vehicle offers Montar orçamento | succeeded |
| 2 | `Montar orçamento` on `ABC1D23` | Title `Montar orçamento — Gol 2019 · ABC1D23`; the one `status`: "Para pesquisar o lubrificante, complete os dados do veículo: marca e versão."; no `Buscar novamente` | oil-quote — An incomplete identity names what is missing | succeeded |
| 3 | `Fechar`, then `Montar orçamento` on the Polo | `status`: "Dados consultados em 01/10/2026." beside `Buscar novamente`; spec line, CarroRac source, oil filter chooser, four cards, message; no "Buscando dados novos", no `timer`, no reuse prompt | oil-quote — A verified identity opens on its options | succeeded |
| 4 | Wait 5 s; list network requests | One `GET …/e2e-veh-quote-polo/quote-options`, no second read | oil-quote — A cached identity with no research record starts nothing (stops refreshing) | succeeded |
| 5 | `Fechar`, then `Montar orçamento` on the Kwid | `status`: "A pesquisa automática não está rodando agora; o pedido fica na fila."; `timer`: "Na fila há 0 s"; no range | oil-quote — No worker running is said plainly | succeeded |
| 6 | Close, reopen the Kwid about 20 s later | `timer`: "Na fila há 23 s" — counted from `requestedAt`, not from the reopening | oil-quote — Reopening does not reset the time | succeeded |
| 7 | Read the counter over 2.5 s with `evaluate` | 36 s → 39 s | D17 — ticking every second | succeeded (see finding 1) |
| 8 | Read the Kwid's rail row with the dialog closed | No "Pesquisando lubrificante…" | conversas — Research not running shows nothing | succeeded |

## Findings

1. **Not a defect: the counter looked frozen in two snapshots 3 s apart.** Two
   accessibility snapshots of the open dialog both read "Na fila há 23 s". Read
   inside one `evaluate` call the timer moved 36 s → 39 s, and the spec run
   below sees it tick. The MCP browser throttles timers while the page is idle
   between tool calls; the app's `setInterval` is correct. Recorded so the next
   drive does not chase it.
2. **Seed change with reach beyond this tour.** Vehicle A lost its make, so the
   rail's service row reads `Gol 2019` and Follow-up's return row reads
   `Gol · ABC1D23`. The other Conversas, Serviços and Follow-up tours pass with
   it (run below). The Follow-up "Rumo Errado" tour (archiving) failed on both
   arms, with the old make restored too, so it is not this change.
3. No request reached an off-box provider in any step. That holds because the
   tour stack runs no worker: opening the Kwid queues a research of it, which a
   dev worker on the same database would run for real (review of #196). The
   seed now clears both complete identities' research state, and the Kwid's
   caches, every run.

## Transcribed

`conversas-oil-quote.tour.spec.ts`: three Guiado tours (steps 2, 3–4, 5 and 8),
Correios (no off-box host across the three opens, the Polo's row unchanged with
no `refresh`, the Kwid `researching` + `stopped` over the API), and the
unchanged Ator Coadjuvante and Período Chuvoso tours. The reuse tours and
`quoteReuse()` are gone; the page object gains `quoteStatus()` and `quoteTimer()`.

## Spec run

`node run-tours.mjs test/tours/conversas-oil-quote.tour.spec.ts`: **6 passed**.
Neighbouring tours on the same seed: `conversas-cadastro` + `conversas-services`
10 passed; `conversas-services` + `follow-up` 7 passed, 1 failed (Follow-up
"Rumo Errado", failing on both arms as above). A first combined run of cadastro,
services, serviços and follow-up showed two more services failures that did not
reproduce in two later runs.
