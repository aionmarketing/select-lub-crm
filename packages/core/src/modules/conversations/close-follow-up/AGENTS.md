# close-follow-up

**Purpose.** `POST /follow-ups/close` — closes one message-pendency entry against the anchor that qualified it.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (under `db.tx("conversations", …)`): `follow_up_closed_entry` (upsert on `(section, conversation_id, anchor)`).

**Invariants.**

- Closing an already-closed entry is the same statement (the upsert), never a duplicate or an error.
- A newer anchor (a newer quote, a newer pending inbound) brings the entry back with no job and no expiry.
- Another loja's conversation answers 404, never 403, and writes nothing.
- Returns do not close here; they close through their own archive route.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/close-follow-up.integration.test.ts` (1). The close-then-read cases are in `apps/api/test/follow-up.integration.test.ts`; the table's own cases are `packages/core/test/conversations-follow-up-closed.live.test.ts`.

**Blocked on core.** Nothing.
