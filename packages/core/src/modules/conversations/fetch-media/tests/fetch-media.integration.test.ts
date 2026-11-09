/**
 * Test design (testing-strategy) — conversations / fetch-media
 *
 * Module role: `module_conversations` for the loja check, the message read and
 * the outbox read, each its own `db.tx`. The probe and the download are awaited
 * after them, inside no transaction (W2-C12).
 *
 * Moved from `apps/api/src/conversations.media.test.ts` (4A), assertions
 * unchanged: its eight GET cases. The 401 comes from the auth hook, and "returns
 * queued outbox media bytes without calling the port" first queues through the
 * send-media route; those two stay on the whole app in
 * `apps/api/test/conversations.integration.test.ts`.
 *
 * SUT: `GET /conversations/:id/messages/:messageId/media`, through
 *   `buildSliceApp` with this slice's route only, inside one rolling-back
 *   transaction. The fake Evolution is the `fetchMedia` PORT — an external
 *   system, not a store — and records every call; the LIVE probe is a function
 *   the test controls.
 *
 * WHAT ONLY HELD ON THE FAKE (from the original file)
 *   1. The port is called with the CONVERSATION'S instance name, read through
 *      `conversation → whatsapp_connection`. The route has no configured
 *      instance at all, so a fetch addressed anywhere else cannot happen by
 *      construction; the own-connection case still pins it against a second
 *      connection in the same loja.
 *   2. Scoping is a join: the other-loja case hangs its conversation off a
 *      connection in another loja. It used to switch the `x-unit-id` header on
 *      one app; a slice app states its caller, so each loja gets its own app.
 *
 * Spec (openspec/specs/conversations/conversas, whatsapp-media-on-demand): GET bytes on demand
 *   for image/audio/video/document in the current unit. Do not persist bytes on
 *   the canonical message. Documented error when the instance cannot supply the
 *   file. Other-unit / text / unknown → no bytes.
 *
 * Outputs: O1 200 raw bytes; O2 502 { code: media_unavailable }; O3 404 {}.
 *
 * Decisions
 *   G1 conversation scoped by the join — 404 vs found (other-unit)
 *   G2 !isMediaMessageType          — T (text, unknown) / F (image, video)
 *   G3 !channelConnected()          — T probe-down it / F success its
 *   G5 fetched.ok                   — T success / F missing-file
 *   G6 messageType === "video"      — convertToMp4 it
 */
import { expect, it } from "vitest";
import { conversationMessageSchema, mediaFetchErrorSchema } from "../../contracts/http.js";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createRoute } from "../index.js";

const db = () => prisma as PrismaClient;
const FAKE_IMAGE = Buffer.from("fake-image-bytes");

type MediaFetchCall = { instanceName: string; externalMessageId: string | null; convertToMp4: boolean };
type MediaFetchResult =
  | { ok: true; bytes: Uint8Array; mimeType: string | null; fileName: string | null }
  | { ok: false };

/** Creates one canonical inbound message and returns its id and time. */
function addMessage(
  tx: DbClient,
  conversationId: string,
  input: { messageType: string; externalMessageId: string; textBody?: string | null },
) {
  return tx.message.create({
    data: {
      conversationId,
      externalMessageId: input.externalMessageId,
      direction: "inbound",
      messageType: input.messageType,
      textBody: input.textBody ?? null,
      providerTimestamp: new Date("2026-08-26T12:00:00.000Z"),
    },
    select: { id: true, providerTimestamp: true },
  });
}

/** An app over this slice's route, a probe the test controls and a recording fake port. */
async function mediaApp(
  tx: DbClient,
  unitId: string,
  options: { connected?: () => boolean; media?: () => Promise<MediaFetchResult> } = {},
) {
  const calls: MediaFetchCall[] = [];
  const connected = options.connected ?? (() => true);
  const route = createRoute({
    channelConnected: async () => connected(),
    fetchMedia: async (call) => {
      calls.push({
        instanceName: call.instanceName,
        externalMessageId: call.externalMessageId,
        convertToMp4: call.convertToMp4,
      });
      return options.media
        ? await options.media()
        : { ok: true, bytes: FAKE_IMAGE, mimeType: "image/jpeg", fileName: "foto.jpg" };
    },
  });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "conversations", "fetch-media", route),
    caller: { userId: "media-test-caller", unitId },
  });
  const get = (conversationId: string, messageId: string) =>
    app.inject({ method: "GET", url: `/conversations/${conversationId}/messages/${messageId}/media` });
  return { app, calls, lastCall: () => calls.at(-1) ?? null, get };
}

/** One loja, one connection, one conversation, and an app scoped to the loja. */
async function setup(tx: DbClient, options: Parameters<typeof mediaApp>[2] = {}) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  return { connection, conversation, ...(await mediaApp(tx, unit.id, options)) };
}

describeWithDatabase("GET /conversations/:id/messages/:messageId/media", () => {
  it("returns image bytes from the fake Evolution port without storing them on the message", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversation, app, lastCall, get } = await setup(tx);
      const message = await addMessage(tx, conversation.id, { messageType: "image", externalMessageId: "WA-IMG" });

      const response = await get(conversation.id, message.id);

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/image\/jpeg/);
      expect(Buffer.from(response.rawPayload).equals(FAKE_IMAGE)).toBe(true);
      // Nothing was persisted onto the canonical row.
      const stored = await tx.message.findUnique({
        where: { id: message.id },
        select: { mediaMimeType: true, mediaFileName: true },
      });
      expect(stored).toEqual({ mediaMimeType: null, mediaFileName: null });
      // The port is addressed to the CONVERSATION'S OWN instance.
      expect(lastCall()?.instanceName).toBe(connection.instanceName);
      expect(
        conversationMessageSchema.parse({
          id: message.id,
          direction: "inbound",
          messageType: "image",
          textBody: null,
          providerTimestamp: message.providerTimestamp.toISOString(),
        }).messageType,
      ).toBe("image");
      await app.close();
    }));

  it("addresses the port at the conversation's own connection, not another in the same unit", () =>
    withTestTransaction(db(), async (tx) => {
      // Two connections in one unit: the fetch must name the one the conversation
      // hangs off, which is also the row the route joins through.
      const unit = await seedUnit(tx);
      const owning = await seedConnection(tx, { unitId: unit.id });
      const other = await seedConnection(tx, { unitId: unit.id });
      expect(owning.instanceName).not.toBe(other.instanceName);

      const conversation = await seedConversation(tx, { connectionId: owning.id });
      const message = await addMessage(tx, conversation.id, { messageType: "image", externalMessageId: "WA-OWN" });
      const { app, lastCall, get } = await mediaApp(tx, unit.id);

      const response = await get(conversation.id, message.id);

      expect(response.statusCode).toBe(200);
      expect(lastCall()?.instanceName).toBe(owning.instanceName);
      expect(lastCall()?.instanceName).not.toBe(other.instanceName);
      await app.close();
    }));

  it("sets convertToMp4 true only when fetching video", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, lastCall, get } = await setup(tx, {
        media: async () => ({ ok: true, bytes: Buffer.from("vid"), mimeType: "video/mp4", fileName: "clip.mp4" }),
      });
      const image = await addMessage(tx, conversation.id, { messageType: "image", externalMessageId: "WA-IMG" });
      const video = await addMessage(tx, conversation.id, { messageType: "video", externalMessageId: "WA-VID" });

      await get(conversation.id, image.id);
      expect(lastCall()).toMatchObject({ externalMessageId: "WA-IMG", convertToMp4: false });

      await get(conversation.id, video.id);
      expect(lastCall()).toMatchObject({ externalMessageId: "WA-VID", convertToMp4: true });
      await app.close();
    }));

  it("returns media_unavailable when the live probe is down and does not call the port", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, calls, get } = await setup(tx, { connected: () => false });
      const message = await addMessage(tx, conversation.id, { messageType: "image", externalMessageId: "WA-IMG" });

      const response = await get(conversation.id, message.id);

      expect(response.statusCode).toBe(502);
      expect(mediaFetchErrorSchema.parse(response.json())).toEqual({ code: "media_unavailable" });
      // Not merely "no bytes": the port was never reached at all.
      expect(calls).toHaveLength(0);
      await app.close();
    }));

  it("returns media_unavailable when Evolution has no file", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, calls, get } = await setup(tx, { media: async () => ({ ok: false }) });
      const message = await addMessage(tx, conversation.id, { messageType: "image", externalMessageId: "WA-IMG" });

      const response = await get(conversation.id, message.id);

      expect(response.statusCode).toBe(502);
      expect(mediaFetchErrorSchema.parse(response.json())).toEqual({ code: "media_unavailable" });
      // Distinguishes this from the probe-down case above, which never calls.
      expect(calls).toHaveLength(1);
      await app.close();
    }));

  it("does not return media bytes for a conversation on another unit's connection", () =>
    withTestTransaction(db(), async (tx) => {
      const unitA = await seedUnit(tx);
      const unitB = await seedUnit(tx);
      await seedConnection(tx, { unitId: unitA.id });
      const connectionB = await seedConnection(tx, { unitId: unitB.id });
      const convB = await seedConversation(tx, { connectionId: connectionB.id });
      const message = await addMessage(tx, convB.id, { messageType: "image", externalMessageId: "WA-B" });

      const asA = await mediaApp(tx, unitA.id);
      const response = await asA.get(convB.id, message.id);

      expect(response.statusCode).toBe(404);
      expect(asA.calls).toHaveLength(0);
      expect(response.body).not.toContain("fake-image-bytes");
      await asA.app.close();

      // Converse: unit B, which owns the connection, does get the bytes — so the
      // 404 is the join refusing rather than the fixture being unreachable.
      const asB = await mediaApp(tx, unitB.id);
      const owned = await asB.get(convB.id, message.id);
      expect(owned.statusCode).toBe(200);
      await asB.app.close();
    }));

  it("does not return media bytes for a text message", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, calls, get } = await setup(tx);
      const message = await addMessage(tx, conversation.id, {
        messageType: "text",
        externalMessageId: "WA-TXT",
        textBody: "oi",
      });

      const response = await get(conversation.id, message.id);

      expect(response.statusCode).toBe(404);
      expect(calls).toHaveLength(0);
      await app.close();
    }));

  it("does not return media bytes for an unknown message type", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, calls, get } = await setup(tx);
      const message = await addMessage(tx, conversation.id, { messageType: "unknown", externalMessageId: "WA-UNK" });

      const response = await get(conversation.id, message.id);

      expect(response.statusCode).toBe(404);
      expect(calls).toHaveLength(0);
      await app.close();
    }));
});
