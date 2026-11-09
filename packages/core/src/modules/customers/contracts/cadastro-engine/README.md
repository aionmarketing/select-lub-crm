# cadastro-engine

The cadastro engine: how a customer's or titular vehicle's **shared** fields are
edited in the CRM, reconciled with Omie, and pushed back. Moved from
`packages/omie/src/engine.ts` in wave 5.1b with its bodies unchanged, split by
topic. The write-back to Omie is synchronous and outside any transaction
(4B ruling Q1a); every store call is its own `db.tx("customers", …)`.

It sits under `contracts/` rather than `internal/` only because a contract may
not import `internal/` and two contracts need it (the 4B cadastro-store
precedent). **Public in name, not in intent.** The intended callers:

| Entry point | Who may call it |
|---|---|
| `ingestOmieSnapshot` | erp's pull (`erp/run-pull`), this module's on-read resync, and `apps/api`'s cadastro live tests (through the module index) |
| `persistPrefillAccept` | `contracts/apply-prefill-suggestion.ts` only — prefill goes through that contract |
| `applyCrmEdit`, `applyVehicleFieldEdit`, `resolvePending`, `getBusinessValue` | this module's own slices (and `applyCrmEdit` in `apps/api`'s cadastro live test, through the module index) |

Any other caller is a boundary smell: go through a customers contract instead.

- **index.ts** — the entry points above.
- **apply-crm-edit.ts** — an attendant's customer edit.
- **vehicle-edit.ts** — a vehicle edit; titular shared fields go through `applyCrmEdit`.
- **ingest.ts** — decide every shared field against a fresh Omie snapshot.
- **resolve-pending.ts** — close an open conflict.
- **prefill.ts** — write one accepted prefill value.
- **decide-field.ts** — `decideField`, the per-field push / apply / open-pending
  decision. Its Omie-only branch re-reads the customer right before saving, so a
  contact added during the Omie calls survives (4B review).
- **values.ts** — read and write a field's business value; which sync row owns it.
- **results.ts** — the status unions.
