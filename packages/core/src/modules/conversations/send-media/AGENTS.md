# send-media

**Purpose.** `POST /conversations/:id/messages/media` — queues an attendant's image, audio, document or video (multipart) for the worker to send.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `createRoute(ports)` (reads `channelConnected`).

**Tables written** (under `db.tx("conversations", …)`): None of its own: the outbox row is channel's, written through `enqueueOutbound` under `module_channel`.

**Invariants.**

- 400 for no file, a bad field or a file over `MEDIA_MAX_BYTES`; nothing is written.
- Refuses (409 `DISCONNECTED`) on the LIVE probe, awaited outside any transaction.
- A resubmitted `idempotencyKey` returns its row untouched.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/send-media.integration.test.ts` (7), moved from `apps/api/src/conversations.media.test.ts`.

**Blocked on core.** Nothing.
