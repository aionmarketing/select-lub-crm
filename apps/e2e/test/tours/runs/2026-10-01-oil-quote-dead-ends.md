# Tour run — the oil quote's three dead ends (task 5.12)

## Feature

`Montar orçamento`'s ways out of the missing volume, the clarification and the
conflicting sources (background-oil-research D24): type the volume, pick the
engine or correct the version, choose the grade and the volume.

Change under tour: `background-oil-research`, PR 5c (tasks 5.10–5.12). Base:
main at `efda28d8`, branch `claude/bor-5c-web-dead-ends`.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright** (the visual-QA capture of task 5.6 drove every state first, through the same route mocks), then the tour spec |
| Stack | API `127.0.0.1:3100`, SPA `127.0.0.1:5174` (`cursor` variant), mock Evolution `18081` |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, paid keys blanked; no worker |
| Quote read | **route-mocked** for the Polo (`e2e-veh-quote-polo`): `GET …/quote-options` answers each outcome; `POST …/oil-fill-volume` and `POST …/oil-research/engine-pick` are answered by the browser and never reach the API |
| Database | the worktree's own e2e database on local Compose, seeded by `seed-e2e.ts`; nothing written by these tours |

Why mocked: the tour stack runs no worker, and only research writes a
clarification, a conflict or a missing volume. The rail, the vehicle list and the
drill-in form stay live; the api's routes are covered by their `app.inject` tests
(task 5.9).

## Tours

- **Obsessivo (Intelectual)** — the volume field fed 0 and 42.
- **Guiado (Negócio)** — an engine pick; a clarification naming no engine.
- **Ator Coadjuvante (Entretenimento)** — a grade-and-volume conflict, driven by
  the keyboard alone.

## Guidebook

`openspec/changes/background-oil-research/specs/quotes/oil-quote/spec.md` and
`…/conversations/conversas/spec.md` (scenarios named per step).

## Steps

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Polo answers `no_capacity`; type `0`, `Usar este volume` | the status reads "Informe o volume em litros, maior que zero."; no `Preço` box | oil-quote — A value that is not a volume is refused | succeeded |
| 2 | Type `42`, `Usar este volume` | the status reads "Volume alto — confira antes de usar."; the warning with its icon beside `Usar mesmo assim`; no `Preço` box | oil-quote — A volume above 30 L warns | succeeded |
| 3 | `Usar mesmo assim` | the prompt "Guardar 42 L como volume da troca para os próximos orçamentos de Volkswagen Polo 1.0 TSI 2021?" | oil-quote — A confirmed high volume prices and can be kept | succeeded |
| 4 | `Só neste orçamento` | the card priced, "Volume informado pelo atendente: 42 L"; no volume POST sent; no `role="alert"` | oil-quote — Only this quote stores nothing | succeeded |
| 5 | Polo answers a clarification naming `1.0 TSI` and `1.4 TSI`; click `1.4 TSI` | one POST `{ engine: "1.4 TSI" }`; the status "Lendo a fonte para o motor 1.4 TSI…", a `timer`, no range | oil-quote — Choosing a named engine appends it and re-reads the source | succeeded |
| 6 | Polo answers a clarification naming none; `Corrigir versão do veículo` | the dialog closes; the Veículo drill-in shows the form, `Versão` focused, holding `1.0 TSI`; nothing posted | conversas — Correcting the version opens the form | succeeded |
| 7 | Polo answers a grade-and-volume conflict | each grade a radio, unchecked, cited "— manual da montadora" (a class) and "— guia de aplicação do fabricante de lubrificante" (a tier, no class); `Enviar via WhatsApp` disabled | oil-quote — A grade conflict offers every grade's cards, each citing its source | succeeded |
| 8 | Focus the first grade, `ArrowDown` | `5W-40` checked and focused | D24 — the arrow keys move the choice | succeeded |
| 9 | Focus `3,6 L`, `Space` | the message appears with the Motul and without the Mobil; send enabled | oil-quote — Grade and volume both in conflict ask for both | succeeded |

## Findings

None that is a defect. One note:

1. **The corrected-version line is not on this tour.** "Versão do veículo
   corrigida para …" reads the rail's refreshed vehicle list, and the mocked
   engine pick writes no version, so the live list still says `1.0 TSI`. The
   line is covered by `ConversasPage.quote-clarification.test.tsx` and drawn in
   the visual QA (state 38).

## Transcribed

`apps/e2e/test/tours/conversas-oil-quote-dead-ends.tour.spec.ts`, four tours,
each `expect` citing its scenario. Run together with
`conversas-oil-quote.tour.spec.ts`: 10 passed (51 s).
