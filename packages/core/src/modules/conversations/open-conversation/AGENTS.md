# open-conversation

**Purpose.** `POST /conversations` — Nova conversa: opens a thread for a phone on the configured connection, or reopens the one that number already has.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `createRoute(ports)` (reads `instanceName`); `openConversation(db, input)` for the store alone.

**Tables written** (under `db.tx("conversations", …)`): `conversation` (insert).

**Invariants.**

- Refuses (409 `channel_not_connected`) unless the CONFIGURED connection is this loja's and its STORED `connection_state` is `CONNECTED`. The live probe is not consulted: the two-source rule.
- One row per `(whatsapp_connection_id, chat_key)`: a repeat phone reopens (200), never duplicates.
- An insert that loses that unique index to a concurrent writer (the webhook ingest) answers `existing`; the conflict is caught after its `db.tx` rolled back.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/`: `open-conversation.integration` (2) and `.fake-client` (9, one new: the lost-race branch). The create-then-list cases and #102's chat-key uniqueness case are in `apps/api/test/conversations.integration.test.ts`.

**Blocked on core.** Nothing.
