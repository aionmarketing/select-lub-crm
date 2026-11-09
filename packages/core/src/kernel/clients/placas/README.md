# placas

Plate → vehicle lookup. Wraps the paid providers so the API depends on one port, not on a vendor. Every uncached call spends prepaid credit. Moved here from `packages/placas` in wave 5.1a; the adapters are reached as `clients.placasProviders.*`, the bound port as `clients.placas()`.

- **binding.ts** — `bindPlacas` / `placas()` / `createProductionPlacas()`, the composition-root binding (was `kernel/clients/placas.ts`)
- **port.ts** — the port: `PlateProvider`, `PlateFields`, and the `found` / `not_found` / `failed` outcome
- **plate.ts** — `parsePlate`: normalize and validate before anything is billed
- **absent.ts** — placeholder detection; empty, whitespace, all-zero, `INDETERMINADO` and `DESCONHECIDO` become absent
- **agregados-propria.ts** — primary HTTP adapter (APIBrasil)
- **api-placas.ts** — post-MVP fallback HTTP adapter (un-wired; token in the URL path; never log the URL)
- **compose.ts** — post-MVP primary-then-fallback cascade (the factory does not call this)
- **create-adapter.ts** — `APIBRASIL_BEARER_TOKEN`, then `PLACAS_MOCK=1`, then inactive. `API_PLACAS_TOKEN` is ignored.
- **mock/** — canned plates for local/CI runs without tokens
- **timeout.ts** — 8s abort, same budget as the Motul client
- **strip-owner.ts** — drops billed-party keys and account `email` / `cellphone` before persistence
- **fixtures/** — sandbox envelopes, one live found capture, and a live 404 miss; account identity is scrubbed

## Providers

| Role | Service | Cost | MVP |
| --- | --- | --- | --- |
| Provider | APIBrasil `agregados-propria` | R$ 0,08 | yes |
| Fallback | API Placas (`wdapi2.com.br`) | R$ 0,03 | post-MVP, un-wired |

The production factory constructs only the APIBrasil adapter. `API_PLACAS_TOKEN` does not activate lookup. See `openspec/specs/plate-lookup/plate-lookup/spec.md` and `openspec/changes/archive/2026-09-07-add-plate-lookup/design.md`.

## Fixtures

APIBrasil accepts `"homolog": true`, which returns fixture data uncharged and uncounted — that is how the sandbox envelopes were captured. It always returns the same vehicle regardless of plate, so the variants covering absent and placeholder fields are derived by hand and say so in a `_note`. `agregados-propria-live-found.json` and `agregados-propria-empty-data.json` are live `homolog: false` captures (found / HTTP 404 miss). API Placas fixtures follow the published docs; they are not live captures.
