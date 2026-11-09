# tidsci

Optional second mock Omie dataset, generated from local `tid_archive` (`emp01`–`emp04` as **one** tenant). Default Vitest and `SEED_DEMO` never read this folder's dump.

Visible ids are mock-origin 10–12 digit strings, not live Omie keys (GitHub #27 / #29 / #5).

- **date.ts** — `tidsciDateToIso` (days-since-1800-01-01 for the ~80400–82421 cluster)
- **ids.ts** — stable hash → 10–12 digit id
- **map.ts** — `mapTidsciArchive` (CPF collapse, every NF → OS)
- **catalog.ts** — gitignored cache keyed by material + invoice description
- **generate-dataset.ts** — one generate pass (injectable parser; `--limit` / `--refresh-catalog`)
- **load.ts** — `OMIE_MOCK_DATASET=tidsci` JSON loader (throws if the file is missing)
- **generate.ts** — `tidsci:generate` CLI (`TID_ARCHIVE_DATABASE_URL`, OpenAI catalog parse)
- **paths.ts** — default `.local/tidsci-omie-dataset.json` and `.local/tidsci-catalog-cache.json`
- **unit.ts** — first upsert → unit named `Select Lub`
