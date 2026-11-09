/**
 * `POST /tags` — a new tag definition in the loja.
 *
 * Moved from `apps/api/src/tags/routes.ts` (4A); the path and every status code
 * are unchanged, and the query runs in `db.tx("conversations", …)`
 * (`internal/tag-store.ts`).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { tagCreateBodySchema, tagSchema } from "../contracts/http.js";
import { emptyBody } from "../internal/params.js";
import { createTag } from "../internal/tag-store.js";

/** Request and response schemas. */
export const schema = { body: tagCreateBodySchema, response: { 201: tagSchema, 404: emptyBody, 409: emptyBody } };

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "POST",
  path: "/tags",
  schema,
  handler: async (request: FastifyRequest<{ Body: z.infer<typeof tagCreateBodySchema> }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const result = await createTag(request.server.db, unitId, request.body);
      if (result.status === "not_found") {
        return reply.code(404).send({});
      }
      if (result.status === "conflict") {
        return reply.code(409).send({});
      }
      return reply.code(201).send(result.tag);
    },
};
