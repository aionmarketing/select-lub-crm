# scheduling / create-return-reminder

**Purpose.** `POST /vehicle-returns/:returnId/reminders`: confirm a reminder message
on a vehicle return — one `return_reminder_message` and one `SCHEDULED` row per
trigger, each with its text resolved for its own moment.

**Kind.** HTTP command, over the LIVE channel probe. Entry points:
`createReminder(tx, input)` (`create-reminder.ts`, moved from
`packages/db/src/return-reminders.ts`) and `createRoute(ports)`.

**Tables written.** `return_reminder_message`, `scheduled_message`. Reads
`vehicle_return`, `service`, `vehicle`, `interval_rule` (`readableBy`).

**Invariants.**

- Confirming never sends; each row is an ordinary schedule to the due tick.
- All or nothing: the message and every row commit in one `db.tx`, and nothing is
  written unless the plan (`planReminderMessage`) accepts every trigger.
- The return and the conversation must both be the caller's loja's; either
  failing is the same 404, so an outsider cannot learn a row exists.
- Only an `OPEN` return takes a reminder; its source service must be dated.
- Refused while the live probe says down; the probe runs outside any transaction.

**Tests.** `tests/create-return-reminder.integration.test.ts`, 6 cases moved from
`apps/api/src/return-reminders.route.test.ts`; `tests/create-reminder.integration.test.ts`,
4 cases moved from `packages/db/src/return-reminders.live.test.ts` (outbox count
scoped to the test's conversation). The route's multi-route cases are in
`apps/api/test/scheduling.integration.test.ts`.
