# send-message

**Purpose.** `POST /conversations/:id/messages` — queues an attendant's text for the worker to send.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `createRoute(ports)` (reads `channelConnected`).

**Tables written** (under `db.tx("conversations", …)`): None of its own: the outbox row is channel's, written through `enqueueOutbound` under `module_channel`.

**Invariants.**

- Refuses (409 `DISCONNECTED`) when the LIVE probe says the session is down; the stored column never decides a send.
- The probe is awaited between the loja check and the outbox write, inside neither transaction (W2-C12).
- A resubmitted `idempotencyKey` returns its row untouched, never re-sent (`onExisting: "keep"`): exactly-once stands.
- A key starting with `resend:` is a 400: that namespace is the resend's (`resend-message`).
- This process never sends WhatsApp; it writes an outbox row the worker drains.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/send-message.integration.test.ts` (5), moved from `apps/api/src/conversations{,.media}.test.ts`.

**Blocked on core.** Nothing.
