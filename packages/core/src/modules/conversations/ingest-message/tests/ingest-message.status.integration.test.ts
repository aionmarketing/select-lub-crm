/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/status.test.ts (adopt-modular-vertical-slices 4A),
 * all cases, assertions unchanged. Ran under module roles: `conversations` for
 * conversation/message, `channel` (through its contracts) for webhook_event and
 * whatsapp_connection. Two mechanical changes: the store is `createIngestStore`
 * over the test transaction, and the insert hook the old cases counted is the
 * `conversations/message-received` event, counted at the same point.
 *
 * Setup: the real Prisma ingest store on the worktree database inside a
 * rolling-back test transaction (`withTestTransaction`). A message is inserted
 * through persist/canonicalize, then `applyProviderStatus` /
 * `markContentUnavailable` run against it. No fetch.
 *
 * Oracle: message-status-updates whatsapp-channel —
 *   Provider status updates never regress;
 *   Delete marks content unavailable.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Two, and the
 * second is the reason this file was worth migrating rather than only rewording.
 *
 *   1. Every read was `store.messages()[0]` plus `toHaveLength(n)` over the fake's
 *      whole message map — an absolute index and an absolute count. Against the
 *      real database those range over the pristine base and the demo seed too, so
 *      each becomes a lookup of the row this test created, keyed by its
 *      external message id through its own connection, and each count becomes a
 *      delta scoped the same way (design.md D9).
 *
 *   2. The monotonic guard is not the pure rank comparison the fake implemented.
 *      In the fake, `applyProviderStatus` found the row by scanning a flat map and
 *      comparing the stored rank; in `prisma.ts` the guard is a single UPDATE whose
 *      WHERE reaches the message only through
 *      `message -> conversation -> conversation.whatsapp_connection_id`. The
 *      connection is part of the predicate, not a field compared after the row was
 *      already found. The fake had no such join — a conversation carried a flat
 *      `unitId` — which is the same missing concept PR #89's bug lived in. A case
 *      is therefore ADDED here that the fake could not have expressed: the same
 *      provider message id existing on two connections, where an update routed to
 *      one must leave the other's row alone. It passes on the adapter; on the fake
 *      it was not a representable scenario at all.
 *
 * Axes
 *   A1 ladder — sent → delivered; read then delivered; duplicate read
 *   A2 failed — after sent vs after read
 *   A3 unknown id — apply / delete
 *   A4 routing — id unique to a connection vs shared across two connections
 *
 * Outputs: O1 status advanced; O2 no-op stay; O3 no new row; O4 other
 *   connection's row untouched
 *
 * Sampled-cell
 *   sent then delivered              | A1 | O1 | stays sent
 *   read then delivered              | A1 | O2 | becomes delivered
 *   duplicate read                   | A1 | O2 | second row
 *   unknown id apply                 | A3 | O3 | ghost message
 *   failed after read                | A2 | O2 | becomes failed
 *   failed after sent                | A2 | O1 | stays sent
 *   status update does not fire hook | A1 | O3 | hook count 2
 *   shared id across connections     | A4 | O4 | both rows advance
 *
 * Decision / branch map (prisma.ts applyProviderStatus WHERE)
 *   next = failed && stored null/sent  T failed-after-sent it; F failed-after-read
 *   stored IS NULL                     T first sent it; F later steps
 *   rank(next) > rank(stored)          T sent→delivered; F duplicate read
 *   c.whatsapp_connection_id matches   T every routed it; F shared-id it
 *
 * Out of scope: HTTP thread JSON (conversations.test.ts); live Evolution
 *   payloads (status.live.test.ts).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { expect, it } from "vitest";
import { canonicalizeEvent, persistRawEvent } from "../index.js";
import { statusUpdatePayload, upsertPayload } from "../../../../testing/index.js";
import { countMessagesReceived, ingestStoreOn } from "./ingest.fixture.js";
import type { IngestStore as Persistence } from "../index.js";

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
 * Inserts one canonical message with the given provider id on a connection.
 *
 * @param store - The ingest store under test.
 * @param instanceName - Instance name the payload is addressed to.
 * @param id - Provider message id.
 * @param remoteJid - Optional remote JID, so two connections can carry distinct threads.
 */
async function insertMessage(
  store: Persistence,
  instanceName: string,
  id: string,
  remoteJid?: string,
) {
  const event = await persistRawEvent(
    store,
    upsertPayload({ instance: instanceName, id, ...(remoteJid ? { remoteJid } : {}) }),
  );
  await canonicalizeEvent(store, event.id);
}

/**
 * Reads back the one message with this provider id on this connection.
 *
 * The join is the point: the adapter reaches a message only through its
 * conversation's connection, which is what the fake's flat map could not model.
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

/**
 * Counts this connection's messages. A delta, never the whole table.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection to scope to.
 * @returns The row count for that connection.
 */
function messageCount(tx: DbClient, connectionId: string) {
  return tx.message.count({ where: { conversation: { whatsappConnectionId: connectionId } } });
}

describeWithDatabase("applyProviderStatus on the Prisma ingest store", () => {
  it("advances sent to delivered", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      await insertMessage(store, connection.instanceName, "S1");

      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S1",
        providerStatus: "sent",
        at: new Date("2026-08-31T00:00:00.000Z"),
      });
      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S1",
        providerStatus: "delivered",
        at: new Date("2026-08-31T00:01:00.000Z"),
      });

      expect(await messageCount(tx, connection.id)).toBe(1);
      const row = await messageOf(tx, connection.id, "S1");
      expect(row.providerStatus).toBe("delivered");
      expect(row.deliveredAt).toEqual(new Date("2026-08-31T00:01:00.000Z"));
    }));

  it("keeps read when a later delivered arrives", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      await insertMessage(store, connection.instanceName, "S2");
      const readAt = new Date("2026-08-31T00:02:00.000Z");

      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S2",
        providerStatus: "read",
        at: readAt,
      });
      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S2",
        providerStatus: "delivered",
        at: new Date("2026-08-31T00:03:00.000Z"),
      });

      const row = await messageOf(tx, connection.id, "S2");
      expect(row.providerStatus).toBe("read");
      expect(row.readAt).toEqual(readAt);
    }));

  it("treats a duplicate read as a no-op on the same row", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      await insertMessage(store, connection.instanceName, "S3");

      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S3",
        providerStatus: "read",
        at: new Date("2026-08-31T00:04:00.000Z"),
      });
      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S3",
        providerStatus: "read",
        at: new Date("2026-08-31T00:05:00.000Z"),
      });

      expect(await messageCount(tx, connection.id)).toBe(1);
      expect((await messageOf(tx, connection.id, "S3")).providerStatus).toBe("read");
    }));

  it("does not create a message for an unknown external id", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      expect(await messageCount(tx, connection.id)).toBe(0); // precondition

      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "MISSING",
        providerStatus: "delivered",
        at: new Date(),
      });

      expect(await messageCount(tx, connection.id)).toBe(0);
      expect(
        await tx.conversation.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
    }));

  it("does not replace read with failed", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      await insertMessage(store, connection.instanceName, "S4");

      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S4",
        providerStatus: "read",
        at: new Date(),
      });
      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S4",
        providerStatus: "failed",
        at: new Date(),
      });

      expect((await messageOf(tx, connection.id, "S4")).providerStatus).toBe("read");
    }));

  it("applies failed when the stored status is still sent", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      await insertMessage(store, connection.instanceName, "S5");

      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S5",
        providerStatus: "sent",
        at: new Date(),
      });
      expect((await messageOf(tx, connection.id, "S5")).providerStatus).toBe("sent"); // precondition
      await store.applyProviderStatus({
        whatsappConnectionId: connection.id,
        externalMessageId: "S5",
        providerStatus: "failed",
        at: new Date(),
      });

      expect((await messageOf(tx, connection.id, "S5")).providerStatus).toBe("failed");
    }));

  it("does not invoke the insert hook on a status update", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const hooks = countMessagesReceived();
      const insert = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "HOOK-1" }),
      );
      await canonicalizeEvent(store, insert.id);
      const update = await persistRawEvent(
        store,
        statusUpdatePayload({
          instance: connection.instanceName,
          id: "HOOK-1",
          status: "DELIVERY_ACK",
        }),
      );
      await canonicalizeEvent(store, update.id);

      expect(hooks.count).toBe(1);
      expect(await messageCount(tx, connection.id)).toBe(1);
    }));

  it("routes by connection when two connections share a provider message id", () =>
    withTestTransaction(db(), async (tx) => {
      // Not expressible against the fake: it had no conversation-to-connection
      // join to route by. See the fake-only note in the header.
      const unit = await seedUnit(tx);
      const mine = await seedConnection(tx, { unitId: unit.id });
      const other = await seedConnection(tx, { unitId: unit.id });
      const store = ingestStoreOn(tx);
      await insertMessage(store, mine.instanceName, "SHARED");
      await insertMessage(store, other.instanceName, "SHARED");
      expect((await messageOf(tx, mine.id, "SHARED")).providerStatus).toBeNull(); // precondition
      expect((await messageOf(tx, other.id, "SHARED")).providerStatus).toBeNull();

      await store.applyProviderStatus({
        whatsappConnectionId: mine.id,
        externalMessageId: "SHARED",
        providerStatus: "delivered",
        at: new Date("2026-08-31T00:06:00.000Z"),
      });

      expect((await messageOf(tx, mine.id, "SHARED")).providerStatus).toBe("delivered");
      expect((await messageOf(tx, other.id, "SHARED")).providerStatus).toBeNull();
    }));

  it("marks content unavailable only on the routed connection's message", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const mine = await seedConnection(tx, { unitId: unit.id });
      const other = await seedConnection(tx, { unitId: unit.id });
      const store = ingestStoreOn(tx);
      await insertMessage(store, mine.instanceName, "GONE");
      await insertMessage(store, other.instanceName, "GONE");

      await store.markContentUnavailable({
        whatsappConnectionId: mine.id,
        externalMessageId: "GONE",
      });

      expect((await messageOf(tx, mine.id, "GONE")).contentUnavailable).toBe(true);
      expect((await messageOf(tx, other.id, "GONE")).contentUnavailable).toBe(false);
    }));
});
