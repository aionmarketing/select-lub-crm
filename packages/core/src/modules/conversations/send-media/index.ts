/**
 * `POST /conversations/:id/messages/media` — queues an attendant's image,
 * audio, document or video, multipart, for the worker to send.
 *
 * Moved from `apps/api/src/conversations/routes.ts` and `enqueueMedia()` in
 * `conversations/prisma.ts` (4A); the path and every answer are unchanged: 201
 * with the queued message; 400 for no file, a bad field or a file over
 * `MEDIA_MAX_BYTES`; 404 for another loja's thread; 409 `DISCONNECTED` when the
 * LIVE probe says the session is down. The probe is awaited between the loja
 * check and the outbox write, inside neither transaction (W2-C12).
 */
import { MEDIA_MAX_BYTES, conversationMessageSchema, sendMediaBodySchema } from "../contracts/http.js";
import { channelStatusSchema } from "../../channel/contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { findConversationInUnit } from "../internal/conversation-scope.js";
import { queueOutbound } from "../internal/outbound.js";
import { conversationIdParams, emptyBody, multipartField } from "../internal/params.js";
import type { ConversationsPorts } from "../internal/ports.js";

/** Request and response schemas; the multipart body is parsed in the handler. */
export const schema = {
  params: conversationIdParams,
  response: { 201: conversationMessageSchema, 400: emptyBody, 404: emptyBody, 409: channelStatusSchema },
};

type MediaRequest = FastifyRequest<{ Params: z.infer<typeof conversationIdParams> }>;

/** Reads the one file and its fields, or null for any 400. */
async function readUpload(request: MediaRequest) {
  const tooLarge = request.server.multipartErrors.RequestFileTooLargeError;
  let file;
  try {
    file = await request.file();
  } catch (error) {
    if (error instanceof tooLarge) {
      return null;
    }
    throw error;
  }
  if (!file) {
    return null;
  }
  const parsed = sendMediaBodySchema.safeParse({
    messageType: multipartField(file.fields, "messageType"),
    caption: multipartField(file.fields, "caption"),
    idempotencyKey: multipartField(file.fields, "idempotencyKey"),
  });
  if (!parsed.success) {
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = await file.toBuffer();
  } catch (error) {
    if (error instanceof tooLarge) {
      return null;
    }
    throw error;
  }
  if (bytes.byteLength > MEDIA_MAX_BYTES) {
    return null;
  }
  return {
    fields: parsed.data,
    bytes,
    mimeType: file.mimetype || "application/octet-stream",
    fileName: file.filename.trim() || "file",
  };
}

/**
 * The route, with the live probe closed over.
 *
 * @param ports - Only `channelConnected` is read.
 * @returns The slice's route; the path is unchanged from `apps/api`.
 */
export function createRoute(ports: Pick<ConversationsPorts, "channelConnected">): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/conversations/:id/messages/media",
    schema,
    handler: async (request: MediaRequest, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const upload = await readUpload(request);
      if (!upload) {
        return reply.code(400).send({});
      }
      const db = request.server.db;
      const conversation = await findConversationInUnit(db, unitId, request.params.id);
      if (!conversation) {
        return reply.code(404).send({});
      }
      if (!(await ports.channelConnected())) {
        return reply.code(409).send({ state: "DISCONNECTED" });
      }
      const caption = upload.fields.caption?.trim() ? upload.fields.caption.trim() : null;
      const message = await queueOutbound(db, {
        conversationId: conversation.id,
        messageType: upload.fields.messageType,
        textBody: caption,
        media: { bytes: upload.bytes, mimeType: upload.mimeType, fileName: upload.fileName },
        idempotencyKey: upload.fields.idempotencyKey,
      });
      return reply.code(201).send(message);
    },
  };
}
