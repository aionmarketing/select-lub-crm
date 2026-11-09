# scheduling / cancel-scheduled-message

**Purpose.** `POST /conversations/:id/scheduled-messages/:scheduleId/cancel`: stop
a scheduled message before it is sent.

**Kind.** HTTP command, over the LIVE channel probe. Entry points:
`cancelSchedule(tx, scheduleId)` and `createRoute(ports)`.

**Tables written.** `scheduled_message` (`CANCELLED`), and — through channel's
`cancelOutbound`, under `module_channel` — the unsent `outbox_message` row.

**Invariants.**

- The schedule and its outbox row are cancelled in ONE transaction: a cancelled
  schedule whose outbox row stayed `queued` would still be sent.
- A `SENT` row is never cancelled (409 `{ state: "CONNECTED" }`); the schedule
  row is locked before it is read, so a row sent after the route's read stays sent.
- Nor is one the worker has picked up (owner rulings, 2026-09-25): whatever the
  schedule's status, an outbox row `claimed`, `sent` or `confirmed` answers the
  same 409 and neither row changes. A `PROCESSING` schedule whose outbox row is
  still `queued` is cancelled. The rule lives in `contracts/unsent.ts`,
  shared with every reminder cancel.
- Refused (409 `{ state: "DISCONNECTED" }`) while the live probe says down; the
  probe runs outside any transaction.

**Tests.** `tests/cancel-scheduled-message.integration.test.ts`, 4 cases moved
from `apps/api/src/scheduled.route.test.ts`, assertions unchanged, plus 8: the 409
for each picked-up outbox status on a `SCHEDULED` and a `PROCESSING` schedule (6),
a `PROCESSING` one still `queued` (cancelled), and a `blocked` one (cancelled).
