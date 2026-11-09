/**
 * `POST /follow-ups/close` — closes one message-pendency entry against the anchor that qualified it. Closing an already-closed entry is a no-op.
 *
 * Moved from `apps/api/src/follow-up/routes.ts` (4A); the path and every answer
 * are unchanged. Two verbs rather than one route with a boolean: what happened
 * belongs in the path, where a log line and the route list both show it. A
 * return does not come through here — it closes through its own archive route.
 */
import { followUpCloseBodySchema } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { findConversationInUnit } from "../internal/conversation-scope.js";
import { closeFollowUpEntry } from "../internal/follow-up-closed.js";
import { emptyBody } from "../internal/params.js";

/** Request and response schemas. */
export const schema = {
  body: followUpCloseBodySchema,
  response: { 200: emptyBody, 401: emptyBody, 403: emptyBody, 404: emptyBody },
};

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "POST",
  path: "/follow-ups/close",
  schema,
  handler: async (
    request: FastifyRequest<{ Body: z.infer<typeof followUpCloseBodySchema> }>,
    reply: FastifyReply,
  ) => {
    const unitId = unitIdOf(request);
    const userId = request.crmUserId;
    if (!unitId || !userId) {
      return reply.code(403).send({});
    }
    const db = request.server.db;
    // Another loja's conversation answers as a missing one, so the response
    // cannot confirm that the row exists.
    if (!(await findConversationInUnit(db, unitId, request.body.conversationId))) {
      return reply.code(404).send({});
    }
    await closeFollowUpEntry(db, { ...request.body, unitId, userId });
    // Empty on purpose: the screen refetches the queue and its counts, and an
    // echoed row would be a second source for what those reads return.
    return reply.code(200).send({});
  },
};
