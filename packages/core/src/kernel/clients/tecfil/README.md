# tecfil

Catálogo Expresso (Tecfil) filter-fitment client. No LLM SDK: when a name needs
more than normalized equality the resolver calls an option picker the caller
injects. Used by the quotes module's oil-quote lookup and by the demo script.
Moved here from `packages/tecfil` in wave 5.1a; reached as `clients.tecfil.*` or,
inside core, `kernel/clients/tecfil/index.js`.

- **filtros.ts** — encode the sentinel-delimited `filtros` query string
- **decode.ts** — undo the base64 + block-rotation response obfuscation
- **client.ts** — HTTP getter with bounded retry (`tecfilGet`, `TecfilError`)
- **wire.ts** — types matching Tecfil's JSON
- **columns.ts** — recorded grid-column → filter-type map
- **resolver.ts** — match CRM make/year/model/version to a fitment
- **candidates.ts** — the fitment's candidates from the APLICACAO rows (split out of `resolver.ts`)
- **index.ts** — public barrel
- **fixtures/** — decoded responses recorded from the live catalogue on
  2026-09-04 for `PEUGEOT` / `207` / 2011 (manufacturers, PEUGEOT vehicles,
  APLICACAO rows, PRODUTO rows), one raw obfuscated body for the decoder
  test, and two hand-built APLICACAO fixtures (`divergent-engines-*`,
  `both-fuel-columns-*`) for shapes the sample vehicle doesn't exercise
- Tests beside the code; `resolver.test.ts` is split with `resolver.unmatched.test.ts`
  over `resolver.fixture.ts` (core's 300-line cap). `tecfilGet` is mocked; none reaches Tecfil.

Wire format reference: [`docs/tecfil-catalogo-expresso-api.md`](../../../../../../docs/tecfil-catalogo-expresso-api.md).

## Demo

```bash
pnpm --filter @select-lub/core tecfil:demo
```

Runs the full four-request chain against the **live** catalogue for PEUGEOT /
2011 / 207 / 1.4 8V and prints the candidates with the grid columns they came
from. It needs network access and is excluded from CI. The demo-fleet capture is
`pnpm --filter @select-lub/core tecfil:capture-demo-fleet`, which writes
`packages/core/fixtures/tecfil-demo-fleet.json`. Both scripts are in
`packages/core/scripts/tecfil/`.
