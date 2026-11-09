/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/canonicalize.test.ts (adopt-modular-vertical-slices 4A),
 * all cases, assertions unchanged. Ran under module roles: `conversations` for
 * conversation/message, `channel` (through its contracts) for webhook_event and
 * whatsapp_connection. Two mechanical changes: the store is `createIngestStore`
 * over the test transaction, and the insert hook the old cases counted is the
 * `conversations/message-received` event, counted at the same point.
 *
 * Setup: `persistRawEvent` / `canonicalizeEvent` / `parseCanonicalMessage`
 * against the real Prisma ingest store on the worktree database, inside a
 * rolling-back test transaction (`withTestTransaction`).
 *
 * Spec (conversation-phone-unique delta whatsapp-channel; main
 * openspec/specs/channel/whatsapp-channel/spec.md still names uniqueness as
 * (whatsapp_connection_id, external_message_id) until archive): conversation
 * and message ingest share one transaction keyed by (connection, chat_key);
 * hook only after commit; insert is idempotent on
 * (conversation_id, external_message_id); groups / dumps / @lid / unknown
 * instance / missing timestamp are skipped without inbox rows.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Three: one
 * corrected in place, one moved out of the harness, one removed outright.
 *
 *   1. Every `store.messages()`, `store.conversations()` and `store.events()`
 *      read was an absolute count or an index over the fake's maps. On the real
 *      database those range over the pristine base and the demo seed too, so each
 *      becomes a count or a lookup scoped to this test's own connection, or —
 *      where an event deliberately has NO connection — a lookup by the event id
 *      `persistRawEvent` returned (design.md D9).
 *
 *   2. MOVED OUT OF THE HARNESS: "rolls back the conversation when the message
 *      insert throws". It drove the fake's `throwAfterConversationWrite` switch, a
 *      failure injection that exists only in the fake, to prove the conversation
 *      write and the message write share one transaction. Under the harness that
 *      guarantee is not observable at all: `runInTransactionOnTx` is a no-op shim,
 *      so a throw inside the callback rolls nothing back. design.md D2 states this
 *      consequence and reserves a dedicated non-harness live test for behaviour
 *      that genuinely depends on an inner rollback. That test is the last
 *      `describeWithDatabase` block in this file; it runs on the singleton client
 *      with a real `prisma.$transaction`, and its own comment explains why it
 *      leaks nothing and why its rollback assertion is not vacuous.
 *
 *   3. REMOVED: "returns null from claimQueued when the conversation is missing".
 *      It required an outbox row pointing at a conversation id that does not
 *      exist. `outbox_message.conversation_id` carries a foreign key to
 *      `conversation`, so that row cannot be created at all, and the adapter's
 *      `claimQueued` uses `findUniqueOrThrow` rather than returning null. The fake
 *      had neither the constraint nor the throw, so the case asserted a
 *      reachable-looking state that the schema forbids. It belongs to the outbox
 *      in any event; channel's drain-outbox tests (packages/core) cover claiming
 *      against real rows.
 *
 * The two surviving "leftover decisions" cases migrate intact: the inbound/
 * outbound extrema case now exercises the adapter's `LEAST`/`GREATEST` arms in
 * the ON CONFLICT clause rather than the fake's date helpers, and the unknown-id
 * case now asserts the adapter's own rejection (Prisma raises on an update that
 * matches no row) rather than the fake's hand-written "unknown event" throw.
 *
 * Axes
 *   1. event status — received vs processed / skipped / failed_permanent / missing
 *   2. parse — insert vs skip
 *   3. instance on persist — known connection vs unknown vs omitted
 *   4. insert hook — first commit vs redelivery (inserted false)
 *
 * Outputs: O1 one processed message; O2 skipped, 0 inbox rows;
 *   O3 no-op (terminal / missing event); O4 webhook row stored with
 *   connection id null.
 *
 * Decisions (canonicalize.ts; T and F unless named elsewhere)
 *   D1 persist: instance present           — known vs omitted
 *   D2 persist: findConnection hit         — known vs unknown instance
 *   D3 canonicalize: !event                — missing id vs existing
 *   D4 canonicalize: terminal status       — processed / skipped /
 *      failed_permanent vs received
 *   D5 parsed.status === "skip"            — group/dump/@lid vs 1:1 insert
 *   D5b status-update / content-unavailable — apply then processed; hook off
 *   D6 inserted                            — first commit vs redelivery
 *   D7 catch attemptCount >= max           — retry.test.ts (not here)
 *   D8 retryPendingEvents pending loop     — retry.test.ts non-empty;
 *      nothing due here
 *
 *   it                                              | D1 | D2 | D3 | D4 | D5 | D6
 *   inserts a 1:1 upsert                            | T  | T  | F  | F  | F  | T
 *   sets messageType without fetching media         | T  | T  | F  | F  | F  | T
 *   stores caption textBody without fetch           | T  | T  | F  | F  | F  | T
 *   skips groups, dumps, @lid, unknown instance, …  | T  | T/F| F  | F  | T  | -
 *   insert hook once, not on redelivery             | T  | T  | F  | F  | F  | T then F
 *   persistRawEvent records known instance          | T  | T  | -  | -  | -  | -
 *   persistRawEvent stores unknown/omitted instance | T/F| F  | -  | -  | -  | -
 *   missing event is a no-op                        | -  | -  | T  | -  | -  | -
 *   terminal statuses are not retried               | T  | T  | F  | T  | -  | -
 *   retryPendingEvents with nothing due             | -  | -  | -  | -  | -  | -
 *   applies a 1:1 update without a second row       | T  | T  | F  | F  | D5b| -
 *   does not regress read when delivered is replayed| T  | T  | F  | F  | D5b| -
 *   marks content unavailable on delete             | T  | T  | F  | F  | D5b| -
 *
 * Fails if: hook count 2 after redelivery; a processed event increments
 * attemptCount on a second canonicalize; unknown instance still gets a
 * connection id.
 *
 * Adapter leftovers (this file unless named covered-elsewhere)
 *   M1 inserted false                         — hook redelivery above
 *   M2 inbound then outbound extrema          — dedicated `it`
 *   M3 claimQueued empty                      — drain.test.ts empty outbox
 *   M4 claimQueued missing conversation       — REMOVED, see note 3
 *   M5 incrementAttemptCount unknown id       — dedicated `it`
 *
 * Out of scope: retry budget / failed_permanent catch (retry.test.ts);
 * live media; pairing QR (PEND-CH-01). Inner-transaction atomicity is covered by
 * the non-harness block in ingest-message.store.integration.test.ts (note 2).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { expect, it, vi } from "vitest";
import { canonicalizeEvent, persistRawEvent, retryPendingEvents } from "../index.js";
import { deletePayload, expectedTimestamp, statusUpdatePayload, upsertPayload } from "../../../../testing/index.js";
import { countMessagesReceived, ingestStoreOn } from "./ingest.fixture.js";

const db = () => prisma as PrismaClient;

/**
 * Seeds a unit and a connection and builds the real ingest store on `tx`.
 *
 * @param tx - The test transaction.
 * @returns The connection row and the store built on `tx`.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const store = ingestStoreOn(tx);
  return { connection, store };
}

/**
 * This connection's messages. A delta, never the whole table.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection to scope to.
 * @returns The message rows for that connection.
 */
function messagesOf(tx: DbClient, connectionId: string) {
  return tx.message.findMany({ where: { conversation: { whatsappConnectionId: connectionId } } });
}

/**
 * The one message this connection holds with the given provider id.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection that owns the thread.
 * @param externalMessageId - Provider message id.
 * @returns The message row.
 */
function messageOf(tx: DbClient, connectionId: string, externalMessageId: string) {
  return tx.message.findFirstOrThrow({
    where: { externalMessageId, conversation: { whatsappConnectionId: connectionId } },
  });
}

describeWithDatabase("canonicalize", () => {
  it("inserts a 1:1 upsert with the payload providerTimestamp", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName }),
      );

      await canonicalizeEvent(store, id);

      const messages = await messagesOf(tx, connection.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.providerTimestamp).toEqual(expectedTimestamp);
      expect(messages[0]?.origin).toBe("LIVE");
      expect((await store.getEvent(id))?.status).toBe("processed");
    }));

  it("sets messageType from the payload without fetching media", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        upsertPayload({
          instance: connection.instanceName,
          id: "IMG1",
          message: { imageMessage: { mimetype: "image/jpeg" } },
        }),
      );

      await canonicalizeEvent(store, id);

      const message = await messageOf(tx, connection.id, "IMG1");
      expect(message.messageType).toBe("image");
      expect(message.textBody).toBeNull();
    }));

  it("stores an image caption as textBody without calling a media download", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const { id } = await persistRawEvent(
          store,
          upsertPayload({
            instance: connection.instanceName,
            id: "IMG-CAP",
            message: { imageMessage: { caption: "frente" } },
          }),
        );

        await canonicalizeEvent(store, id);

        const message = await messageOf(tx, connection.id, "IMG-CAP");
        expect(message.messageType).toBe("image");
        expect(message.textBody).toBe("frente");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    }));

  it("skips groups, broadcasts, unknown instance, history dumps, and missing timestamps", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const cases = [
        upsertPayload({ instance: connection.instanceName, remoteJid: "120363@g.us" }),
        upsertPayload({ instance: connection.instanceName, remoteJid: "123456789012345@lid" }),
        upsertPayload({ instance: connection.instanceName, remoteJid: "status@broadcast" }),
        upsertPayload({ instance: connection.instanceName, remoteJid: "120363@broadcast" }),
        upsertPayload({ instance: `${connection.instanceName}-absent` }),
        upsertPayload({ instance: connection.instanceName, event: "MESSAGES_SET" }),
        upsertPayload({ instance: connection.instanceName, messageTimestamp: null }),
      ];
      const eventIds: string[] = [];
      for (const payload of cases) {
        const { id } = await persistRawEvent(store, payload);
        eventIds.push(id);
        await canonicalizeEvent(store, id);
      }

      expect(
        await tx.conversation.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
      expect(await messagesOf(tx, connection.id)).toHaveLength(0);
      // By the ids this test created: the unknown-instance event has no
      // connection to scope by, so a count over the table would not find it.
      const statuses = await Promise.all(
        eventIds.map(async (id) => (await store.getEvent(id))?.status),
      );
      expect(statuses).toEqual(cases.map(() => "skipped"));
    }));

  it("applies a 1:1 update without creating a second row or firing the insert hook", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const hooks = countMessagesReceived();
      const insert = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "STAT-1" }),
      );
      await canonicalizeEvent(store, insert.id);
      const update = await persistRawEvent(
        store,
        statusUpdatePayload({
          instance: connection.instanceName,
          id: "STAT-1",
          status: "DELIVERY_ACK",
        }),
      );
      await canonicalizeEvent(store, update.id);

      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      expect((await messageOf(tx, connection.id, "STAT-1")).providerStatus).toBe("delivered");
      expect((await store.getEvent(update.id))?.status).toBe("processed");
      expect(hooks.count).toBe(1);
    }));

  it("does not regress read when a later delivered update is replayed", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const insert = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "STAT-READ" }),
      );
      await canonicalizeEvent(store, insert.id);
      const read = await persistRawEvent(
        store,
        statusUpdatePayload({
          instance: connection.instanceName,
          id: "STAT-READ",
          status: "READ",
        }),
      );
      await canonicalizeEvent(store, read.id);
      expect((await messageOf(tx, connection.id, "STAT-READ")).providerStatus).toBe("read"); // precondition
      const late = await persistRawEvent(
        store,
        statusUpdatePayload({
          instance: connection.instanceName,
          id: "STAT-READ",
          status: "DELIVERY_ACK",
        }),
      );
      await canonicalizeEvent(store, late.id);

      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      expect((await messageOf(tx, connection.id, "STAT-READ")).providerStatus).toBe("read");
      expect((await store.getEvent(late.id))?.status).toBe("processed");
    }));

  it("marks content unavailable on delete and keeps the row", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const insert = await persistRawEvent(
        store,
        upsertPayload({
          instance: connection.instanceName,
          id: "DEL-KEEP",
          conversation: "oi",
        }),
      );
      await canonicalizeEvent(store, insert.id);
      const deleted = await persistRawEvent(
        store,
        deletePayload({ instance: connection.instanceName, id: "DEL-KEEP" }),
      );
      await canonicalizeEvent(store, deleted.id);

      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      const message = await messageOf(tx, connection.id, "DEL-KEEP");
      expect(message.contentUnavailable).toBe(true);
      expect(message.textBody).toBe("oi");
      expect((await store.getEvent(deleted.id))?.status).toBe("processed");
    }));

  it("runs the insert hook once on a new message and not on redelivery", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const hooks = countMessagesReceived();
      const payload = upsertPayload({ instance: connection.instanceName, id: "HOOK-1" });
      const first = await persistRawEvent(store, payload);
      await canonicalizeEvent(store, first.id);
      const second = await persistRawEvent(store, payload);
      await canonicalizeEvent(store, second.id);

      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      expect(hooks.count).toBe(1);
    }));

  it("records the connection id when persistRawEvent sees a known instance", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      const { id } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName }),
      );

      expect((await store.getEvent(id))?.whatsappConnectionId).toBe(connection.id);
      expect((await store.getEvent(id))?.status).toBe("received");
    }));

  it("stores a webhook row with no connection for an unknown or omitted instance", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const absent = `${connection.instanceName}-absent`;
      expect(
        await tx.whatsAppConnection.findUnique({ where: { instanceName: absent } }),
      ).toBeNull(); // precondition

      const unknown = await persistRawEvent(store, upsertPayload({ instance: absent }));
      expect((await store.getEvent(unknown.id))?.whatsappConnectionId).toBeNull();
      expect((await store.getEvent(unknown.id))?.status).toBe("received");

      const omitted = await persistRawEvent(store, {
        ...upsertPayload({ instance: connection.instanceName, id: "NO-INST" }),
        instance: undefined,
      });
      expect((await store.getEvent(omitted.id))?.whatsappConnectionId).toBeNull();
    }));

  it("does nothing when the event id is missing", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const hooks = countMessagesReceived();

      await canonicalizeEvent(store, "missing-event-id");

      expect(
        await tx.webhookEvent.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
      expect(await messagesOf(tx, connection.id)).toHaveLength(0);
      expect(hooks.count).toBe(0);
    }));

  it("does not increment attempts or fire the hook for terminal event statuses", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const hooks = countMessagesReceived();

      const processed = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "TERM-OK" }),
      );
      await canonicalizeEvent(store, processed.id);
      const processedAttempts = (await store.getEvent(processed.id))?.attemptCount;
      await canonicalizeEvent(store, processed.id);
      expect((await store.getEvent(processed.id))?.status).toBe("processed");
      expect((await store.getEvent(processed.id))?.attemptCount).toBe(processedAttempts);
      expect(hooks.count).toBe(1);

      const skipped = await persistRawEvent(
        store,
        upsertPayload({
          instance: connection.instanceName,
          id: "TERM-SKIP",
          remoteJid: "120363@g.us",
        }),
      );
      await canonicalizeEvent(store, skipped.id);
      const skippedAttempts = (await store.getEvent(skipped.id))?.attemptCount;
      await canonicalizeEvent(store, skipped.id);
      expect((await store.getEvent(skipped.id))?.status).toBe("skipped");
      expect((await store.getEvent(skipped.id))?.attemptCount).toBe(skippedAttempts);

      const parked = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "TERM-PERM" }),
      );
      await store.markEvent(parked.id, "failed_permanent");
      await canonicalizeEvent(store, parked.id);
      expect((await store.getEvent(parked.id))?.status).toBe("failed_permanent");
      expect((await store.getEvent(parked.id))?.attemptCount).toBe(0);
      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
    }));

  it("writes nothing when retryPendingEvents has nothing due", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      await retryPendingEvents(store);

      expect(
        await tx.webhookEvent.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
      expect(await messagesOf(tx, connection.id)).toHaveLength(0);
    }));
});
