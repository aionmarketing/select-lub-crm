# scheduling / get-scheduled-message

**Purpose.** `GET /scheduled-messages/:id`: one scheduled message in full, for the
rail drill-in — frozen text, instant and zone, status, the recorded error when it
failed, and the template, originating service and creator by name.

**Kind.** HTTP query. Entry points: `getScheduledMessage(tx, unitId, scheduleId)`
and `route`.

**Tables written.** None. One read of `scheduled_message` joined to `template`
(conversations'), `user` (accounts') and `service` (services'), all `readableBy`.

**Invariants.**

- Scoped through the row's conversation's connection. A row in another loja, a
  row with no conversation and an unknown id are the same 404.
- Absent links are `null`, never missing fields. `templateId` is null once its
  template is deleted (`ON DELETE SET NULL`); `createdByName` always resolves.

**Tests.** `tests/get-scheduled-message.integration.test.ts`, 8 cases moved from
`apps/api/src/scheduled.detail.route.test.ts`, assertions unchanged.
