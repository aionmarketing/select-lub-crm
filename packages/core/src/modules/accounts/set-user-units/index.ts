/**
 * `PUT /users/:id/units` — replace a CRM user's loja memberships.
 *
 * The body is the user's complete new set, not a delta: every membership not in
 * it is removed. That is why `GET /users` must return each user's whole set —
 * the screen sends back what it read.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { attachUnitsBodySchema, meSchema, type AttachUnitsBody, type Me } from "../contracts/http.js";
import { distinctUnitIds, findCrmUser, replaceUnitIds } from "../internal/directory.js";
import { emptyBody } from "../internal/responses.js";

/** `:id` — the CRM user's id (the Supabase Auth id). */
const params = z.object({ id: z.string().min(1) });

/** Request and response schemas. 404 when the user has no CRM row. */
export const schema = {
  params,
  body: attachUnitsBodySchema,
  response: { 200: meSchema, 401: emptyBody, 404: emptyBody },
};

/**
 * Replaces `userId`'s memberships with `unitIds`, if the user exists.
 *
 * The lookup and the replacement share one transaction, so a user deleted in
 * between cannot be given memberships. An id in `unitIds` with no `unit` row is
 * refused by the foreign key and the whole replacement rolls back.
 *
 * @param tx - A client under `module_accounts`.
 * @param userId - The user whose lojas change.
 * @param unitIds - The complete new set.
 * @returns The user's profile with the new set, or `null` when there is no such user.
 */
export async function setUserUnits(tx: DbClient, userId: string, unitIds: readonly string[]): Promise<Me | null> {
  const existing = await findCrmUser(tx, userId);
  if (!existing) {
    return null;
  }
  const distinct = distinctUnitIds(unitIds);
  await replaceUnitIds(tx, userId, distinct);
  return { id: existing.id, email: existing.email, name: existing.name, unitIds: distinct };
}

/**
 * Replaces the memberships, or answers 404.
 *
 * @param request - Parsed params and body.
 * @param reply - Used for the 404.
 * @returns The user's profile with the new set.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof params>; Body: AttachUnitsBody }>,
  reply: FastifyReply,
) {
  const { id } = request.params;
  const { unitIds } = request.body;
  const updated = await request.server.db.tx("accounts", (tx) => setUserUnits(tx, id, unitIds));
  if (!updated) {
    return reply.code(404).send({});
  }
  return updated;
}

/** The slice's route; the path is the hook's unit-exempt `/users/:id/units`, unchanged. */
export const route: SliceRoute<typeof schema> = {
  method: "PUT",
  path: "/users/:id/units",
  schema,
  handler,
};
