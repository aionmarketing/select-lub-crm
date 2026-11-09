# fetch-media

**Purpose.** `GET /conversations/:id/messages/:messageId/media` — a media message's bytes: from Evolution for a canonical message, from the outbox row for a send still in flight.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `createRoute(ports)` (reads `channelConnected` and `fetchMedia`); `fetchMedia(db, ports, input)`.

**Tables written** (under `db.tx("conversations", …)`): None (reads `conversation`, `whatsapp_connection`, `message`, `outbox_message`).

**Invariants.**

- The download is addressed at the CONVERSATION'S OWN connection's instance, never the configured one.
- Bytes are never stored on the canonical message.
- 502 `media_unavailable` when the LIVE probe is down (the port is not called) or Evolution has no file; 404 for text, unknown types and other lojas.
- The probe and the download are awaited after the reads, inside no transaction (W2-C12).
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/fetch-media.integration.test.ts` (8), moved from `apps/api/src/conversations.media.test.ts`.

**Blocked on core.** Nothing.
