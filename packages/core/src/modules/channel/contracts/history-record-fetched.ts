/**
 * `channel/history-record-fetched` — the history backfill fetched one message
 * record from Evolution's `findMessages`.
 *
 * WHY AN EVENT (W3-C5, the sibling of W3-C4; resolved in 4A). The backfill is
 * two jobs. Paging Evolution's history API is transport, so it is `channel`'s:
 * listing connections, listing chats, skipping groups, and the pagination with
 * its repeated-page guard and page bound. Turning a record into a canonical
 * message is ingestion, a write to `conversations`' tables: the subscriber is
 * `conversations`' `ingestFetchedHistory` (`ingest-message`), wired by the
 * worker's composition root, which inserts under `db.tx("conversations")`.
 *
 * Published once per fetched record, in page order, and awaited, so the
 * subscriber sees records exactly as sequentially as the old loop inserted them.
 */
import { z } from "zod";
import { defineEvent } from "../../../kernel/events.js";

/** One raw history record and the connection it was fetched for. */
export const historyRecordFetchedSchema = z.object({
  /** The `whatsapp_connection` row the chat belongs to. */
  connectionId: z.string().min(1),
  /** One element of Evolution's `findMessages` records, as returned. */
  record: z.unknown(),
});

/** The payload of {@link historyRecordFetched}. */
export type HistoryRecordFetched = z.infer<typeof historyRecordFetchedSchema>;

/** Published by `backfill-history` for every record it fetches. */
export const historyRecordFetched = defineEvent<HistoryRecordFetched>(
  "channel/history-record-fetched",
  historyRecordFetchedSchema,
);
