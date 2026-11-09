# services

Service orders (OS) and the vehicle returns they open. Owns `service`, `service_item`,
`vehicle_return` and `interval_rule`; reads customers', conversations' and reports'
tables for its unit checks and labels. Every route is read-only: the ERP import is the
only writer of `service` (W3-C8).

- **index.ts** — `createHttpPlugin()`, the only thing the app imports. No ports.
- **list-unit-services/** — `GET /services`, the Serviços ledger. `queries.ts` is the read.
- **get-service/** — `GET /services/:id`, the detail region. `queries.ts` is the read.
- **list-customer-services/**, **list-vehicle-services/**, **list-conversation-services/** —
  the three rail lists. Each slice has an `AGENTS.md`.
- **contracts/** — public, `@select-lub/core/modules/services/contracts`:
  - `return-state.ts` — `classifyReturnDate` and `followUpReturnWindow`, the ONE
    classification of a stored return date; Follow-up imports it too
  - `reconcile-vehicle-returns.ts` — open / supersede returns after an import; `erp`'s pull
    calls it, and it stops superseded reminders through `scheduling`'s contract, nested
  - `import-from-erp.ts` — the pull's service-order store
  - `archive-vehicle-return.ts` — archive / unarchive, called by `scheduling`'s routes
  - `http.ts` — the web contract, over `http.service.ts`, `http.return-due.ts` and
    `http.vehicle-return-plan.ts` (defined here since 5.1d)
- **internal/** — shared by the slices, importable by nobody else:
  - `service-dto.ts` — row → `Service` / `UnitServiceRow`, and `sortServices`
  - `unit-listing.ts` — the ledger's period, search, return-state filter, cursor and page
  - `service-reads.ts` — a customer's services, a customer's loja
  - `set-vehicle-return-date.ts` — move a return's date and its reminders; no route yet (W3-C7)
  - `params.ts` — path params and the `{}` 404 body

The demo seed opens its vehicle returns through this module's `reconcileVehicleReturns`, the
same apply the Omie import runs, so the seed and production cannot drift. Until the cleanup
after wave 5 the seed carried its own copy of the apply, held to this one by an agreement test,
because it lived in `packages/db`, which could not import this package.

Moved from `apps/api/src/services/` and `packages/db/src/vehicle-return*.ts` in
adopt-modular-vertical-slices 3C.
