/**
 * `resolve-pending` — POST `/customers/:id/reconciliation-pendings/resolve`. Resolves one open pending by keeping the CRM value, the Omie value, or an edited value.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { customerToDto } from "../contracts/cadastro-dto.js";
import { resolvePending } from "../contracts/cadastro-engine/index.js";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { customerSchema, pendingResolveBodySchema } from "../contracts/http.js";
import { customerIdParams, notFoundBody } from "../contracts/routes.js";
import { announceCustomerChange } from "../internal/announce.js";
import type { CustomerPorts } from "../internal/ports.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: customerIdParams,
  body: pendingResolveBodySchema,
  response: {
    200: customerSchema,
    404: notFoundBody,
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
  request: FastifyRequest<{ Params: z.infer<typeof customerIdParams>; Body: z.infer<typeof pendingResolveBodySchema> }>,
  reply: FastifyReply,
  omieAdapter: CustomerPorts["omieAdapter"],
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  if (!request.crmUserId) {
    return reply.code(404).send({});
  }
  try {
    const result = await resolvePending(cadastroStore, omieAdapter, {
      customerId: request.params.id,
      unitId,
      fieldKey: request.body.fieldKey,
      vehicleId: request.body.vehicleId,
      choice: request.body.choice,
      value: request.body.choice === "edit" ? request.body.value : undefined,
      actorId: request.crmUserId,
    });
    if (result.status === "not_found" || result.status === "unit_mismatch") {
      return reply.code(404).send({});
    }
    if (result.status === "not_linked") {
      return reply.code(404).send({});
    }
    await announceCustomerChange({
      customerId: result.customer.id,
      unitId,
      fields: [request.body.fieldKey],
      actorId: request.crmUserId,
      source: "pending-resolve",
    });
    if (result.status === "omie_unavailable") {
      return reply.code(503).send(customerToDto(result.customer));
    }
    return customerToDto(result.customer);
  } catch (error) {
    if (error instanceof Error && error.message === "pending_not_found") {
      return reply.code(404).send({});
    }
    throw error;
  }
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
    path: "/customers/:id/reconciliation-pendings/resolve",
    schema,
    handler: (request: Parameters<typeof handler>[0], reply: FastifyReply) =>
      handler(request, reply, ports.omieAdapter),
  };
}
