# backfill-history

**Purpose.** Import the chat history Evolution already holds (pre-CRM messages, PEND-CH-07):
page every connection's 1:1 chats through Evolution's REST API and hand each record over.

**Kind.** A one-shot function, `backfillHistory(db, { history, log?, maxPagesPerChat? })`.
`apps/worker` calls it once at start-up when `WORKER_HISTORY_BACKFILL=1`, and the
`backfill:once` script calls it on its own; both check ingest's seed guard first.

**Tables written.** None. Reads `whatsapp_connection` under `db.tx("channel", …)`.

**Events published.** `channel/history-record-fetched` (exception W3-C5), once per fetched
record, in page order, awaited. Until 4A its subscriber is ingest's `ingestHistoryRecord`,
which parses the record and inserts it with `fromHistory`.

**Invariants.**

- Group, broadcast, status and newsletter chats are never paged. LID chats are paged; the
  subscriber decides per message.
- Paging a chat stops on an empty page or `hasMore: false`, on a page that brings no new
  provider id, or at `maxPagesPerChat` (500).
- Evolution is awaited, and records are published, outside any transaction (W2-C12).
- A subscriber that throws stops the backfill there.

**Tests.** `tests/backfill-history.integration.test.ts`, 7 paging cases moved from
`apps/worker/src/ingest/history.test.ts`. That file's other 11 pin the insert and stayed
there, driven through this function with the subscriber attached.

**Blocked on core.** Nothing. `isGroupOrBroadcastJid` is channel's `contracts/evolution-format.ts`, shared with conversations since 4A.
