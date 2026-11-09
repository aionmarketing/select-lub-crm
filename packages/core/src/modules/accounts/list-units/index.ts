/**
 * `GET /units` — the named lojas the caller belongs to.
 *
 * The source both for naming the loja a screen is scoped to (Follow-up prints
 * it) and for offering the others as choices (Usuários). Every loja the caller
 * holds, not only the one `X-Unit-Id` names.
 */
import type { FastifyRequest } from "fastify";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitListSchema, type Unit } from "../contracts/http.js";
import { emptyBody } from "../internal/responses.js";

/** Response schemas: the list, or `{}` when the hook refused the caller. */
export const schema = {
  response: { 200: unitListSchema, 401: emptyBody, 403: emptyBody },
};

/**
 * Reads the requested lojas with their names, ordered by name.
 *
 * An id with no `unit` row is dropped rather than returned nameless. Through
 * the route that cannot happen — the ids are memberships, and
 * `user_unit.unit_id` is a foreign key — but the query promises it anyway.
 *
 * @param tx - A client under `module_accounts`.
 * @param visibleUnitIds - The caller's memberships. An empty list matches nothing.
 * @returns One `{ id, name }` per existing loja, ordered by name in the
 *   database's collation.
 */
export async function listUnits(tx: DbClient, visibleUnitIds: readonly string[]): Promise<Unit[]> {
  const rows = await tx.unit.findMany({
    where: { id: { in: [...visibleUnitIds] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/**
 * Lists the caller's lojas.
 *
 * @param request - The request, with the hook's `crmUnitIds` set.
 * @returns The named lojas.
 */
export async function handler(request: FastifyRequest): Promise<Unit[]> {
  const visible = request.crmUnitIds ?? [];
  return request.server.db.tx("accounts", (tx) => listUnits(tx, visible));
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/units",
  schema,
  handler,
};
