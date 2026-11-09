# scheduling / update-return-reminder

**Purpose.** `PATCH /return-reminders/:reminderMessageId`: replace a reminder
message's un-sent moments and/or rewrite its text.

**Kind.** HTTP command, over the LIVE channel probe (an edit can add a moment).
Entry points: `updateReminder(tx, input)` (`update-reminder.ts`, moved from
`packages/db/src/return-reminders.ts`) and `createRoute(ports)`.

**Tables written.** `return_reminder_message`, `scheduled_message`, and — through
channel's `cancelOutbound` and `rewriteUnsentOutbound`, under `module_channel` — a
dropped moment's `queued` or `blocked` `outbox_message` row (cancelled), and a kept
moment's (rewritten).

**Invariants.**

- `triggers` is the COMPLETE desired un-sent set, not a delta. A surviving moment
  keeps its row and so its outbox idempotency key; a dropped one is CANCELLED,
  not deleted; a desired moment on an already-sent instant is dropped.
- `SENT`, `FAILED` and `PROCESSING` rows are never touched — including a row the
  due tick claims AFTER the edit read it: every row write is compare-and-set on
  `SCHEDULED`, and a row that has left is skipped (not a 409) and not counted in
  `cancelled` / `rewritten`. It goes out as it was.
- A kept moment's rewrite goes through `rewriteUnlessPickedUp` (`contracts/unsent.ts`,
  owner rulings 2026-09-25, PR 6): its copy waiting to be sent, `blocked` or `queued`,
  gets the new text, and a copy already picked up leaves the moment as it is.
- A dropped moment goes through `contracts/unsent.ts` (owner rulings,
  2026-09-25): its `queued` or `blocked` outbox row is cancelled with it, and one
  whose outbox row is already `claimed`, `sent` or `confirmed` is skipped the
  same way, even if the stale-PROCESSING recovery put it back to `SCHEDULED`.
- A wording-only edit moves no instant and resolves each row for its own moment.
- A cancelled message is not edited (`message_cancelled`); an edit leaving nothing
  pending and nothing sent is `no_triggers`.
- The read and the writes are one `db.tx`; the probe runs outside it.

**Tests.** `tests/update-reminder.integration.test.ts`, 4 cases moved from
`packages/db/src/return-reminders.live.test.ts` (reminder rows now inserted
directly; assertions unchanged), and 2 new ones that stage the due tick's claim
between the edit's read and its write (mutation-checked: writes by id alone
fail both). The route's cases are in
`apps/api/test/scheduling.integration.test.ts`.
