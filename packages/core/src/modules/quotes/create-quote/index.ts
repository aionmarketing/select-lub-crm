/**
 * `POST /vehicles/:id/quotes` — persist the quote the attendant is sending, with its lines
 * frozen at the prices offered.
 *
 * The logic is {@link createQuote}, a plain function a test calls directly; {@link route}
 * is the thin HTTP wrapper. It calls no provider, so the whole request is one
 * `db.tx("quotes", …)`: the vehicle read, the catalog read and the insert commit together.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CatalogItem, CreateOilQuoteBody, OilQuote } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { createOilQuoteBodySchema, oilQuoteSchema } from "../contracts/http.js";
import { notFoundBody, vehicleIdParams } from "../contracts/routes.js";
import { createPrismaOilQuoteStore } from "../internal/store/prisma.js";
import type { CatalogRow } from "../internal/store/store.js";
import { findVehicleInUnit } from "../internal/store/vehicle-in-unit.js";

/** One line as the quote stores it: the catalog item's labels and the price it is frozen at. */
export type QuoteLine = Pick<CatalogItem, "brand" | "description"> & {
  catalogItemId: string;
  price: number;
};

/**
 * Freezes each requested line at the price the quote will carry.
 *
 * A line is a filter line exactly when its catalog item carries a filter detail (design
 * D10). A filter is frozen at the catalog's current price whatever the body asked for,
 * because the attendant never edits a filter price; an oil line keeps the price it was
 * offered at, which is a composite the attendant saw on the card.
 *
 * @param catalog - The catalog as it is now.
 * @param lines - The lines the body sent.
 * @returns The frozen lines, or `null` when any line names an item the catalog does not have.
 */
export function freezeLines(
  catalog: readonly CatalogRow[],
  lines: CreateOilQuoteBody["lines"],
): QuoteLine[] | null {
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const frozen: QuoteLine[] = [];
  for (const line of lines) {
    const item = byId.get(line.catalogItemId);
    if (!item) {
      return null;
    }
    frozen.push({
      catalogItemId: item.id,
      brand: item.brand,
      description: item.description,
      price: item.filter ? item.price : line.price,
    });
  }
  return frozen;
}

/** What {@link createQuote} did. */
export type CreateQuoteResult =
  | { status: "created"; quote: OilQuote }
  | { status: "not_found" }
  | { status: "unknown_catalog_item" };

/**
 * Persists a quote for one vehicle, as the caller's unit sees it.
 *
 * @param db - The database handle; the whole request runs under the `quotes` role.
 * @param input.vehicleId - The vehicle from the path.
 * @param input.unitId - The unit the request is scoped to.
 * @param input.userId - The attendant, recorded as the quote's author.
 * @param input.body - The validated request body.
 * @returns `created` with the stored quote; `not_found` when the vehicle does not exist or
 *   its owner is in another unit (answered alike); `unknown_catalog_item` when a line names
 *   an item the catalog lacks — in which case nothing is written.
 */
export async function createQuote(
  db: Db,
  input: { vehicleId: string; unitId: string; userId: string; body: CreateOilQuoteBody },
): Promise<CreateQuoteResult> {
  return db.tx("quotes", async (tx) => {
    const found = await findVehicleInUnit(tx, input.vehicleId, input.unitId);
    if (!found) {
      return { status: "not_found" };
    }
    const store = createPrismaOilQuoteStore(tx);
    const lines = freezeLines(await store.listCatalog(), input.body.lines);
    if (!lines) {
      return { status: "unknown_catalog_item" };
    }
    const quote = await store.createQuote({
      customerId: found.customerId,
      vehicleId: found.vehicle.id,
      conversationId: input.body.conversationId ?? null,
      generatedMessageText: input.body.generatedMessageText,
      createdByUserId: input.userId,
      lines,
    });
    return { status: "created", quote };
  });
}

const schema = {
  params: vehicleIdParams,
  body: createOilQuoteBodySchema,
  response: { 201: oilQuoteSchema, 400: notFoundBody, 404: notFoundBody },
};

/**
 * The route. It takes no ports: a quote is written from the catalog and the body alone.
 *
 * @returns The slice's route definition.
 */
export function route(): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/vehicles/:id/quotes",
    schema,
    handler: async (
      request: FastifyRequest<{ Params: { id: string }; Body: CreateOilQuoteBody }>,
      reply: FastifyReply,
    ) => {
      const unitId = unitIdOf(request);
      const userId = request.crmUserId;
      if (!unitId || !userId) {
        return reply.code(404).send({});
      }
      const result = await createQuote(request.server.db, {
        vehicleId: request.params.id,
        unitId,
        userId,
        body: request.body,
      });
      if (result.status === "not_found") {
        return reply.code(404).send({});
      }
      if (result.status === "unknown_catalog_item") {
        return reply.code(400).send({});
      }
      return reply.code(201).send(result.quote);
    },
  };
}
