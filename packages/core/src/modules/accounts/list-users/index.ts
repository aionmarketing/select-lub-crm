/**
 * `GET /users` — the team list the Usuários screen reads.
 *
 * Every CRM user who shares at least one loja with the caller, each with their
 * **whole** membership set. The scope is the caller's memberships, not the one
 * `X-Unit-Id` names: assigning someone to a loja means picking from every loja
 * the operator holds, not only the one currently selected.
 */
import type { FastifyRequest } from "fastify";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { teamUserListSchema, type TeamUser } from "../contracts/http.js";
import { emptyBody } from "../internal/responses.js";

/** Response schemas: the list, or `{}` when the hook refused the caller. */
export const schema = {
  response: { 200: teamUserListSchema, 401: emptyBody, 403: emptyBody },
};

/**
 * Reads the users sharing a loja with `visibleUnitIds`, ordered by name.
 *
 * The `select` names the four columns the DTO carries and nothing else, so no
 * column added to `user` later can travel to the client by accident. The
 * nested `units` select has **no** `where`: a listed user's `unitIds` is every
 * loja they belong to, not only the shared ones. Narrowing it would make the
 * screen read a short list, and the next `PUT /users/:id/units` would delete the
 * memberships it never saw.
 *
 * @param tx - A client under `module_accounts`.
 * @param visibleUnitIds - The caller's memberships. An empty list matches nobody.
 * @returns One row per visible user, ordered by name in the database's collation.
 */
export async function listUsers(tx: DbClient, visibleUnitIds: readonly string[]): Promise<TeamUser[]> {
  const rows = await tx.user.findMany({
    where: { units: { some: { unitId: { in: [...visibleUnitIds] } } } },
    select: { id: true, email: true, name: true, units: { select: { unitId: true } } },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    unitIds: row.units.map((membership) => membership.unitId),
  }));
}

/**
 * Lists the caller's team.
 *
 * The auth hook has already refused an unverified caller (401) and one whose
 * `X-Unit-Id` resolves to nothing (403), so by here the caller has at least one
 * membership.
 *
 * @param request - The request, with the hook's `crmUnitIds` set.
 * @returns The team list.
 */
export async function handler(request: FastifyRequest): Promise<TeamUser[]> {
  const visible = request.crmUnitIds ?? [];
  return request.server.db.tx("accounts", (tx) => listUsers(tx, visible));
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/users",
  schema,
  handler,
};
