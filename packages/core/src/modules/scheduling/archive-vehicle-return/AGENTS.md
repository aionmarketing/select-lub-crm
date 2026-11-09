# scheduling / archive-vehicle-return

**Purpose.** `POST /vehicle-returns/:returnId/archive`: take a return off both
Follow-up return sections. Its reminders keep their schedule (decided 2026-09-03).

**Kind.** HTTP command. Entry point: `route`.

**Tables written.** None of scheduling's. `vehicle_return` (`status`,
`archived_at`, `archived_by_user_id`) through
`services/contracts/archive-vehicle-return.ts`, under `module_services`.

**Invariants.**

- Only an `OPEN` return of the caller's loja is archived; another loja's is a
  404, an already archived one a 409 `return_not_open`.
- Reminders are untouched.

**Why it is here.** 3B ruling Q1-a: the route lives beside the reminder routes,
where the screen and its tests are; its write is `services'`, through
`services/contracts/archive-vehicle-return` (correction C4 called it a read; it is a write).

**Tests.** `tests/archive-vehicle-return.integration.test.ts`, 3 new cases. The
old multi-route archive case is in `apps/api/test/scheduling.integration.test.ts`.

**Blocked on core.** Nothing.
