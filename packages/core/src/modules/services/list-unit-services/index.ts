/**
 * `GET /services` — the unit's Serviços ledger: filtered by period, search box
 * and return state, ordered newest first, and paged by cursor.
 *
 * Moved from `apps/api/src/services/routes.ts` and `services/prisma.ts`
 * (`listUnitPage`). Filtering, searching, ordering and paging all happen in one
 * call, so the number of round trips does not grow with the unit's history.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import {
  unitServicePageSchema,
  unitServiceQuerySchema,
  type UnitServicePage,
  type UnitServiceQuery,
} from "../contracts/http.js";
import { notFoundBody } from "../internal/params.js";
import { queryUnitServicePage } from "./queries.js";

/** Request and response schemas. */
export const schema = {
  querystring: unitServiceQuerySchema,
  response: { 200: unitServicePageSchema, 404: notFoundBody },
};

/**
 * Reads one page of the unit's ledger.
 *
 * One `db.tx`, as the old store call was one operation: the ledger query and,
 * only when the return-state filter is asked for, the unit's returns.
 *
 * @param db - The database handle.
 * @param unitId - The caller's loja.
 * @param query - The parsed query.
 * @returns The page, its continuation and the totals over the whole match.
 */
export async function listUnitServices(
  db: Db,
  unitId: string,
  query: UnitServiceQuery,
): Promise<UnitServicePage> {
  return db.tx("services", (tx) => queryUnitServicePage(tx, unitId, query));
}

/**
 * The handler: 200 with the page, or 404 when the hook set no unit.
 *
 * @param request - Parsed query; the hook has set the caller's unit.
 * @param reply - Used for the 404.
 */
export async function handler(
  request: FastifyRequest<{ Querystring: UnitServiceQuery }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  return listUnitServices(request.server.db, unitId, request.query);
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/services",
  schema,
  handler,
};
