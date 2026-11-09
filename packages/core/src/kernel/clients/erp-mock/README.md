# kernel/clients/erp-mock

The Omie transport: everything that talks to Omie, or pretends to. Absorbed from
`@select-lub/omie` in wave 5.1b; `../erp-mock.ts` is the barrel, and the only
file the rest of core imports. Nothing here imports a module (the kernel is the
bottom), and none of these tests needs a database.

- **adapter.ts** — the ports: `OmieAdapter` (get/put) and `OmieSyncPort` (+ `listPage`/`incluir`).
- **create-adapter.ts** — `createOmieAdapter()`: credentials → mock opt-in (`OMIE_MOCK=1`) → empty fake.
- **http.ts** — the live Omie HTTP adapter (a named leftover; no test reaches a real tenant).
- **fake.ts** — `createFakeOmie()`, the in-memory `OmieSyncPort` tests use.
- **map.ts**, **fields.ts**, **sanitize.ts** — the wire mapping between Omie's `ClienteCadastro` and CRM field values.
- **mock/** — the selectable mock Omie source (clients, OS, products, vehicle ids, duplicates) and the TIDSCI dataset; see that folder's README.

The cadastro half of the old package went to the modules that own it:

| Was in `packages/omie/src/` | Now |
| --- | --- |
| `engine.ts` | `modules/customers/contracts/cadastro-engine/` (split by topic; see its README for callers) |
| `store.ts` | `modules/customers/contracts/cadastro-store/port.ts` |
| `dto.ts`, `from-snapshot.ts` | `modules/customers/contracts/cadastro-dto.ts`, `from-snapshot.ts` |
| `pull.ts`, `import-surfaces.ts` | `modules/erp/run-pull/` |
| `sync-store.ts`, `import-store.ts` | `modules/erp/contracts/sync-run-store.ts`, `import-surfaces-store.ts` |

Outside core (the apps, the db seed) these are `clients.omie.*` from `@select-lub/core`.

## TIDSCI mock dataset (opt-in, local only)

A second dataset generated from `tid_archive` so Serviços/cadastro can demo on real NF volume. Default `mockOmieDataset()` / Vitest is unchanged. The dump is real cadastro (gitignored `.local/`).

| Flag / arg | Role |
| --- | --- |
| `OMIE_MOCK=1` | existing mock Omie opt-in |
| `OMIE_MOCK_DATASET=tidsci` | serve the generated JSON instead of the small fixture |
| `OMIE_MOCK_TIDSCI_PATH` | JSON path; default `.local/tidsci-omie-dataset.json`, relative to the working directory |
| `TID_ARCHIVE_DATABASE_URL` | generator only (not `DATABASE_URL`) |
| `--refresh-catalog` | re-parse cache hits in this run; prints kind changes |
| `--limit N` | parse at most N **uncached** keys, most-used invoice lines first |

Sequence: `pnpm --filter @select-lub/core tidsci:generate` (fills `.local/tidsci-catalog-cache.json`, under `packages/core/` since the script runs there — it ran under `packages/omie/` before 5.1b) → set `OMIE_MOCK=1` and `OMIE_MOCK_DATASET=tidsci` → worker pull/import. Missing JSON throws; it does not fall back to the fixture. Credentials still win over both mock flags.

Parse in batches rather than all 3,286 distinct materials at once: `--limit 60`, read the new cache entries, then widen (322, then 993). 60 keys cover half of the 274,674 invoice lines, so a prompt problem shows up there. Each limited run still writes a loadable dataset (unparsed materials are absent, not half-formed). Cache and dump paths are gitignored.
