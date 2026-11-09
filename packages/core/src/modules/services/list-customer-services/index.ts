/**
 * `GET /customers/:id/services` — a customer's service orders, newest first,
 * for the cadastro rail.
 *
 * Moved from `apps/api/src/services/routes.ts`. Read-only: service rows are
 * written by the ERP import, never by a route. A customer in another loja, in no
 * loja, or unknown is a 404, the same answer for all three.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { serviceListSchema, type Service } from "../contracts/http.js";
import { idParams, notFoundBody } from "../internal/params.js";
import { customerUnitId, servicesOfCustomer } from "../internal/service-reads.js";

/** Request and response schemas. */
export const schema = {
  params: idParams,
  response: { 200: serviceListSchema, 404: notFoundBody },
};

/**
 * Lists a customer's services, if the customer is in the unit.
 *
 * Two reads, each in its own `db.tx`, as the route's two store calls were: the
 * customer's loja, then its services.
 *
 * @param db - The database handle.
 * @param unitId - The caller's loja.
 * @param customerId - The customer.
 * @returns The services, newest first, or `null` when the customer is unknown
 *   or not in the loja.
 */
export async function listCustomerServices(
  db: Db,
  unitId: string,
  customerId: string,
): Promise<Service[] | null> {
  const customerUnit = await db.tx("services", (tx) => customerUnitId(tx, customerId));
  if (customerUnit === undefined || customerUnit !== unitId) {
    return null;
  }
  return db.tx("services", (tx) => servicesOfCustomer(tx, customerId));
}

/**
 * The handler: 200 with the list, or 404.
 *
 * @param request - Parsed params; the hook has set the caller's unit.
 * @param reply - Used for the 404.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof idParams> }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const listed = await listCustomerServices(request.server.db, unitId, request.params.id);
  if (!listed) {
    return reply.code(404).send({});
  }
  return listed;
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/customers/:id/services",
  schema,
  handler,
};
