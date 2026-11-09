/**
 * `GET /follow-ups` — the loja's Follow-up queue: four sections, their lists and
 * counts; with `?closed=1`, the entries closed out of it instead.
 *
 * Moved from `apps/api/src/follow-up/routes.ts` (4A); the path, the query and
 * every answer are unchanged.
 */
import { followUpResultSchema } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { followUpSummary } from "../internal/follow-up-snapshot.js";
import { emptyBody } from "../internal/params.js";

// A flag rather than a second route: closed is the exact complement of open, so
// one handler over one predicate cannot drift into a state that is in neither
// view.
const querystring = z.object({ closed: z.enum(["0", "1"]).optional() });

/** Request and response schemas. */
export const schema = {
  querystring,
  response: { 200: followUpResultSchema, 401: emptyBody, 403: emptyBody },
};

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/follow-ups",
  schema,
  handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof querystring> }>, reply: FastifyReply) => {
    const unitId = unitIdOf(request);
    if (!unitId) {
      return reply.code(403).send({});
    }
    return followUpSummary(request.server.db, unitId, request.query.closed === "1" ? "closed" : "open");
  },
};
