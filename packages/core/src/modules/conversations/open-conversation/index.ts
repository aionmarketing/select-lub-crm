/**
 * `POST /conversations` — Nova conversa: opens a thread for a phone, or reopens
 * the one that number already has on the configured connection.
 *
 * Moved from `apps/api/src/conversations/routes.ts` (4A); the path and every
 * answer are unchanged: 201 created, 200 reopened, 409 `channel_not_connected`
 * when the STORED connection state is not `CONNECTED`.
 */
import { conversationSummarySchema, createConversationBodySchema, createConversationErrorSchema } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { emptyBody } from "../internal/params.js";
import type { ConversationsPorts } from "../internal/ports.js";
import { openTagsByConversation } from "../internal/tag-store.js";
import { openConversation } from "./queries.js";

export { openConversation } from "./queries.js";

/** Request and response schemas. */
export const schema = {
  body: createConversationBodySchema,
  response: {
    200: conversationSummarySchema,
    201: conversationSummarySchema,
    404: emptyBody,
    409: createConversationErrorSchema,
  },
};

/**
 * The route, with the configured instance closed over.
 *
 * @param ports - Only `instanceName` is read.
 * @returns The slice's route; the path is unchanged from `apps/api`.
 */
export function createRoute(ports: Pick<ConversationsPorts, "instanceName">): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/conversations",
    schema,
    handler: async (
      request: FastifyRequest<{ Body: z.infer<typeof createConversationBodySchema> }>,
      reply: FastifyReply,
    ) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const db = request.server.db;
      const result = await openConversation(db, {
        unitId,
        instanceName: ports.instanceName(),
        phone: request.body.phone,
      });
      if (result.status === "channel_down") {
        return reply.code(409).send({ code: "channel_not_connected" });
      }
      const chips = await openTagsByConversation(db, unitId, [result.conversation.id]);
      const conversation = { ...result.conversation, tags: chips.get(result.conversation.id) ?? [] };
      return reply.code(result.status === "created" ? 201 : 200).send(conversation);
    },
  };
}
