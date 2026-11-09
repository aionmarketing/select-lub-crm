/**
 * `update-vehicle` — PATCH `/vehicles/:id`. Edits a vehicle's fields; a shared field of a titular vehicle pushes to Omie synchronously.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { applyVehicleFieldEdit } from "../contracts/cadastro-engine/index.js";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { vehicleFieldEditSchema, vehicleSchema } from "../contracts/http.js";
import { notFoundBody, vehicleIdParams } from "../contracts/routes.js";
import { applyVehicleOriginWrites, vehicleDtoWithOrigins, vehicleFieldPatch } from "../internal/plate-origin.js";
import { createPlateOriginStore } from "../contracts/cadastro-store/plate-origin.js";
import { announceVehicleChange } from "../internal/announce.js";
import type { CustomerPorts } from "../internal/ports.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: vehicleIdParams,
  body: vehicleFieldEditSchema,
  response: {
    200: vehicleSchema,
    404: notFoundBody,
    409: notFoundBody,
    503: vehicleSchema,
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
  request: FastifyRequest<{ Params: z.infer<typeof vehicleIdParams>; Body: z.infer<typeof vehicleFieldEditSchema> }>,
  reply: FastifyReply,
  omieAdapter: CustomerPorts["omieAdapter"],
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const originStore = createPlateOriginStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const result = await applyVehicleFieldEdit(cadastroStore, omieAdapter, {
    vehicleId: request.params.id,
    unitId,
    patch: vehicleFieldPatch(request.body),
    actorId: request.crmUserId ?? undefined,
  });
  if (result.status === "not_found" || result.status === "unit_mismatch") {
    return reply.code(404).send({});
  }
  if (result.status === "not_linked") {
    return reply.code(409).send({});
  }
  await applyVehicleOriginWrites(
    originStore,
    request.params.id,
    request.body,
    request.crmUserId ?? null,
  );
  await announceVehicleChange({
    vehicleId: result.vehicle.id,
    customerId: result.vehicle.customerId,
    unitId,
    fields: Object.keys(vehicleFieldPatch(request.body)),
    actorId: request.crmUserId ?? null,
    created: false,
  });
  if (result.status === "omie_unavailable") {
    return reply.code(503).send(await vehicleDtoWithOrigins(result.vehicle, originStore));
  }
  return vehicleDtoWithOrigins(result.vehicle, originStore);
}

/**
 * The route, over the module's ports.
 *
 * @param ports - The Omie adapter, from `createHttpPlugin`'s closure.
 * @returns The route to register.
 */
export function route(ports: CustomerPorts): SliceRoute<typeof schema> {
  return {
    method: "PATCH",
    path: "/vehicles/:id",
    schema,
    handler: (request: Parameters<typeof handler>[0], reply: FastifyReply) =>
      handler(request, reply, ports.omieAdapter),
  };
}
