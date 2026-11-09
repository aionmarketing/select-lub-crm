/**
 * `GET /vehicles/:id/quote-options` — what the attendant can quote for one car, read from the
 * compatibility caches and the identity's background research state (background-oil-research
 * D15). It calls no provider: research runs in the worker (`run-oil-research`).
 *
 * The logic is {@link getQuoteOptions}, a plain function a test calls directly; {@link route} is
 * the thin HTTP wrapper around it. Its only writes go through the one enqueue (D7): an insert or
 * an adoption, a promotion to the front, a re-enqueue of a resting row D10 allows, and a Tecfil
 * promotion — so a repeat read (the dialog's 3 s poll) writes nothing.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { QuoteOptionsResult } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { quoteOptionsResultSchema } from "../contracts/http.js";
import { notFoundBody, vehicleIdParams } from "../contracts/routes.js";
import { answerQuote } from "../internal/quote-answer/answer.js";
import { findVehicleInUnit } from "../internal/store/vehicle-in-unit.js";

/**
 * The quote options for one vehicle, as the caller's unit sees them.
 *
 * @param db - The database handle; every query runs under the `quotes` role.
 * @param input.vehicleId - The vehicle from the path.
 * @param input.unitId - The unit the request is scoped to.
 * @param input.now - The server's clock; defaults to now.
 * @returns The result, or `null` when the vehicle does not exist or its owner is in
 *   another unit — the two are answered alike, so neither is confirmed.
 */
export async function getQuoteOptions(
  db: Db,
  input: { vehicleId: string; unitId: string; now?: Date },
): Promise<QuoteOptionsResult | null> {
  const found = await db.tx("quotes", (tx) => findVehicleInUnit(tx, input.vehicleId, input.unitId));
  if (!found) {
    return null;
  }
  return answerQuote(db, found.vehicle, "open", input.now);
}

/**
 * The query takes nothing. A stale browser tab's `?mode=…` (the retired reuse prompt) is
 * stripped here and ignored (D15), so it can neither fail the read nor force a search.
 */
export const quoteOptionsQuerySchema = z.object({});

const schema = {
  params: vehicleIdParams,
  querystring: quoteOptionsQuerySchema,
  response: { 200: quoteOptionsResultSchema, 404: notFoundBody },
};

/**
 * The route.
 *
 * @returns The slice's route definition.
 */
export function route(): SliceRoute<typeof schema> {
  return {
    method: "GET",
    path: "/vehicles/:id/quote-options",
    schema,
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const result = await getQuoteOptions(request.server.db, { vehicleId: request.params.id, unitId });
      if (!result) {
        return reply.code(404).send({});
      }
      return result;
    },
  };
}
