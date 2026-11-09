# Tour run — Oil quote: the lubricant's oil type on the cards and in the message

## Feature

`Montar orçamento` on the seeded Polo 2021, after `add-lubricant-oil-type`: the
cards now name brand, description and viscosity, show the pt-BR oil type next
to the price, and the message writes `➡️ Tipo: <tipo>` — or no Tipo line for a
lubricant without a type.

Change under tour: `add-lubricant-oil-type`, task 4.3. Base: main at
`a4d51e2e` plus this branch (`claude/propose-lubricant-oil-type`).

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | Playwright via the tour config (`pnpm test:e2e:tours`); the Playwright MCP server did not connect in this session, so the live look was the capture harness of task 5.2 (Vite + route mocks) rather than an MCP drive |
| Stack | the tour stack: API `127.0.0.1:3100`, SPA `127.0.0.1:5174` (`cursor`), mock Evolution `18081`, local Supabase Auth on `127.0.0.1:54321` (`pnpm tours:supabase:start`), no `.env`, `EVOLUTION_INSTANCE_NAME="Select Lub"` |
| Provider guard | the tour config's: mocks on, paid keys blank, no worker |
| Database | `selectlub_agent_a4b8d59068158d683_tours`, provisioned and seeded by `run-tours.mjs` |
| Catalogue | demo seed with the oil types of ruling 6: Motul 8100 Eco-nergy 5W-30 and 8100 X-cess 5W-40 `SINTETICO`, Lubrax Tecno 5W-30 `SEMISSINTETICO`, Ipiranga F1 Master 5W-40 none, inactive Lubrax Essencial 5W-30 `MINERAL` |

## Tours

- **Guiado (Negócio)** — the quote an attendant sends: four cards, their types,
  a filter choice, a price edit, the message.
- **Ator Coadjuvante / Obsessivo** (dead-ends file) — the mocked conflict and
  missing-volume dialogs still open once their cards carry an oil type.

## Guidebook

`openspec/changes/add-lubricant-oil-type/specs/quotes/oil-quote/spec.md`:
"Cards carry editable prices and assemble the message live" (title with the
viscosity, the type beside the price, `➡️ Tipo:` with the pt-BR label, no Tipo
line for an untyped lubricant), "Each oil type has its pt-BR label".

## Steps and findings

1. Opened the Polo's quote. The four active cards read `Motul 8100 Eco-nergy
   5W-30`, `Lubrax Tecno 5W-30`, `Motul 8100 X-cess 5W-40`, `Ipiranga F1 Master
   5W-40`. Motul cards show `Sintético`, Lubrax Tecno `Semissintético`,
   Ipiranga nothing.
2. Chose the PSL545 oil filter and edited the first price to 399,90. The
   message lists each option as name, then `➡️ Tipo: …` for the typed three,
   then `➡️ Valor: …`; the Ipiranga option has no Tipo line. Lubrax Essencial
   (inactive) is absent.
3. **Finding (test data, fixed):** the dead-ends tour's route-mocked cards had
   no `oilType`. The contract makes it required-nullable, so the SPA refused
   the mocked body ("Não foi possível carregar as opções de orçamento") and two
   cases failed. Not a product defect — the API always sends the field (the
   `get-quote-options.rows` integration case asserts it through `app.inject`)
   — so the mock's `oil()` helper now carries `oilType: "SINTETICO"`, the
   canvas's type.

## Transcribed

`conversas-oil-quote.tour.spec.ts`: `messageOption` now builds the expected
block from the seeded catalogue row (name with the viscosity, the label from
the spec's pt-BR table, no Tipo line when the row has no type), and a new
check pins each card's type caption against the seed, not against what the run
displayed. `conversas-oil-quote-dead-ends.tour.spec.ts`: the mocked cards carry
an oil type.

Result: `conversas-oil-quote.tour.spec.ts` 7 passed;
`conversas-oil-quote-dead-ends.tour.spec.ts` 4 passed (2 failed before the
fixture fix, as above).
