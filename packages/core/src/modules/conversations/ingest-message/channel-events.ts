/**
 * This module's subscribers to channel's three events.
 *
 * Moved from `apps/worker/src/channel-wiring.ts` (4A). In 3A they lived in the
 * worker and wrote `conversation` and `message` under the login role: those were
 * exceptions W3-C4 (outbound-sent), W3-C5 (history-record-fetched) and W3-C6
 * (webhook-received). Here they write through `createIngestStore(db)`, so this
 * module's tables are written under `module_conversations` and channel's
 * `webhook_event` / `whatsapp_connection` through channel's contracts under
 * `module_channel`. The worker's composition root still does the subscribing, once
 * per process.
 *
 * `publish` awaits every subscriber, so each keeps the old ordering: the message
 * is inserted before the drain confirms the row, and a subscriber that throws
 * fails its publisher as the direct call did.
 */
import { subscribe } from "../../../kernel/events.js";
import {
  historyRecordFetched,
  outboundSent,
  webhookReceived,
} from "../../channel/contracts/index.js";
import type { IngestStore } from "../internal/ingest-store.js";
import { canonicalizeEvent } from "./canonicalize.js";
import { ingestHistoryRecord } from "./history.js";

/**
 * Canonicalizes every webhook channel receives.
 *
 * @param store - Ingest persistence.
 * @param log - Origin lines and canonicalization errors.
 * @returns Unsubscribe.
 */
export function canonicalizeReceivedWebhooks(store: IngestStore, log: (message: string) => void): () => void {
  return subscribe(webhookReceived, ({ eventId }) => canonicalizeEvent(store, eventId, log));
}

/**
 * Inserts the canonical outbound message for every send the drain confirms with a
 * provider timestamp. Publishes no `message-received`, as the old path fired no hook.
 *
 * @param store - Ingest persistence.
 * @returns Unsubscribe.
 */
export function insertSentMessages(store: IngestStore): () => void {
  return subscribe(outboundSent, async (sent) => {
    await store.runConversationMessageTransaction(sent);
  });
}

/**
 * Parses and inserts every record the history backfill fetches.
 *
 * @param store - Ingest persistence.
 * @returns Unsubscribe.
 */
export function ingestFetchedHistory(store: IngestStore): () => void {
  return subscribe(historyRecordFetched, ingestHistoryRecord(store));
}
