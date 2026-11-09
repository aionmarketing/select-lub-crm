/**
 * `POST /conversations/:id/prefill/reject` — drop one suggested field without
 * writing it anywhere.
 *
 * Moved from `apps/api/src/prefill/routes.ts`. Rejecting a field that is not
 * pending is a no-op answering the current view, not an error. Writes only
 * prefill's suggestion.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { prefillRejectBodySchema, prefillSuggestionSchema } from "../contracts/http.js";
import { conversationParams, emptyBody } from "../internal/params.js";
import { getFields, getView, stripField } from "../internal/suggestion.js";
import { suggestionHasField } from "../internal/view.js";

/** Request and response schemas. */
export const schema = {
  params: conversationParams,
  body: prefillRejectBodySchema,
  response: { 200: prefillSuggestionSchema, 404: emptyBody },
};

/**
 * The handler: 200 with the view, or 404. The read, the strip and the view are
 * one `db.tx("prefill", …)`.
 *
 * @param request - Parsed params and body; the hook has set the caller's unit.
 * @param reply - Used for the 404.
 */
export async function handler(
  request: FastifyRequest<{
    Params: z.infer<typeof conversationParams>;
    Body: z.infer<typeof prefillRejectBodySchema>;
  }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const db = request.server.db;
  const link = await getCadastroLink(db, { conversationId: request.params.id, unitId });
  if (!link) {
    return reply.code(404).send({});
  }
  const field = request.body.field;
  return db.tx("prefill", async (tx) => {
    if (suggestionHasField(await getFields(tx, link.id), field)) {
      await stripField(tx, link.id, field);
    }
    return getView(tx, link.id);
  });
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "POST",
  path: "/conversations/:id/prefill/reject",
  schema,
  handler,
};
