/**
 * `PATCH /templates/:id` — edits or (de)activates a reply template.
 *
 * Moved from `apps/api/src/tags/routes.ts` (4A); the path and every status code
 * are unchanged, and the query runs in `db.tx("conversations", …)`
 * (`internal/tag-store.ts`).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { templatePatchBodySchema, templateSchema } from "../contracts/http.js";
import { emptyBody, tagIdParams } from "../internal/params.js";
import { patchTemplate } from "../internal/tag-store.js";

/** Request and response schemas. */
export const schema = { params: tagIdParams, body: templatePatchBodySchema, response: { 200: templateSchema, 404: emptyBody, 409: emptyBody } };

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "PATCH",
  path: "/templates/:id",
  schema,
  handler: async (request: FastifyRequest<{ Params: z.infer<typeof tagIdParams>; Body: z.infer<typeof templatePatchBodySchema> }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const result = await patchTemplate(request.server.db, unitId, request.params.id, request.body);
      if (result.status === "not_found") {
        return reply.code(404).send({});
      }
      if (result.status === "conflict") {
        return reply.code(409).send({});
      }
      return result.template;
    },
};
