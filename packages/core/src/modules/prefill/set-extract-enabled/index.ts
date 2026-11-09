/**
 * `PATCH /conversations/:id/prefill/extract-enabled` — the rail's Sugerir dados
 * do cliente switch.
 *
 * Moved from `apps/api/src/prefill/routes.ts` and `prisma.ts`
 * (`setExtractEnabled`). The switch is a column on `conversation`, so it is
 * written by `conversations`' `setExtractEnabled` contract, which — turning it
 * ON — also stamps `last_prefill_window_closed_at` to now, so the silence that
 * passed while it was off is never extracted. Prefill writes nothing here; it
 * answers its own view.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { setExtractEnabled } from "../../conversations/contracts/set-extract-enabled.js";
import { prefillExtractEnabledBodySchema, prefillSuggestionSchema } from "../contracts/http.js";
import { conversationParams, emptyBody } from "../internal/params.js";
import { getView } from "../internal/suggestion.js";

/** Request and response schemas. */
export const schema = {
  params: conversationParams,
  body: prefillExtractEnabledBodySchema,
  response: { 200: prefillSuggestionSchema, 404: emptyBody },
};

/**
 * The handler: 200 with the view carrying the new switch, or 404.
 *
 * @param request - Parsed params and body; the hook has set the caller's unit.
 * @param reply - Used for the 404.
 */
export async function handler(
  request: FastifyRequest<{
    Params: z.infer<typeof conversationParams>;
    Body: z.infer<typeof prefillExtractEnabledBodySchema>;
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
  const updated = await setExtractEnabled(db, {
    conversationId: link.id,
    unitId,
    enabled: request.body.extractEnabled,
  });
  if (updated.status === "not_found") {
    return reply.code(404).send({});
  }
  return db.tx("prefill", (tx) => getView(tx, link.id));
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "PATCH",
  path: "/conversations/:id/prefill/extract-enabled",
  schema,
  handler,
};
