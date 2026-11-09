# list-messages

**Purpose.** `GET /conversations/:id/messages` — a thread: its canonical messages and the sends still in flight, in WhatsApp time order.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`; `listMessages(db, unitId, conversationId)`.

**Tables written** (under `db.tx("conversations", …)`): None (reads `conversation`, `message`, `outbox_message`).

**Invariants.**

- Another loja's or an unknown thread answers 404.
- An outbox row appears until `confirmed`. The canonical message then takes its place: inserted by the outbound-sent subscriber just after the confirm (the drain confirms first, then publishes; owner rulings, 2026-09-25), or, when that insert fails or the send had no usable timestamp, by the SEND_MESSAGE webhook for the same provider id. Between the confirm and that insert the send shows as neither, briefly.
- Text is returned as stored — HTML-like text is never interpreted.
- An outbox row that did not go out carries `outboxFailure` (`hold-unknown-outcome-sends`):
  `outcome_unknown` for `failed` with `send_outcome_unknown`, `not_sent` for any other
  `failed` row and a `blocked` row the attendant sent (`internal/outbox-failure.ts`). A
  scheduled message's blocked copy carries none; it reads `scheduled_message` for that.
  A row already resent (a `resend:<id>` row exists, in any status) carries
  `outboxResent: true`: a `failed` one, or a `blocked` one the resend cancelled. The web
  shows "Reenviada" instead of Reenviar or the raw cancelled status.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/list-messages.integration.test.ts` (3), moved from `apps/api/src/conversations.test.ts`,
and `tests/list-messages.failure.integration.test.ts` (1: every failure kind in one thread).

**Blocked on core.** Nothing.
