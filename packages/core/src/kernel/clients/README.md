# kernel/clients

Every third party the modules reach, bound at the composition root. A slice
reads a port; it never builds a client or reads provider credentials itself.
Reached from outside core as `clients.*` from `@select-lub/core`.

WhatsApp is not here: Evolution's ports belong to the `channel` module
(`modules/channel/internal/ports.ts`), the only module that reaches it. A
placeholder WhatsApp port lived here until the cleanup after wave 5; nothing used it.

- **index.ts** — the barrel below
- **erp.ts** — `bindErp` / `erp()`, the ERP port
- **erp-mock.ts** / **erp-mock/** — the Omie adapter, its fake, the wire mapping and the mock
  Omie source with the TIDSCI dataset (`clients.omie.*`), and `createErpFromOmie()`; absorbed
  from `@select-lub/omie` in wave 5.1b
- **motul/** — the Motul Oil Advisor client (`clients.motul.*`): HTTP getters with retry and a
  circuit breaker, the recommendation flattener, the fill pickers and the identity resolver
- **tecfil/** — the Tecfil Catálogo Expresso client (`clients.tecfil.*`): the encoded query,
  the obfuscated-body decoder, the HTTP getter with retry and the fitment resolver
- **placas/** — the plate lookup (`clients.placasProviders.*`): the port, the APIBrasil adapter,
  the post-MVP API Placas adapter, the mock, and source selection; `binding.ts` is
  `bindPlacas` / `placas()` / `createProductionPlacas()`. The port is nullable on purpose:
  `null` means the provider is inactive (no token), which the api refuses rather than crashes on.

`motul/`, `tecfil/` and `placas/` were the packages `@select-lub/{motul,tecfil,placas}`
until wave 5.1a, which moved them here unchanged, as 5.1b did for `@select-lub/omie`. Their tests live beside them and
reach no network: `globalThis.fetch` is replaced, or the client function is mocked.
Their live scripts (demo, capture) are in `packages/core/scripts/{motul,tecfil}/`, run
with `pnpm --filter @select-lub/core <name>`, and are never part of CI.
