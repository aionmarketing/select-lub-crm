/**
 * `POST /conversations/:id/templates/:templateId/preview` — a template rendered
 * with the thread's customer name and titular plate.
 *
 * Moved from `apps/api/src/tags/routes.ts` (4A); the path and every status code
 * are unchanged. The two values come through the `templateValues` port, which
 * the api builds from the cadastro store exactly as the old route read it
 * (customers are 4B's); the template read runs in `db.tx("conversations", …)`.
 */
import { templatePreviewSchema } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../contracts/get-cadastro-link.js";
import { conversationTemplateParams, emptyBody } from "../internal/params.js";
import type { ConversationsPorts } from "../internal/ports.js";
import { previewTemplate } from "../internal/tag-store.js";

/** Request and response schemas. */
export const schema = {
  params: conversationTemplateParams,
  response: { 200: templatePreviewSchema, 404: emptyBody },
};

/**
 * The route, with the template-values port closed over.
 *
 * @param ports - Only `templateValues` is read.
 * @returns The slice's route; the path is unchanged from `apps/api`.
 */
export function createRoute(ports: Pick<ConversationsPorts, "templateValues">): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/conversations/:id/templates/:templateId/preview",
    schema,
    handler: async (
      request: FastifyRequest<{ Params: z.infer<typeof conversationTemplateParams> }>,
      reply: FastifyReply,
    ) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const db = request.server.db;
      const link = await getCadastroLink(db, { conversationId: request.params.id, unitId });
      if (!link) {
        return reply.code(404).send({});
      }
      const values = await ports.templateValues(unitId, link);
      const result = await previewTemplate(db, unitId, request.params.templateId, values);
      if (result.status === "not_found") {
        return reply.code(404).send({});
      }
      return { text: result.text };
    },
  };
}
