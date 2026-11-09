/**
 * `ingest-message` — turning what channel receives from Evolution into
 * conversations and messages.
 *
 * Moved from `apps/worker/src/ingest/**` (4A). Three inputs, all from channel:
 * - `channel/webhook-received` → {@link canonicalizeEvent}: a message insert, a
 *   delivery status, a deletion flag, or a `connection.update` state change.
 *   A NEW message publishes `conversations/message-received`.
 * - `channel/outbound-sent` → the canonical outbound insert after a send.
 * - `channel/history-record-fetched` → the history import's insert.
 * Plus {@link retryPendingEvents}, which the worker's heartbeat runs before
 * channel's reconcile (one job, ruling Q2-A), and the history import's seed guard.
 *
 * The worker's composition root subscribes the three handlers once per process
 * (`channel-events.ts`); this slice registers no job of its own.
 */
export { canonicalizeEvent, persistRawEvent, retryPendingEvents } from "./canonicalize.js";
export { canonicalizeReceivedWebhooks, ingestFetchedHistory, insertSentMessages } from "./channel-events.js";
export { ingestHistoryRecord, isHistoryBackfillBlockedBySeed } from "./history.js";
export { createIngestStore, type IngestStore } from "../internal/ingest-store.js";
export type { CanonicalMessage, ProviderStatus } from "../internal/canonical-message.js";
export { CLASSIFICATION_RULE_VERSION } from "../internal/origin.js";
