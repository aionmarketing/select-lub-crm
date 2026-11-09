/**
 * `POST /conversations/:id/prefill/accept-all` — accept every pending field, in
 * the closed v1 order, as if Aceitar were clicked top to bottom.
 *
 * Moved from `apps/api/src/prefill/routes.ts`. Each field goes through the same
 * step as `accept-prefill-field` (`internal/accept-field.ts`): `customers`'
 * `applyPrefillSuggestion` — an Omie push, outside any transaction of prefill's —
 * then the field is stripped. The first refusal stops the walk, leaving the
 * fields after it pending, as before.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { prefillSuggestionSchema } from "../contracts/http.js";
import { pendingPrefillEntries, resolveOrCreatePrefillCustomer } from "../internal/accept.js";
import { acceptField } from "../internal/accept-field.js";
import { conversationParams, emptyBody } from "../internal/params.js";
import type { PrefillPorts } from "../internal/ports.js";
import { getFields, getView } from "../internal/suggestion.js";

/** Request and response schemas. */
export const schema = {
  params: conversationParams,
  response: { 200: prefillSuggestionSchema, 404: emptyBody, 409: emptyBody },
};

/**
 * Builds the handler over the Omie adapter.
 *
 * @param ports - See {@link PrefillPorts}.
 * @returns 200 with the view; 404; 409 when the customer is not linked.
 */
export function createHandler(ports: PrefillPorts) {
  return async (request: FastifyRequest<{ Params: z.infer<typeof conversationParams> }>, reply: FastifyReply) => {
    const unitId = unitIdOf(request);
    if (!unitId) {
      return reply.code(404).send({});
    }
    const db = request.server.db;
    const link = await getCadastroLink(db, { conversationId: request.params.id, unitId });
    if (!link) {
      return reply.code(404).send({});
    }
    const pending = pendingPrefillEntries(await db.tx("prefill", (tx) => getFields(tx, link.id)));
    if (pending.length === 0) {
      return db.tx("prefill", (tx) => getView(tx, link.id));
    }
    const customer = await resolveOrCreatePrefillCustomer(db, unitId, link);
    for (const row of pending) {
      const outcome = await acceptField(db, ports.omieAdapter, {
        conversationId: link.id,
        customerId: customer.id,
        unitId,
        field: row.field,
        value: row.value,
        ...(request.crmUserId ? { actorId: request.crmUserId } : {}),
      });
      if (outcome === "not_found") {
        return reply.code(404).send({});
      }
      if (outcome === "not_linked") {
        return reply.code(409).send({});
      }
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
  return { method: "POST", path: "/conversations/:id/prefill/accept-all", schema, handler: createHandler(ports) };
}
