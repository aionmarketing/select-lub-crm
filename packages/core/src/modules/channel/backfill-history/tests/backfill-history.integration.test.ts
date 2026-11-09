/**
 * Test design (testing-strategy)
 *
 * SUT: `backfillHistory` — the paging half of the Evolution history import —
 *   through the slice's entry point, on the worktree database inside a
 *   rolling-back transaction, with a stub `EvolutionHistory` and the published
 *   `channel/history-record-fetched` events captured. No live HTTP.
 *
 * Ran under module role: `channel` (the connection list runs on
 *   `db.tx("channel")`; the slice writes nothing).
 *
 * Moved from apps/worker/src/ingest/history.test.ts (adopt-modular-vertical-slices
 * 3A, exception W3-C5). That file had 18 cases. The 7 here are the paging ones:
 * which chats are paged, how many pages are requested, and when paging stops. The
 * other 11 — what a record becomes once inserted (timestamps, dedupe, LID chats,
 * origin) — are the subscriber's, and stayed in that file, now driven through
 * this slice with the ingest subscriber attached.
 *
 * WHAT CHANGED IN THE ASSERTIONS. "Imported" / "wrote nothing" was read from
 * `message` and `conversation`. The slice no longer writes those; it publishes
 * each fetched record. So an imported id is now a published record's `key.id`,
 * and "wrote nothing" is "published nothing". Two assertions got STRONGER: the
 * old file compared SORTED ids because the adapter promises no row order, but
 * events arrive in publish order, so the two-page and page-bound cases now assert
 * the records were handed over in page order.
 *
 * The stub answers only for THIS test's instance name: `listConnections` has no
 * WHERE, so the base and demo connections are walked too, and must get no chats.
 *
 * Oracle: whatsapp-history-backfill — groups and broadcasts skipped; an empty chat
 *   yields nothing; paging stops on the last page (`hasMore` false or an empty
 *   page), on a repeated page, and at the per-chat bound.
 *
 * Decisions
 *   D2 isGroupOrBroadcastJid on the chat — skip findMessages
 *   D4 records.length === 0 || !hasMore  — stop paging
 *   D6 unseenIds === 0 on a non-final page — stop (repeated page)
 *   D7 page >= maxPagesPerChat           — stop (bound); BVA at maxPagesPerChat=3
 *   D8 historyRowId                      — sampled by the repeated-page case
 *   D1 (empty connection list) is unreachable on a real database; the nearest
 *     real property is "walks every connection and publishes nothing".
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it, vi } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { capture } from "../../../../kernel/events.js";
import {
  historyRecordFetched,
  type HistoryRecordFetched,
} from "../../contracts/history-record-fetched.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { backfillHistory, type EvolutionHistory } from "../index.js";

const phoneJid = "5511999999999@s.whatsapp.net";
const groupJid = "120363@g.us";
const broadcastJid = "120363@broadcast";

const db = () => prisma as PrismaClient;

/** A findMessages record; only its `key.id` matters to the paging. */
function record(id: string) {
  return { key: { id, remoteJid: phoneJid, fromMe: false }, messageTimestamp: 1767268800 };
}

async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  return { connection, handle: createDb(tx, runInTransactionOnTx(tx)) };
}

/** An `EvolutionHistory` with chats and pages for one instance name only. */
function historyStub(
  instanceName: string,
  input: { chats?: { remoteJid: string }[]; pages?: Record<string, unknown[][]> },
) {
  const findChats = vi.fn(async (instance: string) => (instance === instanceName ? (input.chats ?? []) : []));
  const findMessagesPage = vi.fn(async (_instance: string, remoteJid: string, page: number) => {
    const records = input.pages?.[remoteJid]?.[page - 1] ?? [];
    const remaining = (input.pages?.[remoteJid]?.length ?? 0) > page;
    return { records, hasMore: remaining };
  });
  return { findChats, findMessagesPage } satisfies EvolutionHistory;
}

/** Runs `fn` and returns the provider ids published for `connectionId`, in order. */
async function publishedIds(connectionId: string, fn: () => Promise<void>): Promise<string[]> {
  const seen: HistoryRecordFetched[] = await capture(historyRecordFetched, fn);
  return seen
    .filter((event) => event.connectionId === connectionId)
    .map((event) => (event.record as { key: { id: string } }).key.id);
}

describeWithDatabase("backfill-history", () => {
  it("does not publish anything for a listed 1:1 chat with empty findMessages", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, { chats: [{ remoteJid: phoneJid }], pages: { [phoneJid]: [[]] } });

      const ids = await publishedIds(connection.id, () => backfillHistory(handle, { history }));

      expect(ids).toEqual([]);
      expect(history.findMessagesPage).toHaveBeenCalledTimes(1);
    }));

  it("does not page a group chat from findChats", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: groupJid }],
        pages: { [groupJid]: [[record("G1")]] },
      });

      const ids = await publishedIds(connection.id, () => backfillHistory(handle, { history }));

      expect(ids).toEqual([]);
      expect(history.findMessagesPage).not.toHaveBeenCalled();
    }));

  it("does not page a broadcast chat from findChats", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: broadcastJid }],
        pages: { [broadcastJid]: [[record("B1")]] },
      });

      const ids = await publishedIds(connection.id, () => backfillHistory(handle, { history }));

      expect(ids).toEqual([]);
      expect(history.findMessagesPage).not.toHaveBeenCalled();
    }));

  it("walks every connection and publishes nothing when no chat comes back", () =>
    withTestTransaction(db(), async (tx) => {
      // Stands in for the unreachable empty-connection-list arm; the loop IS
      // entered here — that is the difference.
      const { connection, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, { chats: [] });

      const ids = await publishedIds(connection.id, () => backfillHistory(handle, { history }));

      expect(history.findChats.mock.calls.map(([name]) => name)).toContain(connection.instanceName);
      expect(history.findMessagesPage).not.toHaveBeenCalled();
      expect(ids).toEqual([]);
    }));

  it("hands over a two-page chat completely, in page order, and stops when hasMore is false", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[record("P1")], [record("P2")]] },
      });

      const ids = await publishedIds(connection.id, () => backfillHistory(handle, { history }));

      expect(ids).toEqual(["P1", "P2"]);
      // Page 2 says hasMore: false, so there is no request for page 3.
      expect(history.findMessagesPage).toHaveBeenCalledTimes(2);
      expect(history.findMessagesPage.mock.calls.map(([, , page]) => page)).toEqual([1, 2]);
    }));

  it("stops paging a chat that repeats the same full page forever", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, handle } = await setup(tx);
      const repeated = Array.from({ length: 50 }, (_, i) => record(`REP-${i}`));
      const findChats = vi.fn(async (instance: string) =>
        instance === connection.instanceName ? [{ remoteJid: phoneJid }] : [],
      );
      const findMessagesPage = vi.fn(async () => ({ records: repeated, hasMore: true }));
      const logs: string[] = [];

      const ids = await publishedIds(connection.id, () =>
        backfillHistory(handle, { history: { findChats, findMessagesPage }, log: (m) => logs.push(m) }),
      );

      expect(findMessagesPage).toHaveBeenCalledTimes(2);
      // Both pages are handed over — the subscriber's unique index makes the
      // second a no-op — and the repeat is what ends the chat.
      expect(new Set(ids).size).toBe(50);
      expect(logs).toContain("history backfill stopped repeated page 2");
    }));

  it("stops at the per-chat page bound when every page has new ids", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, handle } = await setup(tx);
      const findChats = vi.fn(async (instance: string) =>
        instance === connection.instanceName ? [{ remoteJid: phoneJid }] : [],
      );
      const findMessagesPage = vi.fn(async (_instance: string, _remoteJid: string, page: number) => ({
        records: [record(`FRESH-${page}`)],
        hasMore: true,
      }));

      const ids = await publishedIds(connection.id, () =>
        backfillHistory(handle, { history: { findChats, findMessagesPage }, maxPagesPerChat: 3 }),
      );

      expect(findMessagesPage).toHaveBeenCalledTimes(3);
      expect(ids).toEqual(["FRESH-1", "FRESH-2", "FRESH-3"]);
    }));
});
