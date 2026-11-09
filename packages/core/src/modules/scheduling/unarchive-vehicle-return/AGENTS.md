# scheduling / unarchive-vehicle-return

**Purpose.** `POST /vehicle-returns/:returnId/unarchive`: put an archived return
back on the Follow-up queue.

**Kind.** HTTP command. Entry point: `route`.

**Tables written.** None of scheduling's. `vehicle_return` through
`services/contracts/archive-vehicle-return.ts`, under `module_services`.

**Invariants.**

- Only an `ARCHIVED` return of the caller's loja moves back to `OPEN`, with its
  archive stamps cleared; another loja's is a 404, a live one a 409
  `return_not_archived`.
- Nothing else is undone, because archiving did nothing else.

**Why it is here.** As `archive-vehicle-return` (3B ruling Q1-a; the write is
`services/contracts/archive-vehicle-return`).

**Tests.** `tests/unarchive-vehicle-return.integration.test.ts`, 3 new cases. The
old multi-route case is in `apps/api/test/scheduling.integration.test.ts`.
