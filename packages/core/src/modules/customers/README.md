# customers

The cadastro: customers, their vehicles, each shared field's sync versions with Omie, and
the reconciliation pendings. Owns `customer`, `customer_phone`, `customer_email`, `vehicle`,
both `*_field_sync` and both `*_reconciliation_pending`. The cadastro logic itself is
the engine in `contracts/cadastro-engine/` (`applyCrmEdit`, `applyVehicleFieldEdit`,
`resolvePending`, `ingestOmieSnapshot`, `persistPrefillAccept`), absorbed from
`@select-lub/omie` in 5.1b; its README names who may call what. The write-back to Omie is synchronous (Q1a), through the adapter the
plugin is given.

- **index.ts** — `createHttpPlugin({ omieAdapter })`, the only thing the app imports. The
  adapter lives in the plugin's closure, one per app — never a process-wide binding, where
  the last `buildApp` in a process would win (W2-C6). Tests pass their fake to `route(...)`.
- **update-customer/**, **list-customer-pendings/**, **resolve-pending/**,
  **list-unit-pendings/** — the customer and pendings routes.
- **list-customer-vehicles/**, **create-customer-vehicle/**, **update-vehicle/**,
  **get-vehicle-erp-sync/** — the vehicle routes.
- **list-conversation-vehicles/**, **get-conversation-customer/**,
  **link-conversation-customer/**, **create-conversation-vehicle/** — the rail's routes,
  keyed by conversation. Each slice has an `AGENTS.md`.
- **contracts/** — public, `@select-lub/core/modules/customers`:
  - `cadastro-store/` — THE cadastro store: the one Postgres implementation of
    `CadastroStore`, every call in `db.tx("customers", …)`, split by topic (`customers`,
    `vehicles`, `field-sync`, `reconcile`, `pull`, `rows`) plus `plate-origin.ts`, the other
    writer of `vehicle_field_sync`. Public in name only (a contract may not import
    `internal/`); any caller still writes under the customers role.
    `cadastro-store/port.ts` is the port itself (`CadastroStore` and the record types),
    absorbed from `@select-lub/omie` in 5.1b.
  - `cadastro-engine/` — the cadastro engine (5.1b), split by topic; its README names the
    intended caller of each entry point
  - `cadastro-dto.ts`, `from-snapshot.ts` — the customer/vehicle/pending DTOs, and the
    customer fields an Omie snapshot maps to (5.1b)
  - `import-from-erp.ts` — the store under the name `erp/run-pull` calls
  - `apply-prefill-suggestion.ts` — `applyPrefillSuggestion(db, input, omieAdapter)`, for 4C's prefill
  - `customer-changed.ts`, `vehicle-changed.ts` — events published after edits and
    creates; no subscriber yet (the async write-back is its own change)
  - `http.ts` — the route schemas and path params
- **internal/** — shared by the slices:
  - `conversation-customer.ts` — the customer behind a conversation, through the
    conversations contract `getCadastroLink`
  - `ports.ts` — `CustomerPorts`, the Omie adapter `createHttpPlugin` takes
  - `resync-from-erp.ts` — refresh a linked customer from Omie before a read
  - `plate-origin.ts` — map a vehicle body onto `PLACA`/`CRM` marks; vehicle DTO with them
  - `new-vehicle.ts` — the row a vehicle create writes
  - `announce.ts` — publish the two events
