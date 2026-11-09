/**
 * `DELETE /conversations/:id/tags/:tagId` — takes a tag off a conversation.
 *
 * Moved from `apps/api/src/tags/routes.ts` (4A); the path and every status code
 * are unchanged, and the query runs in `db.tx("conversations", …)`
 * (`internal/tag-store.ts`).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../contracts/get-cadastro-link.js";
import { conversationTagParams, emptyBody } from "../internal/params.js";
import { removeTag } from "../internal/tag-store.js";

/** Request and response schemas. */
export const schema = { params: conversationTagParams, response: { 200: emptyBody, 404: emptyBody } };

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "DELETE",
  path: "/conversations/:id/tags/:tagId",
  schema,
  handler: async (request: FastifyRequest<{ Params: z.infer<typeof conversationTagParams> }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const link = await getCadastroLink(request.server.db, { conversationId: request.params.id, unitId });
      if (!link) {
        return reply.code(404).send({});
      }
      const result = await removeTag(request.server.db, unitId, request.params.id, request.params.tagId);
      if (result === "not_found") {
        return reply.code(404).send({});
      }
      return reply.code(200).send({});
    },
};
