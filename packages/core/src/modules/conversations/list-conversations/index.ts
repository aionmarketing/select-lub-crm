/**
 * `GET /conversations` — the inbox list, with its filters and each row's tag
 * chips.
 *
 * Moved from `apps/api/src/conversations/routes.ts` (4A); the path, the query
 * schema and every answer are unchanged.
 */
import { conversationListOrigin, conversationListPeriod, conversationListQuerySchema, conversationListStage, conversationListTagIds, conversationListUnanswered, conversationSummaryListSchema } from "../contracts/http.js";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { emptyBody } from "../internal/params.js";
import { conversationIdsWithAllTags, openTagsByConversation } from "../internal/tag-store.js";
import { listConversations } from "./queries.js";

export { listConversations } from "./queries.js";

/** Request and response schemas. */
export const schema = {
  querystring: conversationListQuerySchema,
  response: { 200: conversationSummaryListSchema, 401: emptyBody, 403: emptyBody },
};

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/conversations",
  schema,
  handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof conversationListQuerySchema> }>) => {
    const unitId = unitIdOf(request);
    if (!unitId) {
      return [];
    }
    const db = request.server.db;
    const origin = conversationListOrigin(request.query.origin);
    const stage = conversationListStage(request.query.stage);
    // A filter value that names nothing yields an EMPTY cut, never the unfiltered
    // list: a Relatórios link carrying a renamed stage must show an empty inbox
    // the screen can explain, not silently widen to everything and look like the
    // link worked.
    if (origin === "unknown" || stage === "unknown") {
      return [];
    }
    const { start, end } = conversationListPeriod(request.query.from, request.query.to);
    const tagIds = conversationListTagIds(request.query);
    let rows = await listConversations(db, unitId, {
      q: request.query.q,
      unanswered: conversationListUnanswered(request.query),
      origin,
      stage,
      periodStart: start,
      periodEnd: end,
    });
    if (tagIds.length) {
      const matching = new Set(await conversationIdsWithAllTags(db, unitId, tagIds));
      rows = rows.filter((row) => matching.has(row.id));
    }
    const chips = await openTagsByConversation(
      db,
      unitId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({ ...row, tags: chips.get(row.id) ?? [] }));
  },
};
