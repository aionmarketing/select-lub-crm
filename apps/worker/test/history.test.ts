/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/history.test.ts (4A): the insert side is the
 * conversations module's now, so the store is its createIngestStore (module_conversations);
 * the file stays in the worker because it drives channel's backfill and the
 * conversations subscriber together, which only a composition root may import.
 *
 * Setup: channel's `backfillHistory` (`@select-lub/core/modules/channel`) with
 * ingest's `ingestHistoryRecord` subscribed to `channel/history-record-fetched`
 * through the worker's own wiring (`ingestFetchedHistory`, subscribed in worker.ts) — against the real Prisma
 * ingest store on the worktree database inside a rolling-back test transaction
 * (`withTestTransaction`), plus a stub `EvolutionHistory`. No webhook persist,
 * no live HTTP.
 *
 * SPLIT BY THE W3-C5 EVENT (adopt-modular-vertical-slices 3A). The paging moved
 * to channel; what a record becomes once inserted stayed with ingest. Of this
 * file's 18 cases, the 7 that pin paging — which chats are paged, how many pages,
 * when paging stops — moved to
 * packages/core/src/modules/channel/backfill-history/tests/, where they read the
 * published records. The 11 below pin the insert, and still read the rows.
 * Decisions D2, D4, D6 and D7 are covered there; D3, D5, D8's insert side and D9
 * here. The sampled-cell and output lists below are the original file's.
 *
 * Spec (whatsapp-history-backfill): REST 1:1 rows go through the same
 * conversation+message transaction as live ingest; no webhook_event;
 * groups skipped; empty chats do not create conversations; missing
 * timestamps skip that row only; second run / live-ingest id stay one row;
 * paging terminates on repeated pages and at the per-chat page bound.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Three, and
 * the third could not be corrected — it was removed and is recorded here.
 *
 *   1. Every `store.conversations()[0]`, `store.messages()` and `store.events()`
 *      read was an absolute index or an absolute count over the fake's maps. The
 *      database also holds the pristine base and the demo seed, so each becomes a
 *      lookup by the conversation's own `(whatsappConnectionId, chatKey)` key or a
 *      count scoped to this test's connection (design.md D9).
 *
 *   2. `expect(store.messages().map(r => r.externalMessageId)).toEqual([...])`
 *      asserted an ORDER. The fake returned insertion order from a Map; the
 *      adapter's `findMany` promises no order at all, and the fixture gives every
 *      row the same `messageTimestamp`, so even ordering by provider timestamp
 *      would not settle it. Those assertions now compare sorted id lists, which is
 *      the fact actually under test (which rows landed), not an artefact of how
 *      the fake stored them.
 *
 *   3. REMOVED: "does not call Evolution when there are no connections", which
 *      covered decision D1 (an empty `listConnections()` never reaches
 *      `findChats`). It is not reproducible against a real worktree database: the
 *      adapter's `listConnections()` has no WHERE, and the pristine base always
 *      holds connections, so the list is never empty. Emptying the table inside
 *      the transaction would take write locks on every base connection row and
 *      block every other file running in parallel (design.md Risks), which is a
 *      large cost for one arm. The nearest real property is kept instead, as
 *      "walks every connection and writes nothing when no chat comes back": the
 *      loop is entered, `findChats` is called, and nothing is written. D1's
 *      literal empty-list arm is now uncovered in this repository; it is recorded
 *      here rather than hidden.
 *
 * Consequence for the stub, the same one reconcile.test.ts documents: because
 * `listConnections()` really does return every connection in the database, the
 * stub answers with chats only for THIS test's instance name and returns an empty
 * chat list for the base and demo connections. That keeps every write inside rows
 * this test created, and keeps the `findMessagesPage` call counts exact.
 *
 * Axes
 *   1. chat JID — 1:1 vs @g.us / @broadcast
 *   2. findMessages records — one row vs empty vs mixed timestamp
 *   3. prior store — empty vs same id from live ingest vs prior backfill
 *   4. paging — single page vs two pages vs repeated identical pages vs
 *      unbounded fresh pages (bound)
 *   5. origin evidence — REST ctwa / inbound empty / outbound empty
 *
 *   BVA on the page bound (edge maxPagesPerChat=3 in test): exactly 3 requests.
 *
 * Outputs: O1 one message+conversation; O2 unchanged count; O3 empty inbox;
 *   O4 zero webhook events from REST; O5 bounded findMessages request count;
 *   O6 AD; O7 ORGANIC; O8 UNKNOWN.
 *
 * Decisions
 *   D1 listConnections empty          — NOT REACHABLE, see note 3 above
 *   D2 isGroupOrBroadcastJid          — skip findMessages
 *   D3 parseHistoryMessage skip       — missing timestamp vs insert
 *   D4 records.length === 0 || !hasMore — stop paging
 *   D5 runConversationMessageTransaction duplicate key — inserted false
 *   D6 unseenIds === 0 on a non-final page — stop paging (repeated page)
 *   D7 page >= maxPagesPerChat        — stop paging (bound)
 *   D8 historyRowId missing           — null / empty key.id vs string id
 *   D9 origin on first REST row       — ctwa → AD; inbound empty → ORGANIC;
 *      outbound empty → UNKNOWN (same helper as live ingest)
 *
 * Sampled-cell (origin)
 *   REST row with ctwa     | 5 ctwa     | O6 | ORGANIC/UNKNOWN
 *   inbound-first empty    | 5 inbound  | O7 | UNKNOWN
 *   outbound-first empty   | 5 outbound | O8 | ORGANIC
 *
 * Out of scope: Evolution HTTP (evolution.test.ts); worker flag (worker.test.ts);
 *   live upgrade ORGANIC→AD (origin.ingest.test.ts).
 *   Watermark GREATEST on fromHistory is sampled by the REST insert `it`
 *   (should-reply-window: backfill must not open a live window).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { expect, it, vi } from "vitest";
import { expectedTimestamp, historyRow, upsertPayload } from "@select-lub/core/testing";
import { kernel } from "@select-lub/core";
import { backfillHistory, type EvolutionHistory } from "@select-lub/core/modules/channel";
import {
  canonicalizeEvent,
  createIngestStore,
  ingestFetchedHistory,
  persistRawEvent,
  type IngestStore as Persistence,
} from "@select-lub/core/modules/conversations";

const phoneJid = "5511999999999@s.whatsapp.net";
const phoneChatKey = "5511999999999";
const groupJid = "120363@g.us";

const db = () => prisma as PrismaClient;

/**
 * Seeds a unit and a connection and builds the real ingest store on `tx`.
 *
 * @param tx - The test transaction.
 * @returns The connection row, the store built on `tx`, and channel's handle.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const store = createIngestStore(kernel.createDb(tx, runInTransactionOnTx(tx)));
  const handle = kernel.createDb(tx, runInTransactionOnTx(tx));
  return { connection, store, handle };
}

/**
 * Runs the backfill the way the worker wires it: the ingest subscriber attached
 * for the length of the call, then removed.
 *
 * @param handle - The channel's database handle over the test transaction.
 * @param store - The ingest store the subscriber writes through.
 * @param history - The stub Evolution history.
 */
async function backfill(handle: kernel.Db, store: Persistence, history: EvolutionHistory) {
  const off = ingestFetchedHistory(store);
  try {
    await backfillHistory(handle, { history });
  } finally {
    off();
  }
}

/**
 * An `EvolutionHistory` that answers only for one instance name.
 *
 * Every other instance — the base and demo connections the adapter's
 * `listConnections()` also returns — gets an empty chat list, so the backfill
 * walks them and writes nothing. See the fake-only note in the header.
 *
 * @param instanceName - The instance this stub has chats for.
 * @param input - Chats to return and, per remote JID, the pages of records.
 * @returns The stub, with both methods as spies.
 */
function historyStub(
  instanceName: string,
  input: { chats?: { remoteJid: string }[]; pages?: Record<string, unknown[][]> },
): EvolutionHistory & {
  findChats: ReturnType<typeof vi.fn>;
  findMessagesPage: ReturnType<typeof vi.fn>;
} {
  const findChats = vi.fn(async (instance: string) =>
    instance === instanceName ? (input.chats ?? []) : [],
  );
  const findMessagesPage = vi.fn(async (_instance: string, remoteJid: string, page: number) => {
    const records = input.pages?.[remoteJid]?.[page - 1] ?? [];
    const remaining = (input.pages?.[remoteJid]?.length ?? 0) > page;
    return { records, hasMore: remaining };
  });
  return { findChats, findMessagesPage };
}

/**
 * The provider ids this connection holds, sorted.
 *
 * Sorted because the adapter promises no row order and the fixture gives every
 * row the same provider timestamp; see the fake-only note in the header.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection to scope to.
 * @returns Sorted external message ids.
 */
async function messageIds(tx: DbClient, connectionId: string): Promise<string[]> {
  const rows = await tx.message.findMany({
    where: { conversation: { whatsappConnectionId: connectionId } },
    select: { externalMessageId: true },
  });
  return rows.map((row) => row.externalMessageId).sort();
}

/**
 * Counts this connection's conversations. A delta, never the whole table.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection to scope to.
 * @returns The conversation count for that connection.
 */
function conversationCount(tx: DbClient, connectionId: string) {
  return tx.conversation.count({ where: { whatsappConnectionId: connectionId } });
}

/**
 * Reads this connection's one imported conversation by its own key.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection that owns the thread.
 * @param chatKey - The chat key; defaults to the fixture's phone.
 * @returns The conversation row.
 */
function conversationOf(tx: DbClient, connectionId: string, chatKey = phoneChatKey) {
  return tx.conversation.findUniqueOrThrow({
    where: {
      whatsappConnectionId_chatKey: { whatsappConnectionId: connectionId, chatKey },
    },
  });
}

describeWithDatabase("history backfill, ingest side", () => {
  it("inserts a REST 1:1 row with the Evolution timestamp and no webhook_event", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[historyRow({ id: "REST-A" })]] },
      });

      await backfill(handle, store, history);

      expect(await conversationCount(tx, connection.id)).toBe(1);
      expect(await messageIds(tx, connection.id)).toEqual(["REST-A"]);
      const message = await tx.message.findFirstOrThrow({
        where: { conversation: { whatsappConnectionId: connection.id } },
      });
      expect(message.providerTimestamp).toEqual(expectedTimestamp);
      const conversation = await conversationOf(tx, connection.id);
      expect(conversation.lastPrefillWindowClosedAt).toEqual(expectedTimestamp);
      // REST import writes no webhook_event for this connection.
      expect(
        await tx.webhookEvent.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
    }));

  it("does not duplicate a REST id on a second run", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[historyRow({ id: "REST-B" })]] },
      });

      await backfill(handle, store, history);
      expect(await messageIds(tx, connection.id)).toEqual(["REST-B"]); // precondition
      await backfill(handle, store, history);

      expect(await messageIds(tx, connection.id)).toEqual(["REST-B"]);
    }));

  it("does not duplicate an id already stored from live ingest", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "LIVE-1" }),
      );
      await canonicalizeEvent(store, id);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[historyRow({ id: "LIVE-1" })]] },
      });

      await backfill(handle, store, history);

      expect(await messageIds(tx, connection.id)).toEqual(["LIVE-1"]);
      expect(
        await tx.webhookEvent.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(1);
    }));

  it("does not import a group JID that appears only in findMessages", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[historyRow({ id: "G-ROW", remoteJid: groupJid })]] },
      });

      await backfill(handle, store, history);

      expect(await conversationCount(tx, connection.id)).toBe(0);
      expect(history.findMessagesPage).toHaveBeenCalled();
    }));

  // The chat-level filter and the per-message rule are different filters, and
  // fixing only the per-message one leaves the import dropping every LID chat
  // while the parser tests all pass. These two pin the chat level specifically.
  it("pages a LID chat and imports it under the phone on its message alternate", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const lidJid = "123456789012345@lid";
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: lidJid }],
        pages: {
          [lidJid]: [[historyRow({ id: "L1", remoteJid: lidJid, remoteJidAlt: phoneJid })]],
        },
      });

      await backfill(handle, store, history);

      expect(history.findMessagesPage).toHaveBeenCalled();
      expect(await conversationCount(tx, connection.id)).toBe(1);
      // Filed under the phone, not the LID.
      expect((await conversationOf(tx, connection.id)).chatKey).toBe(phoneChatKey);
    }));

  // A LID chat whose messages carry no phone costs one paging pass and writes
  // nothing. That is the accepted trade in design.md — the alternative is a
  // second copy of the phone rule reading `lastMessage` at the chat level.
  it("pages a LID chat with no recoverable phone and writes nothing, without throwing", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const lidJid = "999888777666555@lid";
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: lidJid }],
        pages: { [lidJid]: [[historyRow({ id: "L2", remoteJid: lidJid })]] },
      });

      await backfill(handle, store, history);

      expect(history.findMessagesPage).toHaveBeenCalled();
      expect(await conversationCount(tx, connection.id)).toBe(0);
      expect(await messageIds(tx, connection.id)).toEqual([]);
    }));

  it("skips a row without a timestamp and still imports the rest of the page", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: {
          [phoneJid]: [
            [historyRow({ id: "NO-TS", messageTimestamp: null }), historyRow({ id: "OK-TS" })],
          ],
        },
      });

      await backfill(handle, store, history);

      expect(await messageIds(tx, connection.id)).toEqual(["OK-TS"]);
    }));

  it("ignores malformed REST rows that have no provider id and still imports the rest", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[null, { key: { id: "" } }, historyRow({ id: "OK-ROW" })]] },
      });

      await backfill(handle, store, history);

      expect(await messageIds(tx, connection.id)).toEqual(["OK-ROW"]);
    }));

  it("imports a REST row with ctwa as AD", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: {
          [phoneJid]: [[historyRow({ id: "REST-CTWA", extra: { ctwaClid: "CTWA-REST-1" } })]],
        },
      });

      await backfill(handle, store, history);

      const conversation = await conversationOf(tx, connection.id);
      expect(conversation.sourceType).toBe("AD");
      expect(conversation.ctwaClid).toBe("CTWA-REST-1");
    }));

  it("imports an inbound-first REST row without ad evidence as ORGANIC", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[historyRow({ id: "REST-IN" })]] },
      });

      await backfill(handle, store, history);

      const conversation = await conversationOf(tx, connection.id);
      expect(conversation.sourceType).toBe("ORGANIC");
      expect(conversation.sourceEvidenceType).toBe("customer_initiated");
    }));

  it("imports an outbound-first REST row without ad evidence as UNKNOWN", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx);
      const history = historyStub(connection.instanceName, {
        chats: [{ remoteJid: phoneJid }],
        pages: { [phoneJid]: [[historyRow({ id: "REST-OUT", fromMe: true })]] },
      });

      await backfill(handle, store, history);

      const conversation = await conversationOf(tx, connection.id);
      expect(conversation.sourceType).toBe("UNKNOWN");
      expect(conversation.sourceEvidenceType).toBe("none");
    }));
});
