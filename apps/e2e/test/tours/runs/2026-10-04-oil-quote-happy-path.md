# Tour run — Oil quote happy path: cards, a price edit, the assembled message

## Feature

`Montar orçamento` on the seeded Polo 2021 — the identity whose Motul and
Tecfil cache rows the tour seed writes — walked past "it opens" to what an
attendant does next: choose an oil filter, edit a price, read the message.

Change under tour: `close-stated-coverage-gaps`, task 2.2. Base: main at
`9f3b8807` plus this branch (`claude/coverage-gaps-resume`).

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP**, role-based snapshots |
| Stack | API `127.0.0.1:3100`, SPA `127.0.0.1:5174` (`cursor` variant), mock Evolution `18081`, started by hand with the tour env |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`; `OPENAI_API_KEY`, `GLM_API_KEY`, `APIBRASIL_BEARER_TOKEN` and the Omie keys blank; **`MOTUL_BASE_URL` / `TECFIL_BASE_URL` = `http://127.0.0.1:9/tour-guard/{motul,tecfil}`** (new, task 1.2) |
| Worker | not started |
| Database | the worktree's own e2e database on local Compose (`…_e2e`), provisioned and seeded by `run-tours.mjs` immediately before |
| Catalogue | demo seed (`catalog-seed.ts`): 5W-30 Motul 8100 Eco-nergy 79,90/L, Lubrax Tecno 52,90/L; 5W-40 Motul 8100 X-cess 74,90/L, Ipiranga F1 Master 56,90/L; **inactive** Lubrax Essencial 5W-30; oil filters PSL545 38,90 and FOL0545 33,50; fuel filter GI50/7 45,00 |

## Tours

- **Guiado (Negócio)** — the quote an attendant actually sends: cards, filter
  choice, price edit, message.
- **Correios (Negócio)** — did any of it reach Motul or Tecfil? Answered from
  the API process's output, not the browser.

## Guidebook

`openspec/specs/quotes/oil-quote/spec.md`: the offerable-oil rule (a lubricant
is offered when its viscosity equals any listed grade, and only active catalogue
items are offered), "Each oil card's pre-filled price SHALL be the oil subtotal
plus the price of the chosen oil-filter candidate plus the price of the chosen
fuel-filter candidate", "until the attendant chooses, that type SHALL
contribute nothing to the price", "a price the attendant edited MUST NOT be
overwritten", and "The proposal message's Valor is the card's price".

## Steps

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open Conversas on `e2e-conv-tour`; `Montar orçamento` on `Volkswagen Polo 2021` | `status` "Dados consultados em 04/10/2026."; "Viscosidades aceitas: 0W-20 ou 5W-40 ou 0W-40 ou 5W-30 — volume de troca 4 L"; CarroRac source line | oil-quote — A verified identity opens on its options | succeeded |
| 2 | Read the cards | Four: Motul 8100 Eco-nergy, Lubrax Tecno (5W-30), Motul 8100 X-cess, Ipiranga F1 Master (5W-40). No Lubrax Essencial anywhere in the dialog | offerable-oil rule; inactive items not offered | succeeded |
| 3 | Read the oil-filter chooser and the first price | Chooser offers PSL545 R$ 38,90 and FOL0545 R$ 33,50, none chosen. Eco-nergy price 364,60 = 319,60 + 45,00; caption "… — filtro de óleo ainda não escolhido" | a multi-candidate type contributes nothing until chosen | succeeded (see finding 1) |
| 4 | Choose PSL545 | Eco-nergy 403,50 (= 79,90 × 4 + 38,90 + 45,00); Tecno 295,50; X-cess 383,50; F1 Master 311,50; captions show both filters | pre-filled price = oil subtotal + chosen filters | succeeded |
| 5 | Fill Eco-nergy's `Preço` with `399,90` | That field reads 399,90; the other three are unchanged | an edited price is the attendant's | succeeded |
| 6 | Read `Mensagem` | Four numbered options; option 1 "➡️ Valor: R$ 399,90", the others 295,50 / 383,50 / 311,50 | the message's Valor is the card's price | succeeded |
| 7 | Read the API process output for the whole drive | 241 lines, `Server listening at http://127.0.0.1:3100` present; zero lines matching `motul`, `tecfil`, `tour-guard` or `ECONNREFUSED`; `quote-options` answered 200 once | No tour reaches an off-box provider host (server-side) | succeeded |

`Enviar via WhatsApp` was not clicked.

## Findings

1. **Possible defect, not fixed here: the message promises an oil filter the
   price does not include yet.** Until a filter is chosen (step 3) every price
   leaves the oil filter out, as the spec requires, but the assembled message
   already opens with "Nesse valor já está incluso 👇 … ✅ Filtro de Óleo". An
   attendant who sends before choosing quotes a price that is R$ 33,50–38,90
   short of what the message says it covers. The spec says the message
   structure is unchanged by filter pricing and does not address this state, so
   it needs an owner reading before it is pinned. Routed to the orchestrator;
   the tour asserts the message only after the choice.

   Owner ruling 2026-10-04: block sending until chosen; implemented in change block-send-until-filter-chosen.
2. Step 7 is evidence only because the capture was shown to be live (the
   startup line) — an empty grep over an empty file proves nothing. The
   durable server-side check is `test/tour-provider-guard.test.ts`; this step
   is the live confirmation that a real drive of a complete identity reached
   neither client.
3. The SPA polls conversations, channel status and the rail every few seconds
   while the dialog is open; none of it was a quote read (one
   `quote-options` request in total), matching the "starts nothing" scenario.

## Transcribed to

`conversas-oil-quote.tour.spec.ts`, "Tour Guiado: the attendant chooses a
filter, edits a price, and the message carries it" (task 3.2).
