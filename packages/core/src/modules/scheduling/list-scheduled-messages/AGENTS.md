# scheduling / list-scheduled-messages

**Purpose.** `GET /conversations/:id/scheduled-messages`: a conversation's
scheduled messages, oldest first, for the Mensagens programadas section of the rail.

**Kind.** HTTP query. Entry points: `listScheduledMessages(tx, unitId, conversationId)`
and `route`.

**Tables written.** None. Reads `scheduled_message`, and `conversation` /
`whatsapp_connection` (conversations' and channel's, `readableBy`) for the
unit check, in one `db.tx("scheduling", …)`.

**Invariants.**

- The conversation must hang off a connection of the caller's loja; another
  loja's is a 404, the same as an unknown one.
- Every schedule of the conversation, reminder rows included, ordered by `createdAt`.

**Tests.** `tests/list-scheduled-messages.integration.test.ts`, 1 case moved
from `apps/api/src/scheduled.route.test.ts`, assertion unchanged.
