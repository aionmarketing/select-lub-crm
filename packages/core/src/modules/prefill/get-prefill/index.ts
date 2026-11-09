/**
 * `GET /conversations/:id/prefill` — the rail's view of the assistive cadastro
 * suggestion: extracting, the pending fields, failed, or empty, with the
 * extraction switch.
 *
 * Moved from `apps/api/src/prefill/routes.ts` and `prisma.ts` (`getView`). The
 * conversation is scoped to the caller's loja through `conversations`'
 * `getCadastroLink`; another loja's is a 404, as an unknown one.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { prefillSuggestionSchema } from "../contracts/http.js";
import { conversationParams, emptyBody } from "../internal/params.js";
import { getView } from "../internal/suggestion.js";

/** Request and response schemas. */
export const schema = {
  params: conversationParams,
  response: { 200: prefillSuggestionSchema, 404: emptyBody },
};

/**
 * The handler: 200 with the view, or 404.
 *
 * @param request - Parsed params; the hook has set the caller's unit.
 * @param reply - Used for the 404.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof conversationParams> }>,
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
  return db.tx("prefill", (tx) => getView(tx, link.id));
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/conversations/:id/prefill",
  schema,
  handler,
};
