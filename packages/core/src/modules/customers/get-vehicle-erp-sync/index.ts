/**
 * `get-vehicle-erp-sync` — GET `/vehicles/:id/omie-sync`. Reports where a vehicle stands with Omie: never synced, synced, failed, or in conflict.
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
import { vehicleOmieSyncSchema } from "../contracts/http.js";
import { notFoundBody, vehicleIdParams } from "../contracts/routes.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: vehicleIdParams,
  response: { 200: vehicleOmieSyncSchema, 404: notFoundBody },
};

/**
 * Handles the request.
 *
 * @param request - The parsed request.
 * @param reply - The reply.
 * @returns The response body.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof vehicleIdParams> }>,
  reply: FastifyReply,
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  // A vehicle has no unit of its own; it inherits the titular customer's,
  // the same rule `applyVehicleFieldEdit` enforces for writes.
  const vehicle = await cadastroStore.getVehicle(request.params.id);
  if (!vehicle) {
    return reply.code(404).send({});
  }
  const owner = await cadastroStore.getCustomer(vehicle.customerId);
  if (!owner || owner.unitId !== unitId) {
    // 404 rather than 403: the response must not confirm that a vehicle
    // outside the caller's unit exists.
    return reply.code(404).send({});
  }
  const sync = await cadastroStore.getVehicleOmieSync(vehicle.id);
  if (!sync) {
    return reply.code(404).send({});
  }
  return sync;
}

export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/vehicles/:id/omie-sync",
  schema,
  handler,
};
