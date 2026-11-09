# resend-message

**Purpose.** `POST /conversations/:id/messages/:messageId/resend` — the attendant's
**Reenviar** on a text that did not go out (`hold-unknown-outcome-sends`): queues a copy
of it under `resend:<outbox id>`.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `createRoute(ports)` (reads `channelConnected`).

**Tables written.** None of its own. Channel's `resendUnsentOutbound` writes
`outbox_message` under `module_channel`: the copy, and `cancelled` on a blocked original.
Reads `conversation`, `outbox_message` and `scheduled_message` under `module_conversations`.

**Invariants.**

- The body is empty. The text is copied from the outbox row on the server, so a resend can
  only send what the row holds. Send-now refuses a `resend:` key (the contract's
  `sendIdempotencyKeySchema`), so nothing else can take the key this route looks up.
- Resendable: a text row that is `failed` (any origin, reminder copies included: the
  schedule stays `FAILED` as history), or `blocked` and sent by the attendant. A scheduled
  message's blocked copy stays with the due tick. The guard is `internal/outbox-failure.ts`,
  which also labels the thread, and channel re-checks it on the locked row.
- A second press returns the first copy; a blocked original is cancelled with the copy, in
  one transaction.
- 404 for another loja's thread or another conversation's row; 409 `DISCONNECTED` from the
  LIVE probe; 409 `resend_not_allowed` from the guard. The probe is awaited between the
  reads and the write, inside neither transaction (W2-C12).

**Tests.** `tests/resend-message.integration.test.ts` (11), one per scenario of conversas
"Attendant can resend a message that did not go out", plus the send-now key refusal.

**Blocked on core.** Nothing.
