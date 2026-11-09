/**
 * Test design (testing-strategy)
 *
 * SUT: `drainOnce` on media rows — routing to `sendMedia` / `sendWhatsAppAudio`,
 *   the payload's optional keys, and what happens to the bytes — through the
 *   slice's entry point, on the real database in a rolling-back transaction.
 *
 * Ran under module role: `channel` (every query is `db.tx("channel")`; asserted in
 *   drain-outbox.integration.test.ts).
 *
 * Moved from apps/worker/src/outbox/drain.test.ts (adopt-modular-vertical-slices
 * 3A); see drain-outbox.loop.integration.test.ts for that file's full header. As
 * in drain-outbox.integration.test.ts, "an outbound message was inserted" is now
 * read from the published `channel/outbound-sent` event (exception W3-C4).
 *
 * D9 / D12 / D14 were once recorded as out of scope on grounds that did not
 * hold, and the correction is kept so it stays auditable:
 *   D9 missing mediaBytes — a legal production sequence: bytes are discarded when
 *     an item becomes `blocked`, and a blocked item is queued again after
 *     reconnect, so the next claim carries mediaBytes null.
 *   D12 audio — a separate branch with a different payload shape (`audio`, no
 *     `mediatype`); removing it reroutes audio to the unsupported-type refusal.
 *   D14 unsupported messageType — `outbox_message.message_type` is an
 *     unconstrained `String`, which this file demonstrates by storing one.
 *
 * Oracle: whatsapp-channel outbox-media requirement ("audio as WhatsApp audio,
 *   the others as media/document/video send"; bytes discarded on confirm, block
 *   and exhaustion) + harden-suite-branch-coverage (Queued video reaches
 *   Evolution).
 *
 * Axes: 6 messageType — image vs video vs audio vs document vs unknown; 7
 *   mediaBytes after terminal — present while queued vs null after confirmed /
 *   blocked / exhaustion. BVA on OUTBOX_RETRY_MAX_ATTEMPTS = 5: 4 keeps
 *   bytes+queued; 5 → failed+null.
 */
import { expect, it, vi } from "vitest";
import { describeWithDatabase, withTestTransaction } from "../../../../testing/index.js";
import { drainOnce, OUTBOX_RETRY_MAX_ATTEMPTS, type EvolutionSend } from "../index.js";
import {
  ageBeyondBackoff,
  CHAT_KEY,
  db,
  drainCapturing,
  enqueue,
  rowOf,
  setup,
  stubEvolution,
} from "./drain-outbox.fixture.js";

const JPEG = { messageType: "image", mediaBytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaMimeType: "image/jpeg", mediaFileName: "foto.jpg" };
const MP4 = { messageType: "video", mediaBytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]), mediaMimeType: "video/mp4", mediaFileName: "clip.mp4" };
const AT_NOON = new Date("2026-01-01T12:00:00.000Z");

function refuse(kind: string) {
  return async (): Promise<never> => {
    throw new Error(`sendText must not run for ${kind}`);
  };
}

describeWithDatabase("drain-outbox — media", () => {
  it("sends a queued image through sendMedia and drops bytes on confirm", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "frente", JPEG);
      const sendMedia = vi.fn(async () => ({ ok: true as const, externalMessageId: "img-1", providerTimestamp: AT_NOON }));
      const sendText = vi.fn(refuse("image"));

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({ db: handle, evolution: stubEvolution({ sendText, sendMedia }) }),
      );

      expect(sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mediatype: "image", caption: "frente", fileName: "foto.jpg", mimetype: "image/jpeg" }),
      );
      expect(sendText).not.toHaveBeenCalled();
      const row = await rowOf(tx, id);
      expect(row.status).toBe("confirmed");
      expect(row.mediaBytes).toBeNull();
      const images = outbound.filter((message) => message.messageType === "image");
      expect(images).toHaveLength(1);
      expect(images[0]?.providerTimestamp).toEqual(AT_NOON);
    }));

  it("blocks a disconnected image send without confirming and drops bytes", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "frente", JPEG);
      const sendMedia = vi.fn(async () => ({ ok: false as const, kind: "disconnected" as const, error: "evolution 404" }));

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({ db: handle, evolution: stubEvolution({ sendText: refuse("image"), sendMedia }) }),
      );

      expect(sendMedia).toHaveBeenCalled();
      const row = await rowOf(tx, id);
      expect(row.status).toBe("blocked");
      expect(row.mediaBytes).toBeNull();
      expect(outbound).toHaveLength(0);
    }));

  it("sends a queued video through sendMedia and confirms", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "video", MP4);
      const sendMedia = vi.fn(async () => ({ ok: true as const, externalMessageId: "vid-1", providerTimestamp: AT_NOON }));
      const sendText = vi.fn(refuse("video"));

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({ db: handle, evolution: stubEvolution({ sendText, sendMedia }) }),
      );

      expect(sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mediatype: "video", caption: "video", fileName: "clip.mp4", mimetype: "video/mp4" }),
      );
      expect(sendText).not.toHaveBeenCalled();
      expect((await rowOf(tx, id)).status).toBe("confirmed");
      expect(outbound.filter((message) => message.messageType === "video")).toHaveLength(1);
    }));

  it("blocks a disconnected video send without confirming", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "video", MP4);
      const sendMedia = vi.fn(async () => ({ ok: false as const, kind: "disconnected" as const, error: "evolution 404" }));

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({ db: handle, evolution: stubEvolution({ sendText: refuse("video"), sendMedia }) }),
      );

      expect(sendMedia).toHaveBeenCalledWith(expect.objectContaining({ mediatype: "video" }));
      expect((await rowOf(tx, id)).status).toBe("blocked");
      expect(outbound).toHaveLength(0);
    }));

  it("nulls media bytes after retry exhaustion and leaves a failed row", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "frente", JPEG);
      const evolution = stubEvolution({
        sendText: refuse("image"),
        async sendMedia() {
          return { ok: false, kind: "retryable", error: "network ECONNREFUSED" };
        },
      });

      const outbound = await drainCapturing(connection.id, async () => {
        for (let i = 0; i < OUTBOX_RETRY_MAX_ATTEMPTS - 1; i += 1) {
          await drainOnce({ db: handle, evolution });
          const row = await rowOf(tx, id);
          expect(row.status).toBe("queued");
          expect(row.mediaBytes).not.toBeNull();
          // Age past the backoff between attempts, which real elapsed time would do.
          // Without this the row is not claimable again and the loop silently stops
          // attempting — the assertions above would still pass on a row that was
          // never retried at all.
          await ageBeyondBackoff(tx, id);
        }
        await drainOnce({ db: handle, evolution });
      });

      const row = await rowOf(tx, id);
      expect(row.status).toBe("failed");
      expect(row.mediaBytes).toBeNull();
      expect(outbound).toHaveLength(0);
    }));

  it("sends a queued audio through sendWhatsAppAudio, not sendMedia", () =>
    withTestTransaction(db(), async (tx) => {
      // A8. Audio is NOT the image arm with a different method name: it takes its
      // own branch and a different payload shape (`audio`, with no `mediatype`).
      // Deleting that branch routes audio to "unsupported message type", and every
      // attendant audio reply requeues until it exhausts retries and fails.
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, null, {
        messageType: "audio",
        mediaBytes: new Uint8Array([0x4f, 0x67, 0x67]),
        mediaMimeType: "audio/ogg",
        mediaFileName: null,
      });
      const sendWhatsAppAudio = vi.fn(async () => ({ ok: true as const, externalMessageId: "aud-1", providerTimestamp: AT_NOON }));
      const sendMedia = vi.fn(async () => {
        throw new Error("sendMedia must not run for audio");
      });
      const sendText = vi.fn(refuse("audio"));

      const outcome = await drainOnce({ db: handle, evolution: stubEvolution({ sendText, sendMedia, sendWhatsAppAudio }) });

      expect(outcome).toBe("confirmed");
      expect(sendWhatsAppAudio).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceName: connection.instanceName,
          number: CHAT_KEY,
          audio: Buffer.from([0x4f, 0x67, 0x67]).toString("base64"),
        }),
      );
      expect(sendMedia).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect((await rowOf(tx, id)).status).toBe("confirmed");
    }));

  it.each([
    // A document reaches WhatsApp without a usable name when fileName is
    // dropped, so it alone gets a fallback; both outcomes of the conditional are
    // sampled. The mimetype column samples the other optional spread: an absent
    // mimetype must OMIT the key, not send `undefined`.
    ["document", "application/pdf", "file", "application/pdf"],
    ["image", null, undefined, undefined],
  ] as const)(
    "sends an unnamed %s with fileName %o and mimetype %o",
    (messageType, mediaMimeType, expectedFileName, expectedMimetype) =>
      withTestTransaction(db(), async (tx) => {
        const { conversationId, db: handle } = await setup(tx);
        await enqueue(tx, conversationId, null, {
          messageType,
          mediaBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          mediaMimeType,
          mediaFileName: null,
        });
        const payloads: Parameters<EvolutionSend["sendMedia"]>[0][] = [];
        const sendMedia = vi.fn(async (input: Parameters<EvolutionSend["sendMedia"]>[0]) => {
          payloads.push(input);
          return { ok: true as const, externalMessageId: `${messageType}-1`, providerTimestamp: AT_NOON };
        });

        await drainOnce({ db: handle, evolution: stubEvolution({ sendText: refuse(messageType), sendMedia }) });

        expect(payloads).toHaveLength(1);
        expect(payloads[0]?.fileName).toBe(expectedFileName);
        expect(payloads[0]?.mimetype).toBe(expectedMimetype);
        expect("mimetype" in (payloads[0] ?? {})).toBe(expectedMimetype !== undefined);
      }),
  );

  it("refuses a media send whose bytes were already discarded, without calling Evolution", () =>
    withTestTransaction(db(), async (tx) => {
      // D9, built only through the drain's own writes — drain to blocked, then
      // requeue — so it is the real sequence.
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, null, JPEG);

      await drainOnce({
        db: handle,
        evolution: stubEvolution({
          sendText: refuse("image"),
          async sendMedia() {
            return { ok: false, kind: "disconnected", error: "evolution 404" };
          },
        }),
      });
      const blocked = await rowOf(tx, id);
      expect(blocked.status).toBe("blocked");
      expect(blocked.mediaBytes).toBeNull();

      // Reconnect requeues the blocked row; its bytes are gone.
      await tx.outboxMessage.update({ where: { id }, data: { status: "queued" } });
      const sendMedia = vi.fn(async () => ({ ok: true as const, externalMessageId: "img-2", providerTimestamp: AT_NOON }));

      let outcome: string | undefined;
      const outbound = await drainCapturing(connection.id, async () => {
        outcome = await drainOnce({ db: handle, evolution: stubEvolution({ sendText: refuse("image"), sendMedia }) });
      });

      expect(outcome).toBe("failed");
      // The point: an empty payload is never sent to a real customer.
      expect(sendMedia).not.toHaveBeenCalled();
      expect((await rowOf(tx, id)).lastError).toContain("missing media bytes");
      expect(outbound).toHaveLength(0);
    }));

  it("refuses an unrecognized message type instead of dispatching it", () =>
    withTestTransaction(db(), async (tx) => {
      // `outbox_message.message_type` is a plain String column with no check
      // constraint, so a type the schema allows but the drain has not learned to
      // send reaches this branch. The row below is a real one.
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, null, {
        messageType: "sticker",
        mediaBytes: new Uint8Array([0x01]),
        mediaMimeType: "image/webp",
        mediaFileName: null,
      });
      const sendText = vi.fn();
      const sendMedia = vi.fn();
      const sendWhatsAppAudio = vi.fn();

      let outcome: string | undefined;
      const outbound = await drainCapturing(connection.id, async () => {
        outcome = await drainOnce({
          db: handle,
          evolution: stubEvolution({
            sendText: sendText as unknown as EvolutionSend["sendText"],
            sendMedia: sendMedia as unknown as EvolutionSend["sendMedia"],
            sendWhatsAppAudio: sendWhatsAppAudio as unknown as EvolutionSend["sendWhatsAppAudio"],
          }),
        });
      });

      expect(outcome).toBe("failed");
      expect(sendText).not.toHaveBeenCalled();
      expect(sendMedia).not.toHaveBeenCalled();
      expect(sendWhatsAppAudio).not.toHaveBeenCalled();
      const row = await rowOf(tx, id);
      expect(row.status).toBe("failed");
      expect(row.attemptCount).toBe(1);
      expect(row.lastError).toBe("unsupported message type");
      expect(outbound).toHaveLength(0);
    }));
});
