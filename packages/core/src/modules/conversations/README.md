# conversations

WhatsApp threads, their messages, tags and templates, and the Follow-up queue built on
them. Owns `conversation`, `message`, `tag`, `template`, `conversation_tag` and
`follow_up_closed_entry`; reads channel's, customers', quotes', services' and
scheduling's tables for its joins and labels. Channel's tables (`webhook_event`,
`whatsapp_connection` writes, `outbox_message` writes) are reached only through
`@select-lub/core/modules/channel/contracts`.

- **index.ts** — the only thing the apps import: `createHttpPlugin(ports)` (twenty-one
  routes), the ingest subscribers and store the worker wires, and `unansweredQuoteCount`
  for the reports port.
- **ingest-message/** — webhook → message, delivery status, deletion, connection state;
  the drain's sent message; the history backfill. Subscribers, no route.
- **list-conversations/**, **open-conversation/**, **list-messages/**, **send-message/**,
  **send-media/**, **resend-message/**, **fetch-media/** — the inbox and a thread. `queries.ts` where a slice
  has one.
- **list-tags/**, **list-tag-apply-options/**, **create-tag/**, **update-tag/**,
  **list-templates/**, **create-template/**, **update-template/**, **apply-tag/**,
  **remove-tag/**, **preview-template/** — tags and templates.
- **list-follow-ups/**, **count-follow-ups/**, **close-follow-up/**, **reopen-follow-up/**
  — the Follow-up queue. Every slice has an `AGENTS.md`.
- **contracts/** — public, `@select-lub/core/modules/conversations/contracts`:
  - `get-cadastro-link.ts` and `set-customer.ts` — `getCadastroLink` and `setCustomer`, for
    customers (4B) and prefill; they replaced 4B's stubs at the same paths
  - `set-extract-enabled.ts` — `setExtractEnabled` and `closePrefillWindow` (forward-only)
  - `message-received.ts` — the event, published once per NEW webhook insert
  - `http.ts` — the web contract, over `http.conversation.ts`, `http.follow-up.ts`,
    `http.tag.ts`, `http.template.ts`, `http.jid.ts`, `http.should-reply.ts` and the test
    fixtures in `http.fixtures.ts` (defined here since 5.1d)
- **internal/** — shared by the slices, importable by nobody else:
  - `ingest-store.ts`, `parse.ts`, `origin.ts`, `canonical-message.ts` — ingestion
  - `conversation-dto.ts` — rows → `ConversationSummary` / `ConversationMessage`
  - `conversation-scope.ts` — the loja gate every thread route passes first
  - `outbound.ts` — a send through channel's outbox contract
  - `tag-store.ts`, `interpolate.ts` — tags, templates, chips, the tag filter, previews
  - `follow-up-snapshot.ts`, `follow-up-aggregate.ts`, `follow-up-returns.ts`,
    `follow-up-closed.ts` — the Follow-up read and the closed set
  - `ports.ts`, `params.ts` — what `createHttpPlugin` takes; path params and small bodies

The two-method shim the api used to hand the prefill routes,
`apps/api/src/http/conversation-link.ts`, is gone (4C): prefill's slices call
`contracts/get-cadastro-link.ts` and `contracts/set-customer.ts` directly.

Moved from `apps/api/src/{conversations,tags,follow-up}/`, `apps/worker/src/ingest/` and
`packages/db/src/follow-up-closed-entries.ts` in adopt-modular-vertical-slices 4A.
