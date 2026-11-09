/**
 * Test design (testing-strategy)
 *
 * SUT: ingestion's store (`createIngestStore`) where canonicalization does not
 *   reach it — the ON CONFLICT extrema, an unknown event's attempt count — and the
 *   atomicity of `runConversationMessageTransaction`, which only a real
 *   transaction can show.
 *
 * Ran under module roles: `conversations` (conversation, message) and `channel`
 *   (webhook_event, through its contracts).
 *
 * Split out of ingest-message.integration.test.ts for the 300-line limit; those
 * three cases moved there from apps/worker/src/ingest/canonicalize.test.ts
 * (adopt-modular-vertical-slices 4A), assertions unchanged. That file's header —
 * its axes, decision map and fake-only notes — covers these too.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { describeWithDatabase, withTestTransaction } from "../../../../testing/index.js";
import { createIngestStore } from "../index.js";
import { db, setup } from "./ingest.fixture.js";

const CHAT_KEY = "5511999999999";

describeWithDatabase("ingest adapter leftover decisions", () => {
  it("tracks inbound then outbound extrema on the same conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const inboundAt = new Date("2026-01-01T00:00:00.000Z");
      const outboundAt = new Date("2026-01-02T00:00:00.000Z");
      const base = {
        whatsappConnectionId: connection.id,
        remoteJid: `${CHAT_KEY}@s.whatsapp.net`,
        chatKey: CHAT_KEY,
        messageType: "text" as const,
      };

      await store.runConversationMessageTransaction({
        ...base,
        externalMessageId: "in-ext",
        direction: "inbound",
        textBody: "oi",
        providerTimestamp: inboundAt,
      });

      const afterInbound = await tx.conversation.findUniqueOrThrow({
        where: {
          whatsappConnectionId_chatKey: {
            whatsappConnectionId: connection.id,
            chatKey: CHAT_KEY,
          },
        },
      });
      expect(afterInbound.firstInboundAt).toEqual(inboundAt);
      expect(afterInbound.firstOutboundAt).toBeNull();

      await store.runConversationMessageTransaction({
        ...base,
        externalMessageId: "out-ext",
        direction: "outbound",
        textBody: "resposta",
        providerTimestamp: outboundAt,
      });

      // The LEAST/GREATEST arms of the adapter's ON CONFLICT clause.
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: {
          whatsappConnectionId_chatKey: {
            whatsappConnectionId: connection.id,
            chatKey: CHAT_KEY,
          },
        },
      });
      expect(conversation.firstInboundAt).toEqual(inboundAt);
      expect(conversation.lastInboundAt).toEqual(inboundAt);
      expect(conversation.firstOutboundAt).toEqual(outboundAt);
      expect(conversation.lastOutboundAt).toEqual(outboundAt);
      expect(conversation.lastMessageAt).toEqual(outboundAt);
    }));

  it("rejects incrementAttemptCount for an unknown event", () =>
    withTestTransaction(db(), async (tx) => {
      const { store } = await setup(tx);

      await expect(store.incrementAttemptCount("missing-event")).rejects.toThrow();
    }));
});

/**
 * The one case that cannot run inside the harness, per design.md D2.
 *
 * `runInTransactionOnTx` is a no-op shim, so a throw inside the callback rolls
 * nothing back and the atomicity of `runConversationMessageTransaction` is
 * unobservable there. D2 reserves a dedicated non-harness live test for exactly
 * this, and this is it: the store is built on the SINGLETON client with a runner
 * that opens a real `prisma.$transaction`, so the writes and the rollback are
 * both the production mechanism.
 *
 * It is the ONE test in this stream that commits anything, and only because it
 * has to: the adapter's transaction takes its own pooled connection, which cannot
 * see rows an uncommitted test transaction holds, so the unit and connection it
 * hangs a conversation off must be committed first. It does NOT borrow the demo
 * seed's connection for that. The seed is applied by the ROOT vitest config's
 * globalSetup, so a run started from a package config sees none of it, and
 * mutating a row the seed owns would couple this test to whoever seeded. It
 * creates its own two rows and deletes them in a `finally`, so the exposure is
 * two rows for the length of one test and nothing is left behind
 * (memory: reports-live-tests-leak-a-unit-per-run). Everything the adapter itself
 * writes stays inside the real transaction and is rolled back with it.
 *
 * The rollback assertion is not vacuous. A test that only checked "no
 * conversation afterwards" would pass just as well if the insert had never run.
 * The runner therefore counts the row from INSIDE the transaction, before
 * throwing, so the test asserts the conversation existed and then did not.
 */
describeWithDatabase("conversation and message share one transaction", () => {
  it("leaves no conversation behind when the work after the insert throws", async () => {
    const client = db();
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const unitId = `t-atomic-unit-${suffix}`;
    const instanceName = `t-atomic-instance-${suffix}`;
    const chatKey = `5519${suffix.replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`;
    const externalMessageId = `atomic-${suffix}`;

    // Committed on purpose; see the block comment above. Removed in the finally.
    await client.unit.create({ data: { id: unitId, name: `Atomic test ${suffix}` } });
    const connection = await client.whatsAppConnection.create({
      data: { unitId, instanceName, connectionState: "CONNECTED" },
      select: { id: true },
    });
    const where = {
      whatsappConnectionId_chatKey: { whatsappConnectionId: connection.id, chatKey },
    };

    try {
      expect(await client.conversation.findUnique({ where })).toBeNull(); // precondition

      let seenInsideTransaction = -1;
      const store = createIngestStore(
        createDb(client, (fn) =>
          client.$transaction(async (tx) => {
            await fn(tx);
            seenInsideTransaction = await tx.conversation.count({
              where: { whatsappConnectionId: connection.id, chatKey },
            });
            throw new Error("forced rollback");
          }),
        ),
      );

      await expect(
        store.runConversationMessageTransaction({
          whatsappConnectionId: connection.id,
          remoteJid: `${chatKey}@s.whatsapp.net`,
          chatKey,
          externalMessageId,
          direction: "inbound",
          messageType: "text",
          textBody: "oi",
          providerTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ).rejects.toThrow("forced rollback");

      // It really was written, and really is gone.
      expect(seenInsideTransaction).toBe(1);
      expect(await client.conversation.findUnique({ where })).toBeNull();
      expect(await client.message.count({ where: { externalMessageId } })).toBe(0);
    } finally {
      await client.whatsAppConnection.deleteMany({ where: { id: connection.id } });
      await client.unit.deleteMany({ where: { id: unitId } });
    }

    // The cleanup is CHECKED, not trusted. These run after the finally, so a
    // delete that silently matched nothing fails the test here rather than
    // leaving two rows behind for someone to find later.
    expect(await client.whatsAppConnection.findUnique({ where: { id: connection.id } })).toBeNull();
    expect(await client.unit.findUnique({ where: { id: unitId } })).toBeNull();
  });
});
