# services / list-conversation-services

**Purpose.** `GET /conversations/:id/services`: the service orders of whoever a
conversation is with, for the Conversas rail.

**Kind.** HTTP query. Entry points: `listConversationServices(db, unitId, conversationId)`
and `route`.

**Tables written.** None. Reads `conversation` (conversations', joined to
`whatsapp_connection` for the loja), `customer` and `customer_phone` (customers'), all
`readableBy`, then `service` and `service_item` — one `db.tx("services", …)` per read,
as the route's store calls were.

**Invariants.**

- The conversation must hang off a connection of the caller's loja, or it is a 404.
- Its customer is the one it names when that customer is in the loja; otherwise the
  loja's customer whose phone `normalized` IS the conversation's `chatKey`, newest
  phone row first.
- No customer resolving is a 200 with `{ customerId: null, services: [] }` — the
  conversation exists, it just has no one attached.

**Tests.** `tests/list-conversation-services.integration.test.ts`, 4 cases from
`apps/api/src/customer-services.test.ts`, assertions unchanged.
