# ingest-message

**Purpose.** Turn what channel receives from Evolution into conversations and messages:
each webhook becomes a message insert, a delivery status, a deletion flag, or a connection
state change; each confirmed send becomes the thread's outbound message; each fetched
history record becomes a backfilled message.

**Kind.** Event subscribers plus one function the worker's heartbeat calls. Entry points:

- `canonicalizeReceivedWebhooks(store, log)` — subscribes to `channel/webhook-received`.
- `insertSentMessages(store)` — subscribes to `channel/outbound-sent`.
- `ingestFetchedHistory(store)` — subscribes to `channel/history-record-fetched`.
- `retryPendingEvents(store, now, log)` — the heartbeat's retry pass, before channel's reconcile.
- `isHistoryBackfillBlockedBySeed(store)` — the history import's seed guard.
- `createIngestStore(db)` — the store all of the above run through.

The worker's composition root subscribes the three handlers once per process; this slice
registers no job.

**Tables written.**

- Own, under `db.tx("conversations", …)`: `conversation` (the upsert and its extrema,
  the origin classification, the history watermark), `message` (insert, provider status,
  content unavailable).
- Channel's, through `@select-lub/core/modules/channel/contracts`, under
  `module_channel`: `webhook_event` (`recordWebhookEvent`, `markWebhookEvent`,
  `incrementWebhookEventAttempt`) and `whatsapp_connection` (`updateConnectionState`, for
  `connection.update`).

**Events published.** `conversations/message-received`, once per NEWLY inserted message on
the webhook path, after the event is marked processed and outside the try that marks it: a
subscriber that throws is logged and never changes the event's status. Not for history
backfill, not for the drain's outbound insert.

**Invariants.**

- One canonical row per `(conversation_id, external_message_id)`: a redelivery, a retry
  racing a live webhook, or a backfill of a live message is a no-op insert.
- One conversation per `(whatsapp_connection_id, chat_key)`: `@c.us`, device suffixes and
  LID JIDs resolved to a phone converge.
- A thread's origin only upgrades (`UNKNOWN`/`ORGANIC` → `AD`), never downgrades.
- Delivery status is monotonic (`sent` < `delivered` < `read`); `failed` only from nothing or `sent`.
- A backfilled message closes the prefill window up to its own timestamp, so history never
  opens a live window.
- An event is retried until `WEBHOOK_RETRY_MAX_ATTEMPTS`, then `failed_permanent`.
- Since 4A no write here runs under the login role: exceptions W3-C4, W3-C5 and W3-C6 end.

**Tests.** `tests/`, 49 cases over `ingest.fixture.ts`: 45 moved from
`apps/worker/src/ingest/`: `ingest-message.integration` (13, canonicalize) and
`ingest-message.store.integration` (3) from `canonicalize.test.ts` (16);
`.retry` (6), `.status` (9), `.origin` (6), `.connection-state` (8); and `.publish` (4, new):
when `message-received` is and is not published, and that a throwing subscriber leaves the
event processed. The parser and origin
suites (126 + 25) are pure and live in `packages/core/test/conversations-{parse,origin}.test.ts`,
because `internal/` may not import the test fixtures; the live status case is
`packages/core/test/conversations-status.live.test.ts`. The history insert's 11 cases stay in
`apps/worker/test/history.test.ts`, which drives channel's backfill with this subscriber.

**Blocked on core.** Nothing.
