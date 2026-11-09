/**
 * `GET /tags` — the loja's tag definitions, for the admin screen, sorted by `sortOrder` then name.
 *
 * Moved from `apps/api/src/tags/routes.ts` (4A); the path and every status code
 * are unchanged, and the query runs in `db.tx("conversations", …)`
 * (`internal/tag-store.ts`).
 */
import type { FastifyRequest } from "fastify";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { tagListSchema } from "../internal/params.js";
import { listTags } from "../internal/tag-store.js";

/** Request and response schemas. */
export const schema = { response: { 200: tagListSchema } };

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/tags",
  schema,
  handler: async (request: FastifyRequest) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return [];
      }
      return listTags(request.server.db, unitId);
    },
};
