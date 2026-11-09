# apply-tag

**Purpose.** `POST /conversations/:id/tags/:tagId` — puts a tag on a conversation.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (`conversations`-owned, under `db.tx("conversations", …)`): `conversation_tag`.

**Invariants.**

- Idempotent: a second apply of an open tag is 200 and adds no row; a concurrent apply that loses the unique index is 200 too.
- An inactive tag answers 409; another loja's conversation or tag answers 404.
- A removed tag can be applied again (a new row; the old keeps its `removed_at`).
- The caller's loja scopes everything; a request with no unit resolved gets the old empty answer.

**Tests.** `tests/`; the cases that chain several tag routes live in
`apps/api/test/tags.integration.test.ts`, moved from `apps/api/src/tags.test.ts`.

**Blocked on core.** Nothing.
