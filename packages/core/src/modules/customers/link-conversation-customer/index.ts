/**
 * `link-conversation-customer` — POST `/conversations/:id/customer`. The rail's first save: finds or creates the customer for a conversation, links the conversation to it, and applies the edit.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { applyCrmEdit } from "../contracts/cadastro-engine/index.js";
import { customerToDto } from "../contracts/cadastro-dto.js";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { setCustomer } from "../../conversations/contracts/set-customer.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { customerFieldEditSchema, customerSchema } from "../contracts/http.js";
import { conversationIdParams, notFoundBody } from "../contracts/routes.js";
import { announceCustomerChange } from "../internal/announce.js";
import type { CustomerPorts } from "../internal/ports.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: conversationIdParams,
  body: customerFieldEditSchema,
  response: {
    201: customerSchema,
    404: notFoundBody,
    409: notFoundBody,
    503: customerSchema,
  },
};

/**
 * Handles the request.
 *
 * @param request - The parsed request.
 * @param reply - The reply.
 * @param omieAdapter - The Omie adapter `createHttpPlugin` was given.
 * @returns The response body.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof conversationIdParams>; Body: z.infer<typeof customerFieldEditSchema> }>,
  reply: FastifyReply,
  omieAdapter: CustomerPorts["omieAdapter"],
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const link = await getCadastroLink(db, { conversationId: request.params.id, unitId });
  if (!link) {
    return reply.code(404).send({});
  }
  let customer = null;
  if (link.customerId) {
    const byId = await cadastroStore.getCustomer(link.customerId);
    if (byId && byId.unitId === unitId) {
      customer = byId;
    }
  }
  if (customer) {
    return reply.code(409).send({});
  }
  customer = await cadastroStore.findCustomerByPhone(unitId, link.phone);
  if (!customer) {
    const created = await cadastroStore.createWhatsappCadastro({
      unitId,
      phoneNormalized: link.phone,
      phoneRaw: link.phone,
    });
    customer = created.customer;
  }
  await setCustomer(db, { conversationId: link.id, unitId, customerId: customer.id });
  const result = await applyCrmEdit(cadastroStore, omieAdapter, {
    customerId: customer.id,
    unitId,
    patch: request.body,
    actorId: request.crmUserId ?? undefined,
  });
  if (result.status === "not_found" || result.status === "unit_mismatch") {
    return reply.code(404).send({});
  }
  if (result.status === "not_linked") {
    return reply.code(409).send({});
  }
  await announceCustomerChange({
    customerId: result.customer.id,
    unitId,
    fields: Object.keys(request.body),
    actorId: request.crmUserId ?? null,
    source: "edit",
  });
  if (result.status === "omie_unavailable") {
    return reply.code(503).send(customerToDto(result.customer));
  }
  return reply.code(201).send(customerToDto(result.customer));
}

/**
 * The route, over the module's ports.
 *
 * @param ports - The Omie adapter, from `createHttpPlugin`'s closure.
 * @returns The route to register.
 */
export function route(ports: CustomerPorts): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/conversations/:id/customer",
    schema,
    handler: (request: Parameters<typeof handler>[0], reply: FastifyReply) =>
      handler(request, reply, ports.omieAdapter),
  };
}
