/**
 * `get-conversation-customer` — GET `/conversations/:id/customer`. Returns a conversation's customer and open pendings, refreshing a linked customer from Omie first.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { customerToDto, pendingToDto } from "../contracts/cadastro-dto.js";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { conversationCustomerSchema } from "../contracts/http.js";
import { conversationIdParams, notFoundBody } from "../contracts/routes.js";
import { resolveCadastroCustomer } from "../internal/conversation-customer.js";
import { refreshLinkedCustomer } from "../internal/resync-from-erp.js";
import type { CustomerPorts } from "../internal/ports.js";


// The helpers this handler runs, exposed so the slice's tests can call them (a
// slice's tests may not import internal/, ruling 4; 2B did the same).
export { resolveCadastroCustomer } from "../internal/conversation-customer.js";
export { refreshLinkedCustomer } from "../internal/resync-from-erp.js";
/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: conversationIdParams,
  response: { 200: conversationCustomerSchema, 404: notFoundBody },
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
  request: FastifyRequest<{ Params: z.infer<typeof conversationIdParams> }>,
  reply: FastifyReply,
  omieAdapter: CustomerPorts["omieAdapter"],
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const resolved = await resolveCadastroCustomer(db, unitId, request.params.id);
  if (resolved.missing) {
    return reply.code(404).send({});
  }
  if (!resolved.customer) {
    return { customer: null, pendings: [] };
  }
  const customer = await refreshLinkedCustomer(cadastroStore, omieAdapter, resolved.customer);
  if (!customer) {
    return { customer: null, pendings: [] };
  }
  const rows = await cadastroStore.listOpenPendings(customer.id);
  return {
    customer: customerToDto(customer),
    pendings: rows.map(pendingToDto),
  };
}

/**
 * The route, over the module's ports.
 *
 * @param ports - The Omie adapter, from `createHttpPlugin`'s closure.
 * @returns The route to register.
 */
export function route(ports: CustomerPorts): SliceRoute<typeof schema> {
  return {
    method: "GET",
    path: "/conversations/:id/customer",
    schema,
    handler: (request: Parameters<typeof handler>[0], reply: FastifyReply) =>
      handler(request, reply, ports.omieAdapter),
  };
}
