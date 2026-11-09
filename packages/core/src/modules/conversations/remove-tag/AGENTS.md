# remove-tag

**Purpose.** `DELETE /conversations/:id/tags/:tagId` — takes a tag off a conversation.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): `conversation_tag` (`removed_at` on the open row; history is kept).

**Invariants.**

- A tag that is not open on the thread answers 404.
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
