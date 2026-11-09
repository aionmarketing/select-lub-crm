# list-conversations

**Purpose.** `GET /conversations` — the inbox list: the loja's threads, newest first, filtered by search, unanswered, origin, pipeline stage, period and tags, each with its tag chips.

**Kind.** HTTP route on the api's app, mounted by the conversations module's
`createHttpPlugin(ports)`. Entry point: `route`; `listConversations(db, unitId, query)` for the read alone.

**Tables written** (under `db.tx("conversations", …)`): None (reads `conversation`, `message`, `customer`, `oil_quote`, `service_conversation_attribution`, `conversation_tag`, `tag`).

**Invariants.**

- Scoped through the join `conversation → whatsapp_connection → unit_id`; there is no unit column on a conversation.
- A filter value that names nothing (`origin`, `stage`) answers an EMPTY list, never the unfiltered one.
- The stage cut is cumulative (stage or later), the same rule the Relatórios funnel counts with.
- The period is inclusive calendar days in America/Sao_Paulo over `first_inbound_at`; a thread with none is left out of a bounded period.
- An unknown tag id yields nothing, never the unfiltered list.
- The caller's loja scopes everything; the path and every status code are unchanged from
  `apps/api/src/{conversations,follow-up}/routes.ts` (moved in 4A).

**Tests.** `tests/`: `list-conversations.integration` (9), `.filters.integration` (12), `.fake-client` (3), over `conversation-list.fixture.ts`. Moved from `apps/api/src/conversations{,.filters.route}.test.ts` and `conversations/prisma.test.ts`.

**Blocked on core.** Nothing.
