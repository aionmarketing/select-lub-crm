/**
 * `list-customer-pendings` — GET `/customers/:id/reconciliation-pendings`. Lists a customer's open reconciliation pendings.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { pendingToDto } from "../contracts/cadastro-dto.js";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { customerIdParams, notFoundBody, pendingListSchema } from "../contracts/routes.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: customerIdParams,
  response: { 200: pendingListSchema, 404: notFoundBody },
};

/**
 * Handles the request.
 *
 * @param request - The parsed request.
 * @param reply - The reply.
 * @returns The response body.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof customerIdParams> }>,
  reply: FastifyReply,
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const customer = await cadastroStore.getCustomer(request.params.id);
  if (!customer || customer.unitId !== unitId) {
    return reply.code(404).send({});
  }
  const rows = await cadastroStore.listOpenPendings(customer.id);
  return rows.map(pendingToDto);
}

export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/customers/:id/reconciliation-pendings",
  schema,
  handler,
};
