/**
 * `list-customer-vehicles` — GET `/customers/:id/vehicles`. Lists a customer's vehicles, each with its plate-sourced keys.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { vehicleListSchema } from "../contracts/http.js";
import { customerIdParams, notFoundBody } from "../contracts/routes.js";
import { vehicleDtoWithOrigins } from "../internal/plate-origin.js";
import { createPlateOriginStore } from "../contracts/cadastro-store/plate-origin.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: customerIdParams,
  response: { 200: vehicleListSchema, 404: notFoundBody },
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
  const originStore = createPlateOriginStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const customer = await cadastroStore.getCustomer(request.params.id);
  if (!customer || customer.unitId !== unitId) {
    return reply.code(404).send({});
  }
  const rows = await cadastroStore.listVehicles(customer.id);
  return Promise.all(rows.map((row) => vehicleDtoWithOrigins(row, originStore)));
}

export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/customers/:id/vehicles",
  schema,
  handler,
};
