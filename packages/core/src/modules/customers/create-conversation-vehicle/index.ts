/**
 * `create-conversation-vehicle` — POST `/conversations/:id/vehicles`. Creates a vehicle for a conversation's customer.
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
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { vehicleCreateBodySchema, vehicleSchema } from "../contracts/http.js";
import { conversationIdParams, notFoundBody } from "../contracts/routes.js";
import { vehicleFromCreate } from "../internal/new-vehicle.js";
import { applyVehicleOriginWrites, vehicleDtoWithOrigins, vehicleFieldPatch } from "../internal/plate-origin.js";
import { createPlateOriginStore } from "../contracts/cadastro-store/plate-origin.js";
import { announceVehicleChange } from "../internal/announce.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: conversationIdParams,
  body: vehicleCreateBodySchema,
  response: { 201: vehicleSchema, 404: notFoundBody, 409: notFoundBody },
};

/**
 * Handles the request.
 *
 * @param request - The parsed request.
 * @param reply - The reply.
 * @returns The response body.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof conversationIdParams>; Body: z.infer<typeof vehicleCreateBodySchema> }>,
  reply: FastifyReply,
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const originStore = createPlateOriginStore(db);
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
  if (!customer) {
    customer = await cadastroStore.findCustomerByPhone(unitId, link.phone);
  }
  if (!customer) {
    return reply.code(409).send({});
  }
  const created = vehicleFromCreate(customer.id, vehicleFieldPatch(request.body));
  await cadastroStore.createVehicle(created);
  await applyVehicleOriginWrites(
    originStore,
    created.id,
    request.body,
    request.crmUserId ?? null,
  );
  const saved = await cadastroStore.getVehicle(created.id);
  if (!saved) {
    return reply.code(404).send({});
  }
  await announceVehicleChange({
    vehicleId: saved.id,
    customerId: saved.customerId,
    unitId,
    fields: Object.keys(vehicleFieldPatch(request.body)),
    actorId: request.crmUserId ?? null,
    created: true,
  });
  return reply.code(201).send(await vehicleDtoWithOrigins(saved, originStore));
}

export const route: SliceRoute<typeof schema> = {
  method: "POST",
  path: "/conversations/:id/vehicles",
  schema,
  handler,
};
