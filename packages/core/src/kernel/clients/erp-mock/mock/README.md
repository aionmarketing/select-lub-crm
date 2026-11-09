# mock

Standalone mock Omie source for local/demo pulls — never a live tenant.

TIDSCI-derived ids, OS, vehicle ids, and (absent) duplicate pairs are **unvalidated** stand-ins mapped from `tid_archive` tables, not a live Omie wire contract (GitHub #27 / #29 / #5). They must not be presented as confirmed Omie keys and must not be pushed to a real Omie tenant.

- **dataset.ts** — small deterministic fixture (clients, OS, products, vehicle ids, duplicate pairs)
- **source.ts** — `createMockOmie(env)` wires the client fake plus the ports below; `OMIE_MOCK_DATASET=tidsci` loads the generated JSON
- **service-orders.ts** — per-client OS rows, indexed by `clientOmieId`
- **products.ts** — catalog products (`id` matches seed catalog rows)
- **vehicle-ids.ts** — per-vehicle Omie id stand-in (GitHub #29 — unvalidated)
- **duplicates.ts** — duplicate-client candidate pairs (GitHub #5 — unvalidated; no merge)
- **tidsci/** — generate-time mapper + catalog cache + dataset loader (opt-in only)
