# scheduling / cancel-return-reminder

**Purpose.** `POST /return-reminders/:reminderMessageId/cancel`: stop a reminder
message and every one of its un-sent moments.

**Kind.** HTTP command. No probe: stopping never sends, so a down channel must not
trap the operator. Entry points: `cancelReminder(tx, reminderMessageId)`
(`cancel-reminder.ts`, moved from `packages/db/src/return-reminders.ts`) and `route`.

**Tables written.** `return_reminder_message` (`cancelledAt`), `scheduled_message`
(`SCHEDULED` rows → `CANCELLED`), and — through channel's `cancelOutbound`, under
`module_channel` — each row's `queued` or `blocked` `outbox_message` row.

**Invariants.**

- Only `SCHEDULED` rows move; `SENT`, `FAILED` and `PROCESSING` are left alone.
- Each row goes through `contracts/unsent.ts` (owner rulings, 2026-09-25):
  its `queued` or `blocked` outbox row is cancelled with it, and a row whose
  outbox row is `claimed`, `sent` or `confirmed` is left as it is and not counted.
  Before, a row a disconnected due tick left beside a `blocked` outbox row kept
  that bubble in the thread for ever; migration
  `20260925120000_cancel_blocked_outbox_of_cancelled_schedules` fixed those.
- The scope check, the cancel and the read-back are one `db.tx`.

**Tests.** `tests/cancel-reminder.integration.test.ts`, the 1 case moved from
`packages/db/src/return-reminders.live.test.ts`, split in 2 (the unknown-message
throw on its own), plus 1 for the outbox rows (blocked cancelled, claimed left). The route's cases are in `apps/api/test/scheduling.integration.test.ts`.
