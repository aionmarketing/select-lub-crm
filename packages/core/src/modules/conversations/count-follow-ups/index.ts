/**
 * `GET /follow-up-counts` — the four Follow-up counts without the rows, for the
 * navigation badge and the Relatórios alert strip.
 *
 * Moved from `apps/api/src/follow-up/routes.ts` (4A); the path and every answer
 * are unchanged. Same aggregation as the lists, so the badge cannot claim a
 * number the screen does not show.
 */
import { followUpOptionalCountsSchema } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { followUpCounts } from "../internal/follow-up-snapshot.js";
import { emptyBody } from "../internal/params.js";

/** Request and response schemas. */
export const schema = {
  response: { 200: followUpOptionalCountsSchema, 401: emptyBody, 403: emptyBody },
};

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/follow-up-counts",
  schema,
  handler: async (request: FastifyRequest, reply: FastifyReply) => {
    const unitId = unitIdOf(request);
    if (!unitId) {
      return reply.code(403).send({});
    }
    return followUpCounts(request.server.db, unitId);
  },
};
