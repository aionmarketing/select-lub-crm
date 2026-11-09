/**
 * `GET /services/:id` — one service in full for the Serviços detail region: its
 * items, its customer and vehicle labels, the quote Relatórios attributed it to,
 * and the vehicle's other services.
 *
 * Moved from `apps/api/src/services/routes.ts`. A service in another loja is a
 * 404, the same as an unknown one.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { serviceDetailSchema } from "../contracts/http.js";
import { idParams, notFoundBody } from "../internal/params.js";
import { queryServiceDetail, type UnitServiceDetailRow } from "./queries.js";

/** Request and response schemas. */
export const schema = {
  params: idParams,
  response: { 200: serviceDetailSchema, 404: notFoundBody },
};

/**
 * Reads one service in full, if it is in the unit.
 *
 * One `db.tx`, as the old store call was one operation: the service, then its
 * vehicle's history.
 *
 * @param db - The database handle.
 * @param unitId - The caller's loja.
 * @param serviceId - The service.
 * @returns The detail, or `null` when the service is unknown or in another loja.
 */
export async function getService(
  db: Db,
  unitId: string,
  serviceId: string,
): Promise<UnitServiceDetailRow | null> {
  const detail = await db.tx("services", (tx) => queryServiceDetail(tx, serviceId));
  if (!detail || detail.row.unitId !== unitId) {
    return null;
  }
  return detail;
}

/**
 * The handler: 200 with the detail, or 404.
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
  const detail = await getService(request.server.db, unitId, request.params.id);
  if (!detail) {
    return reply.code(404).send({});
  }
  return {
    ...detail.row,
    attributedQuote: detail.attributedQuote,
    vehicleHistory: detail.vehicleHistory,
  };
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/services/:id",
  schema,
  handler,
};
