/**
 * `POST /conversations/:id/prefill/accept` — accept one suggested field: write it
 * to the thread's customer (creating a WhatsApp cadastro and linking it when
 * there is none) and drop it from the suggestion.
 *
 * Moved from `apps/api/src/prefill/routes.ts`. The customer is resolved and
 * created through `customers`' contracts, the thread linked through
 * `conversations`' `setCustomer`, and the field written by `customers`'
 * `applyPrefillSuggestion`, which pushes to Omie synchronously — so nothing here
 * holds a transaction open across it. Prefill writes only its suggestion.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { prefillAcceptBodySchema, prefillSuggestionSchema, type PrefillFieldKey } from "../contracts/http.js";
import { resolveOrCreatePrefillCustomer } from "../internal/accept.js";
import { acceptField } from "../internal/accept-field.js";
import { conversationParams, emptyBody } from "../internal/params.js";
import type { PrefillPorts } from "../internal/ports.js";
import { getFields, getView } from "../internal/suggestion.js";
import { suggestionHasField } from "../internal/view.js";

/** Request and response schemas. 409 when the field is not pending, or the customer is not linked. */
export const schema = {
  params: conversationParams,
  body: prefillAcceptBodySchema,
  response: { 200: prefillSuggestionSchema, 404: emptyBody, 409: emptyBody },
};

/**
 * Builds the handler over the Omie adapter.
 *
 * @param ports - See {@link PrefillPorts}.
 * @returns 200 with the view after the field is accepted; 404; 409.
 */
export function createHandler(ports: PrefillPorts) {
  return async (
    request: FastifyRequest<{
      Params: z.infer<typeof conversationParams>;
      Body: z.infer<typeof prefillAcceptBodySchema>;
    }>,
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
    const field = request.body.field as PrefillFieldKey;
    const fields = await db.tx("prefill", (tx) => getFields(tx, link.id));
    if (!suggestionHasField(fields, field)) {
      return reply.code(409).send({});
    }
    const customer = await resolveOrCreatePrefillCustomer(db, unitId, link);
    const outcome = await acceptField(db, ports.omieAdapter, {
      conversationId: link.id,
      customerId: customer.id,
      unitId,
      field,
      value: request.body.value,
      ...(request.crmUserId ? { actorId: request.crmUserId } : {}),
    });
    if (outcome === "not_found") {
      return reply.code(404).send({});
    }
    if (outcome === "not_linked") {
      return reply.code(409).send({});
    }
    return db.tx("prefill", (tx) => getView(tx, link.id));
  };
}

/**
 * The slice's route over the given ports; the path is unchanged from `apps/api`.
 *
 * @param ports - See {@link PrefillPorts}.
 */
export function createRoute(ports: PrefillPorts): SliceRoute<typeof schema> {
  return { method: "POST", path: "/conversations/:id/prefill/accept", schema, handler: createHandler(ports) };
}
