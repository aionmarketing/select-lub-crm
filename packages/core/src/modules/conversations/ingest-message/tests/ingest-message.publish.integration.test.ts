/**
 * Test design (testing-strategy) — when `conversations/message-received` is
 * published, and what a subscriber can and cannot change
 *
 * Module role: `module_conversations` for the message writes; `module_channel`
 * for the webhook event's status, through channel's contracts.
 *
 * New in 4A, from the orchestrator's review of #151.
 *
 * 1. A THROWING SUBSCRIBER CANNOT FAIL THE EVENT. The kernel's `publish`
 *    rethrows a subscriber's error. Published inside the try that marks the
 *    event, one throw would flip a processed event to failed; the retry would
 *    then find the message already inserted (a no-op insert) and never publish
 *    again, and the trigger would be lost for every subscriber (prefill's
 *    enqueue, from 4C). So the publish runs after that try, and a failure is
 *    logged. There are no subscribers today, so no behaviour changes; this pins
 *    it before 4C adds one. The case CAN fail: move the publish back inside the
 *    try and the event reads `failed`.
 * 2. NOT PUBLISHED FOR HISTORY OR FOR THE DRAIN'S INSERT. The contract header
 *    (`contracts/message-received.ts`) promises the event only for a new insert
 *    on the webhook path, never for backfilled history — which must not open a
 *    live prefill window — nor for the drain's outbound insert. `capture()`
 *    counts the publications on each path. Positive controls: the webhook path
 *    publishes once, and each silent path really inserted its message, so a zero
 *    is not a path that did nothing.
 */
import { expect, it } from "vitest";
import { capture, publish, subscribe } from "../../../../kernel/events.js";
import { outboundSent } from "../../../channel/contracts/index.js";
import { messageReceived } from "../../contracts/message-received.js";
import { describeWithDatabase, historyRow, upsertPayload, withTestTransaction } from "../../../../testing/index.js";
import { canonicalizeEvent, ingestHistoryRecord, insertSentMessages, persistRawEvent } from "../index.js";
import { db, setup } from "./ingest.fixture.js";

describeWithDatabase("message-received publication", () => {
  it("publishes once for a new webhook message (the positive control)", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const event = await persistRawEvent(store, upsertPayload({ instance: connection.instanceName, id: "PUB-1" }));

      const seen = await capture(messageReceived, () => canonicalizeEvent(store, event.id));

      expect(seen.map((payload) => payload.externalMessageId)).toEqual(["PUB-1"]);
    }));

  it("leaves the event processed and the message inserted when a subscriber throws", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const event = await persistRawEvent(store, upsertPayload({ instance: connection.instanceName, id: "PUB-THROW" }));
      let called = 0;
      const off = subscribe(messageReceived, () => {
        called += 1;
        throw new Error("subscriber down");
      });
      const logs: string[] = [];
      try {
        await canonicalizeEvent(store, event.id, (line) => logs.push(line));
      } finally {
        off();
      }

      // Precondition: the subscriber really ran and really threw.
      expect(called).toBe(1);
      expect((await store.getEvent(event.id))?.status).toBe("processed");
      expect(
        await tx.message.count({
          where: { externalMessageId: "PUB-THROW", conversation: { whatsappConnectionId: connection.id } },
        }),
      ).toBe(1);
      expect(logs).toContain("message-received subscriber failed subscriber down");
    }));

  it("does not publish for a backfilled history record", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);

      const seen = await capture(messageReceived, () =>
        ingestHistoryRecord(store)({
          connectionId: connection.id,
          record: historyRow({ id: "PUB-HIST", remoteJid: "5511944443333@s.whatsapp.net" }),
        }),
      );

      expect(seen).toEqual([]);
      expect(
        await tx.message.count({
          where: { externalMessageId: "PUB-HIST", conversation: { whatsappConnectionId: connection.id } },
        }),
      ).toBe(1);
    }));

  it("does not publish for the drain's outbound insert", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const off = insertSentMessages(store);
      try {
        const seen = await capture(messageReceived, () =>
          publish(outboundSent, {
            whatsappConnectionId: connection.id,
            remoteJid: "5511944443333@s.whatsapp.net",
            chatKey: "5511944443333",
            externalMessageId: "PUB-OUT",
            direction: "outbound",
            messageType: "text",
            textBody: "resposta",
            providerTimestamp: new Date("2099-01-01T12:00:00.000Z"),
          }),
        );

        expect(seen).toEqual([]);
      } finally {
        off();
      }
      expect(
        await tx.message.count({
          where: { externalMessageId: "PUB-OUT", conversation: { whatsappConnectionId: connection.id } },
        }),
      ).toBe(1);
    }));
});
