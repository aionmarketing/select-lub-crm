# scheduling / create-scheduled-message

**Purpose.** `POST /conversations/:id/scheduled-messages`: Programar mensagem — a
text frozen now, sent by the due tick at `scheduledAt`.

**Kind.** HTTP command, over the LIVE channel probe. Entry points:
`insertSchedule(tx, input)` and `createRoute(ports)`.

**Tables written.** `scheduled_message`, one `SCHEDULED` row.

**Invariants.**

- Confirming never sends. The outbox is written later, by the due tick.
- Refused (409 `{ state: "DISCONNECTED" }`) while the live probe says down. The
  probe is a network call and runs between two `db.tx`, never inside one.
- One non-cancelled RAIL schedule per service (409 `{ error: "conflict" }`);
  reminder rows naming the same service do not occupy it. The check and the
  insert share one `db.tx`; the partial unique index backs it (P2002 → conflict).
- `createdByUserId` is the session user.

**Tests.** `tests/create-scheduled-message.integration.test.ts`, 7 cases moved
from `apps/api/src/scheduled.route.test.ts`, assertions unchanged.
