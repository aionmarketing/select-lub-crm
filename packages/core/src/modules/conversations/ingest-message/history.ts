/**
 * The insert side of the Evolution REST history import.
 *
 * Moved from `apps/worker/src/ingest/history.ts` (4A). The paging — connections,
 * chats, groups skipped, pages, the repeated-page guard and the page bound — is
 * channel's `backfill-history`, which publishes every fetched record as
 * `channel/history-record-fetched`. What a record BECOMES stays here:
 * {@link ingestHistoryRecord} parses it and inserts the canonical message through
 * the same transaction as live ingest, now under `module_conversations` (W3-C5
 * ends), and {@link isHistoryBackfillBlockedBySeed} decides whether the import may
 * run at all.
 */
import type { HistoryRecordFetched } from "../../channel/contracts/index.js";
import type { IngestStore } from "../internal/ingest-store.js";
import { parseHistoryMessage } from "../internal/parse.js";

/**
 * Whether seeded demo history is present, which forbids Evolution REST import.
 *
 * @param store - Ingest persistence that can count `SEED` messages.
 */
export async function isHistoryBackfillBlockedBySeed(store: IngestStore) {
  return (await store.countSeedOriginMessages()) > 0;
}

/**
 * Builds the `channel/history-record-fetched` subscriber: parse one REST record
 * and insert it as a canonical message with `fromHistory`, or skip it.
 *
 * A record is skipped — silently, as before — when it has no provider id, no
 * usable timestamp, a group or broadcast JID on the message itself, or a LID with
 * no recoverable phone. A duplicate id is a no-op through the message unique
 * index, so a second import or an id already stored from live ingest stays one row.
 * It publishes no `message-received`: backfilled history must not open a live window.
 *
 * @param store - Ingest persistence the message is written through.
 * @returns The subscriber; it rethrows an insert failure, which stops the backfill.
 */
export function ingestHistoryRecord(store: IngestStore) {
  return async ({ connectionId, record }: HistoryRecordFetched): Promise<void> => {
    const parsed = parseHistoryMessage(record, connectionId);
    if (parsed.status === "skip") {
      return;
    }
    await store.runConversationMessageTransaction(parsed.message, { fromHistory: true });
  };
}
