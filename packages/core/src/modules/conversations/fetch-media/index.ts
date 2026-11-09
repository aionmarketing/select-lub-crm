/**
 * `GET /conversations/:id/messages/:messageId/media` — a media message's bytes:
 * from Evolution for a canonical message, from the outbox row for a send still
 * in flight.
 *
 * Moved from `apps/api/src/conversations/routes.ts` and `fetchMedia()` in
 * `conversations/prisma.ts` (4A); the path and every answer are unchanged: 404
 * for another loja's thread, a text message or an unknown id; 502
 * `media_unavailable` when the LIVE probe is down or Evolution has no file. The
 * probe and the download are awaited after the reads, inside no transaction
 * (W2-C12); the bytes are never stored on the message.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { findConversationInUnit } from "../internal/conversation-scope.js";
import { isMediaMessageType, type FetchMediaResult } from "../internal/conversation-dto.js";
import { contentDisposition, mediaParams } from "../internal/params.js";
import type { ConversationsPorts } from "../internal/ports.js";

/**
 * Fetches one media message's bytes.
 *
 * @param db - The database handle; each read runs in its own
 *   `db.tx("conversations", …)`.
 * @param ports - The live probe and Evolution's download.
 * @param input - The loja and the path ids.
 * @returns The bytes and how to serve them, `not_found`, or `unavailable`.
 */
export async function fetchMedia(
  db: Db,
  ports: Pick<ConversationsPorts, "channelConnected" | "fetchMedia">,
  input: { unitId: string; conversationId: string; messageId: string },
): Promise<FetchMediaResult> {
  const conversation = await findConversationInUnit(db, input.unitId, input.conversationId);
  if (!conversation) {
    return { status: "not_found" };
  }
  const row = await db.tx("conversations", (tx) =>
    tx.message.findFirst({ where: { id: input.messageId, conversationId: conversation.id } }),
  );
  if (row) {
    if (!isMediaMessageType(row.messageType)) {
      return { status: "not_found" };
    }
    if (!(await ports.channelConnected())) {
      return { status: "unavailable" };
    }
    // Addressed at the conversation's OWN connection, not the configured one:
    // a unit may hold two, and the message lives on the one that received it.
    const fetched = await ports.fetchMedia({
      instanceName: conversation.instanceName,
      externalMessageId: row.externalMessageId,
      convertToMp4: row.messageType === "video",
    });
    if (!fetched.ok) {
      return { status: "unavailable" };
    }
    return {
      status: "ok",
      bytes: fetched.bytes,
      mimeType: fetched.mimeType ?? row.mediaMimeType ?? "application/octet-stream",
      fileName: fetched.fileName ?? row.mediaFileName,
      messageType: row.messageType,
    };
  }
  const pending = await db.tx("conversations", (tx) =>
    tx.outboxMessage.findFirst({
      where: { id: input.messageId, conversationId: conversation.id, NOT: { status: "confirmed" } },
    }),
  );
  if (!pending || !isMediaMessageType(pending.messageType)) {
    return { status: "not_found" };
  }
  if (!pending.mediaBytes) {
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    bytes: pending.mediaBytes,
    mimeType: pending.mediaMimeType ?? "application/octet-stream",
    fileName: pending.mediaFileName,
    messageType: pending.messageType,
  };
}

/** Request schema; the body is bytes, so no response schema. */
export const schema = { params: mediaParams };

/**
 * The route, with the probe and the download closed over.
 *
 * @param ports - `channelConnected` and `fetchMedia`.
 * @returns The slice's route; the path is unchanged from `apps/api`.
 */
export function createRoute(
  ports: Pick<ConversationsPorts, "channelConnected" | "fetchMedia">,
): SliceRoute<typeof schema> {
  return {
    method: "GET",
    path: "/conversations/:id/messages/:messageId/media",
    schema,
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof mediaParams> }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const result = await fetchMedia(request.server.db, ports, {
        unitId,
        conversationId: request.params.id,
        messageId: request.params.messageId,
      });
      if (result.status === "not_found") {
        return reply.code(404).send({});
      }
      if (result.status === "unavailable") {
        return reply.code(502).send({ code: "media_unavailable" });
      }
      return reply
        .header("content-type", result.mimeType)
        .header("content-disposition", contentDisposition(result.messageType, result.fileName))
        .send(Buffer.from(result.bytes));
    },
  };
}
