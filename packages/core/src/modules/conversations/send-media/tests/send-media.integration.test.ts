/**
 * Test design (testing-strategy) — conversations / send-media
 *
 * Module role: `module_conversations` for the loja check; the outbox row is
 * written by channel's `enqueueOutbound` under `module_channel`. The probe is
 * awaited between the two, inside neither transaction (W2-C12).
 *
 * Moved from `apps/api/src/conversations.media.test.ts` (4A), assertions
 * unchanged: its seven multipart POST cases. The 401 and the queued-bytes read
 * back through fetch-media stay on the whole app in
 * `apps/api/test/conversations.integration.test.ts`; the empty-JSON text case is
 * send-message's.
 *
 * SUT: `POST /conversations/:id/messages/media`, through `buildSliceApp` with
 *   this slice's route only, inside one rolling-back transaction, with the LIVE
 *   probe a function the test controls. `buildSliceApp` registers multipart with
 *   the same 16 MiB file limit the api does.
 *
 * Spec (openspec/specs/conversations/conversas, whatsapp-media-on-demand): multipart send
 *   enqueues outbox; 16 MiB cap before insert; disconnected send is 409, not
 *   faked sent.
 *
 * BVA (file size, bytes): MEDIA_MAX_BYTES+1 rejected. 0-byte file unspecified.
 *
 * Decisions
 *   P1 !file / schema fail / too large — 400
 *   P2 conversation not in the loja    — unknown-conversation it
 *   P3 probe down                      — probe-down it (the column stays CONNECTED)
 *   P4 byteLength > MEDIA_MAX_BYTES    — oversize it; under-cap is false
 *   key already queued                 — reuse it (one row, same id)
 */
import { expect, it } from "vitest";
import { MEDIA_MAX_BYTES, conversationMessageSchema } from "../../contracts/http.js";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  MULTIPART_BOUNDARY,
  multipartPayload,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createRoute } from "../index.js";

const db = () => prisma as PrismaClient;
const FAKE_IMAGE = Buffer.from("fake-image-bytes");
const imageForm = (fields: Record<string, string> = { messageType: "image" }) =>
  multipartPayload(fields, { filename: "foto.jpg", contentType: "image/jpeg", body: FAKE_IMAGE });

function outboxCount(tx: DbClient, conversationId: string) {
  return tx.outboxMessage.count({ where: { conversationId } });
}

/** One loja, one CONNECTED connection, one conversation, and an app over the given probe. */
async function setup(tx: DbClient, connected = true) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) =>
      registerSlice(app, "conversations", "send-media", createRoute({ channelConnected: async () => connected })),
    caller: { userId: "media-test-caller", unitId: unit.id },
  });
  const post = (form: { payload: Buffer; headers: Record<string, string> }, conversationId = conversation.id) =>
    app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages/media`,
      headers: form.headers,
      payload: form.payload,
    });
  return { connection, conversation, app, post };
}

describeWithDatabase("POST /conversations/:id/messages/media", () => {
  it("queues an image under the cap as one outbox row", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, post } = await setup(tx);

      const response = await post(imageForm());

      expect(response.statusCode).toBe(201);
      expect(conversationMessageSchema.parse(response.json())).toMatchObject({
        direction: "outbound",
        messageType: "image",
        textBody: null,
        outboxStatus: "queued",
      });
      expect(await outboxCount(tx, conversation.id)).toBe(1);
      // The bytes really reached the row, not only the response.
      const row = await tx.outboxMessage.findFirst({
        where: { conversationId: conversation.id },
        select: { mediaBytes: true, messageType: true },
      });
      expect(row?.messageType).toBe("image");
      expect(row?.mediaBytes?.byteLength).toBe(FAKE_IMAGE.byteLength);
      await app.close();
    }));

  it("rejects a file larger than 16 MiB with zero outbox rows", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, post } = await setup(tx);
      const form = multipartPayload(
        { messageType: "image" },
        { filename: "huge.bin", contentType: "application/octet-stream", body: Buffer.alloc(MEDIA_MAX_BYTES + 1) },
      );

      const response = await post(form);

      expect(response.statusCode).toBe(400);
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("returns 409 for media send when the live probe is down", () =>
    withTestTransaction(db(), async (tx) => {
      // Probe, not column: the connection row stays CONNECTED throughout, so a
      // 409 driven by the column would not appear here.
      const { connection, conversation, app, post } = await setup(tx, false);
      expect(
        (await tx.whatsAppConnection.findUnique({ where: { id: connection.id }, select: { connectionState: true } }))
          ?.connectionState,
      ).toBe("CONNECTED");

      const response = await post(imageForm());

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ state: "DISCONNECTED" });
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("rejects a media POST with no file", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, post } = await setup(tx);
      const boundary = MULTIPART_BOUNDARY;
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="messageType"\r\n\r\nimage\r\n--${boundary}--\r\n`,
      );

      const response = await post({ payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });

      expect(response.statusCode).toBe(400);
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("rejects a media POST with an invalid messageType", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, post } = await setup(tx);

      const response = await post(imageForm({ messageType: "sticker" }));

      expect(response.statusCode).toBe(400);
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("returns 404 for media POST on an unknown conversation", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, post } = await setup(tx);

      const response = await post(imageForm(), "missing-id");

      expect(response.statusCode).toBe(404);
      await app.close();
    }));

  it("reuses an existing media outbox row when the idempotencyKey matches", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, post } = await setup(tx);
      // Generated, not literal: `OutboxMessage.idempotencyKey` is globally
      // unique, so a fixed string would collide with any concurrent file.
      const form = imageForm({ messageType: "image", idempotencyKey: `t-media-${conversation.id}` });

      const first = await post(form);
      const second = await post(form);

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
      expect(await outboxCount(tx, conversation.id)).toBe(1);
      const row = await tx.outboxMessage.findFirst({
        where: { conversationId: conversation.id },
        select: { mediaBytes: true },
      });
      expect(row?.mediaBytes?.byteLength).toBe(FAKE_IMAGE.byteLength);
      await app.close();
    }));
});
