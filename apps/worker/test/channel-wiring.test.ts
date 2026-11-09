/**
 * Test design (testing-strategy)
 *
 * SUT: the worker's wiring of channel's `channel/outbound-sent` event to the
 *   ingest insert (`insertSentMessages`), driven by channel's `drainOnce` and then
 *   a SEND_MESSAGE webhook canonicalized by ingest — on the real Prisma ingest
 *   store and channel's handle over the worktree database, inside a rolling-back
 *   test transaction. A mock `EvolutionSend`; no Evolution HTTP.
 *
 * Moved from apps/worker/src/outbox/drain.test.ts (adopt-modular-vertical-slices
 * 3A): the 2 of its 30 cases that cross from the drain into ingest. The other
 * 28 moved to packages/core/src/modules/channel/drain-outbox/tests/. These two
 * need both halves at once — the send's canonical row, or its absence, and then
 * the webhook for the same provider id — so they live where the two halves are
 * joined: the composition root's subscriber.
 *
 * A third case (owner rulings, 2026-09-25): the drain now confirms before it
 * publishes, so an insert that throws leaves the row confirmed rather than
 * claimed, and the SEND_MESSAGE webhook for the same provider id fills the
 * bubble in.
 *
 * Oracle: outbox-send-provider-timestamp (a timestamp-less send inserts no row;
 *   the later SEND_MESSAGE webhook inserts it with Evolution's timestamp) +
 *   conversation-phone-unique ((conversation_id, external_message_id) makes the
 *   redelivery a no-op).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import { kernel } from "@select-lub/core";
import { drainOnce, type EvolutionSend } from "@select-lub/core/modules/channel";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { expect, it } from "vitest";
import { expectedTimestamp, upsertPayload } from "@select-lub/core/testing";
import {
  canonicalizeEvent,
  createIngestStore,
  insertSentMessages,
  persistRawEvent,
} from "@select-lub/core/modules/conversations";

const CHAT_KEY = "5511999999999";
const REMOTE_JID = `${CHAT_KEY}@s.whatsapp.net`;

const db = () => prisma as PrismaClient;

/** An `EvolutionSend` whose `sendText` always returns `result`. */
function mockEvolution(result: Awaited<ReturnType<EvolutionSend["sendText"]>>): EvolutionSend {
  const unusedSend = async () => ({ ok: false as const, kind: "refused" as const, error: "unused" });
  return {
    sendText: async () => result,
    sendWhatsAppAudio: unusedSend,
    sendMedia: unusedSend,
    async getBase64FromMediaMessage() {
      return { ok: false, disconnected: false, error: "unused" };
    },
  };
}

/** A thread with one queued text row, the ingest store, and channel's handle. */
async function setup(tx: DbClient, textBody: string) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: CHAT_KEY, remoteJid: REMOTE_JID });
  await tx.outboxMessage.create({ data: { conversationId: conversation.id, messageType: "text", textBody, status: "queued" } });
  return {
    connection,
    store: createIngestStore(kernel.createDb(tx, runInTransactionOnTx(tx))),
    handle: kernel.createDb(tx, runInTransactionOnTx(tx)),
  };
}

/** Drains one row with the worker's ingest subscriber attached. */
async function drainWired(store: ReturnType<typeof createIngestStore>, handle: kernel.Db, evolution: EvolutionSend) {
  const off = insertSentMessages(store);
  try {
    await drainOnce({ db: handle, evolution });
  } finally {
    off();
  }
}

function outboundWithId(tx: DbClient, connectionId: string, externalMessageId: string) {
  return tx.message.findMany({
    where: { externalMessageId, conversation: { whatsappConnectionId: connectionId } },
  });
}

describeWithDatabase("channel outbound-sent wired to ingest", () => {
  it("inserts one canonical message from SEND_MESSAGE after a timestamp-less confirm", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx, "hello");

      await drainWired(store, handle, mockEvolution({ ok: true, externalMessageId: "out-fill-later", providerTimestamp: null }));
      expect(await outboundWithId(tx, connection.id, "out-fill-later")).toHaveLength(0); // precondition

      const event = await persistRawEvent(
        store,
        upsertPayload({
          event: "SEND_MESSAGE",
          instance: connection.instanceName,
          id: "out-fill-later",
          fromMe: true,
          remoteJid: REMOTE_JID,
          conversation: "hello",
        }),
      );
      await canonicalizeEvent(store, event.id);

      const outbound = await outboundWithId(tx, connection.id, "out-fill-later");
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.providerTimestamp).toEqual(expectedTimestamp);
    }));

  it("confirms a send whose message insert throws, and SEND_MESSAGE still fills the bubble in", () =>
    withTestTransaction(db(), async (tx) => {
      // Confirm before publish (owner rulings, 2026-09-25): a failing insert no
      // longer leaves the row claimed for reclaim-stuck to send again. What this
      // case shows is that the thread does not lose the bubble for it — the
      // SEND_MESSAGE webhook for the same provider id inserts it.
      const { connection, store, handle } = await setup(tx, "hello");
      const failingStore: ReturnType<typeof createIngestStore> = {
        ...store,
        async runConversationMessageTransaction() {
          throw new Error("insert boom");
        },
      };

      await drainWired(
        failingStore,
        handle,
        mockEvolution({ ok: true, externalMessageId: "out-insert-fails", providerTimestamp: new Date("2026-01-01T12:00:00.000Z") }),
      );
      const outbox = await tx.outboxMessage.findFirstOrThrow({ where: { externalMessageId: "out-insert-fails" } });
      expect(outbox.status).toBe("confirmed");
      expect(await outboundWithId(tx, connection.id, "out-insert-fails")).toHaveLength(0); // precondition

      const event = await persistRawEvent(
        store,
        upsertPayload({
          event: "SEND_MESSAGE",
          instance: connection.instanceName,
          id: "out-insert-fails",
          fromMe: true,
          remoteJid: REMOTE_JID,
          conversation: "hello",
        }),
      );
      await canonicalizeEvent(store, event.id);

      const outbound = await outboundWithId(tx, connection.id, "out-insert-fails");
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.direction).toBe("outbound");
      expect(outbound[0]?.textBody).toBe("hello");
    }));

  it("keeps a single message when send then SEND_MESSAGE share the provider id", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store, handle } = await setup(tx, "hello");

      await drainWired(
        store,
        handle,
        mockEvolution({ ok: true, externalMessageId: "same-id", providerTimestamp: new Date("2026-01-01T12:00:00.000Z") }),
      );
      // The subscriber inserted the send's row; the webhook below must not add a second.
      expect(await outboundWithId(tx, connection.id, "same-id")).toHaveLength(1); // precondition
      const event = await persistRawEvent(
        store,
        upsertPayload({
          event: "SEND_MESSAGE",
          instance: connection.instanceName,
          id: "same-id",
          fromMe: true,
          remoteJid: REMOTE_JID,
          conversation: "hello",
        }),
      );
      await canonicalizeEvent(store, event.id);

      // The (conversation_id, external_message_id) unique index is what makes
      // the redelivery a no-op rather than a second row.
      expect(await outboundWithId(tx, connection.id, "same-id")).toHaveLength(1);
    }));
});
