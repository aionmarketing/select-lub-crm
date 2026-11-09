/**
 * `backfill-history` — pages Evolution's stored chat history and hands every
 * record over as a `channel/history-record-fetched` event (exception W3-C5).
 *
 * Moved from `apps/worker/src/ingest/history.ts` (`runHistoryBackfill`), keeping
 * the transport half: list every connection, list its chats, skip groups and
 * broadcasts, page each chat's messages, stop on the last page, on a repeated
 * page, or at the page bound. The ingest half — parse a record and insert the
 * canonical message with `fromHistory` — stays in `apps/worker/src/ingest`, as
 * the event's subscriber, until wave 4A. So does the seed guard, which the
 * worker checks before calling this at all.
 *
 * Records are published in page order and awaited one at a time, so the
 * subscriber inserts them exactly as sequentially as the old loop did, and an
 * insert that throws stops the backfill there, as it did before.
 *
 * LID-addressed chats are paged like any other. The chat object carries only its
 * `@lid` JID; the phone lives on each message's `remoteJidAlt`, so whether a
 * chat is usable can only be decided per message, by the subscriber.
 *
 * No transaction is open while Evolution is awaited (W2-C12), or while a record
 * is published: the connection list is read in its own `db.tx("channel")`.
 */
import type { Db } from "../../../kernel/db.js";
import { publish } from "../../../kernel/events.js";
import { isGroupOrBroadcastJid } from "../contracts/evolution-format.js";
import { historyRecordFetched } from "../contracts/history-record-fetched.js";
import type { EvolutionHistory } from "../internal/ports.js";

export type { EvolutionHistory } from "../internal/ports.js";

/** Safety cap on findMessages pages per chat. */
export const HISTORY_MAX_PAGES_PER_CHAT = 500;

/** What the backfill needs. */
export type BackfillHistoryOptions = {
  history: EvolutionHistory;
  /** Page-bound and per-instance progress; message bodies never reach it. */
  log?: (message: string) => void;
  /** Defaults to {@link HISTORY_MAX_PAGES_PER_CHAT}. */
  maxPagesPerChat?: number;
};

/** A record's provider id, used only to notice a page that repeats. */
function historyRowId(row: unknown): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const key = (row as Record<string, unknown>).key;
  if (!key || typeof key !== "object" || Array.isArray(key)) {
    return null;
  }
  const id = (key as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Pages every connection's 1:1 chat history and publishes each record.
 *
 * @param db - The database handle; the connection list runs on `db.tx("channel", …)`.
 * @param options - The history client, an optional log and page bound.
 * @returns Resolves when every connection and chat has been paged.
 * @throws What `findChats`, `findMessagesPage` or a subscriber throws.
 */
export async function backfillHistory(db: Db, options: BackfillHistoryOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const maxPages = options.maxPagesPerChat ?? HISTORY_MAX_PAGES_PER_CHAT;
  const connections = await db.tx("channel", (tx) =>
    tx.whatsAppConnection.findMany({ select: { id: true, instanceName: true } }),
  );
  for (const connection of connections) {
    const chats = await options.history.findChats(connection.instanceName);
    for (const chat of chats) {
      if (isGroupOrBroadcastJid(chat.remoteJid)) {
        continue;
      }
      const seenIds = new Set<string>();
      let page = 1;
      for (;;) {
        const { records, hasMore } = await options.history.findMessagesPage(
          connection.instanceName,
          chat.remoteJid,
          page,
        );
        let unseenIds = 0;
        for (const record of records) {
          const rowId = historyRowId(record);
          if (rowId && !seenIds.has(rowId)) {
            seenIds.add(rowId);
            unseenIds += 1;
          }
          await publish(historyRecordFetched, { connectionId: connection.id, record });
        }
        if (records.length === 0 || !hasMore) {
          break;
        }
        if (unseenIds === 0) {
          log(`history backfill stopped repeated page ${page}`);
          break;
        }
        if (page >= maxPages) {
          log(`history backfill page bound reached at page ${page}`);
          break;
        }
        page += 1;
      }
    }
    log(`history backfill instance ${connection.instanceName}`);
  }
}
