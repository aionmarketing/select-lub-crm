/**
 * `GET /vehicles/:id/services` — one vehicle's service orders, newest first.
 *
 * Moved from `apps/api/src/services/routes.ts` and `services/prisma.ts`
 * (`listByVehicle`). The vehicle's loja is its customer's: a vehicle whose
 * customer is in another loja, in none, or unknown is a 404. Only this
 * vehicle's services, never a sibling car of the same customer.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { serviceListSchema, type Service } from "../contracts/http.js";
import { idParams, notFoundBody } from "../internal/params.js";
import { sortServices, toServiceDto } from "../internal/service-dto.js";
import { customerUnitId } from "../internal/service-reads.js";

/** Request and response schemas. */
export const schema = {
  params: idParams,
  response: { 200: serviceListSchema, 404: notFoundBody },
};

/**
 * Lists a vehicle's services, if its customer is in the unit.
 *
 * Three reads, each in its own `db.tx`, as the route's three store calls were:
 * the vehicle, its customer's loja, then its services. `vehicle` and `customer`
 * are `customers`' tables, read as foreign reads.
 *
 * @param db - The database handle.
 * @param unitId - The caller's loja.
 * @param vehicleId - The vehicle.
 * @returns The services, newest first, or `null` when the vehicle is unknown or
 *   its customer is not in the loja.
 */
export async function listVehicleServices(
  db: Db,
  unitId: string,
  vehicleId: string,
): Promise<Service[] | null> {
  const vehicle = await db.tx("services", (tx) =>
    tx.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, customerId: true } }),
  );
  if (!vehicle) {
    return null;
  }
  const customerUnit = await db.tx("services", (tx) => customerUnitId(tx, vehicle.customerId));
  if (customerUnit === undefined || customerUnit !== unitId) {
    return null;
  }
  const rows = await db.tx("services", (tx) =>
    tx.service.findMany({ where: { vehicleId: vehicle.id }, include: { items: true } }),
  );
  return sortServices(rows.map(toServiceDto));
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
  const listed = await listVehicleServices(request.server.db, unitId, request.params.id);
  if (!listed) {
    return reply.code(404).send({});
  }
  return listed;
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/vehicles/:id/services",
  schema,
  handler,
};
