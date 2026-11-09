# reopen-follow-up

**Purpose.** `POST /follow-ups/reopen` — reopens a closed entry, putting it back in its section and its count.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`.

**Tables written** (under `db.tx("conversations", …)`): `follow_up_closed_entry` (delete).

**Invariants.**

- Reopening an entry that is not closed is 200: it is then listed, which is what was asked for.
- Another loja's conversation answers 404 and its row is left alone.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/reopen-follow-up.integration.test.ts` (1, new). The close-reopen-read case is in `apps/api/test/follow-up.integration.test.ts`.

**Blocked on core.** Nothing.
