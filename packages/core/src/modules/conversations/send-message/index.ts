/**
 * `POST /conversations/:id/messages` — queues an attendant's text for the
 * worker to send.
 *
 * Moved from `apps/api/src/conversations/routes.ts` and `enqueue()` in
 * `conversations/prisma.ts` (4A); the path and every answer are unchanged: 201
 * with the queued message, 404 for another loja's thread, 409 `DISCONNECTED`
 * when the LIVE probe says the session is down. The probe is awaited between
 * the loja check and the outbox write, inside neither transaction (W2-C12).
 */
import { channelStatusSchema } from "../../channel/contracts/http.js";
import { conversationMessageSchema, sendTextBodySchema } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { findConversationInUnit } from "../internal/conversation-scope.js";
import { queueOutbound } from "../internal/outbound.js";
import { conversationIdParams, emptyBody } from "../internal/params.js";
import type { ConversationsPorts } from "../internal/ports.js";

/** Request and response schemas. */
export const schema = {
  params: conversationIdParams,
  body: sendTextBodySchema,
  response: { 201: conversationMessageSchema, 404: emptyBody, 409: channelStatusSchema },
};

/**
 * The route, with the live probe closed over.
 *
 * @param ports - Only `channelConnected` is read.
 * @returns The slice's route; the path is unchanged from `apps/api`.
 */
export function createRoute(ports: Pick<ConversationsPorts, "channelConnected">): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/conversations/:id/messages",
    schema,
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof conversationIdParams>;
        Body: z.infer<typeof sendTextBodySchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const db = request.server.db;
      const conversation = await findConversationInUnit(db, unitId, request.params.id);
      if (!conversation) {
        return reply.code(404).send({});
      }
      if (!(await ports.channelConnected())) {
        return reply.code(409).send({ state: "DISCONNECTED" });
      }
      const message = await queueOutbound(db, {
        conversationId: conversation.id,
        messageType: "text",
        textBody: request.body.text,
        idempotencyKey: request.body.idempotencyKey,
      });
      return reply.code(201).send(message);
    },
  };
}
