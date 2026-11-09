/**
 * `POST /vehicles/:id/oil-research/refetch` — "Buscar novamente" (background-oil-research D16).
 *
 * It enqueues a `refetch` of the vehicle's identity at priority 0 through the one enqueue (D7),
 * then answers with the same body as `GET /vehicles/:id/quote-options`, so the dialog shows the
 * research's progress from this answer with no further read. A refetch searches the web whatever
 * the miss window says; a tier 1–3 local source still spares the search (the runner's gate).
 *
 * Through the one enqueue: a queued research becomes the refetch; a running one that is not a
 * refetch takes it as its pending cycle; a wait whose cycle is not a refetch ends in a queued
 * refetch; a refetch already under way changes nothing. It calls no provider. A POST, because a
 * GET that forces a paid search would be re-sent by a window refocus and by a query retry.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { QuoteOptionsResult } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { quoteOptionsResultSchema } from "../contracts/http.js";
import { notFoundBody, vehicleIdParams } from "../contracts/routes.js";
import { answerQuote } from "../internal/quote-answer/answer.js";
import { findVehicleInUnit } from "../internal/store/vehicle-in-unit.js";

/**
 * Asks for a new research of one vehicle's identity.
 *
 * @param db - The database handle; everything runs under the `quotes` role.
 * @param input.vehicleId - The vehicle from the path.
 * @param input.unitId - The unit the request is scoped to.
 * @param input.now - The server's clock; defaults to now.
 * @returns The quote-options body after the enqueue, or `null` for a vehicle that does not exist
 *   or whose owner is in another unit — answered alike, so neither is confirmed.
 */
export async function refetchOilResearch(
  db: Db,
  input: { vehicleId: string; unitId: string; now?: Date },
): Promise<QuoteOptionsResult | null> {
  const found = await db.tx("quotes", (tx) => findVehicleInUnit(tx, input.vehicleId, input.unitId));
  if (!found) {
    return null;
  }
  return answerQuote(db, found.vehicle, "refetch", input.now);
}

const schema = {
  params: vehicleIdParams,
  response: { 200: quoteOptionsResultSchema, 404: notFoundBody },
};

/**
 * The route.
 *
 * @returns The slice's route definition.
 */
export function route(): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/vehicles/:id/oil-research/refetch",
    schema,
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const result = await refetchOilResearch(request.server.db, { vehicleId: request.params.id, unitId });
      if (!result) {
        return reply.code(404).send({});
      }
      return result;
    },
  };
}
