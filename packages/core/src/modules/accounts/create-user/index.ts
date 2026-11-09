/**
 * `POST /users` — create a person who can sign in, as a CRM user with lojas.
 *
 * Two systems are written, in this order: the identity provider (Supabase Auth)
 * first, then the CRM `user` row and its `user_unit` memberships in one
 * transaction. The provider call is **outside** the transaction on purpose: in
 * production `db.tx` runs on `prisma.$transaction`, whose 5 s timeout a slow
 * network call would eat, and a transaction held open across it would pin a
 * connection for the whole round trip.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@select-lub/core/db";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { createUserBodySchema, meSchema, type CreateUserBody } from "../contracts/http.js";
import type { CreateAuthUser } from "../internal/create-auth-user.js";
import { distinctUnitIds, insertCrmUser, replaceUnitIds } from "../internal/directory.js";
import { emptyBody } from "../internal/responses.js";
import { isAuthDuplicateEmail } from "./rules.js";

/** What create-user needs from outside: the identity provider's create call. */
export interface CreateUserPorts {
  readonly createAuthUser: CreateAuthUser;
}

/** Request and response schemas. 409 when the e-mail is already taken. */
export const schema = {
  body: createUserBodySchema,
  response: { 201: meSchema, 401: emptyBody, 409: emptyBody },
};

/**
 * Writes the CRM user and their memberships.
 *
 * One transaction, so a refused loja (foreign key) leaves no user row behind
 * without memberships.
 *
 * @param tx - A client under `module_accounts`.
 * @param user - The provider's id, and the e-mail and name to store.
 * @param unitIds - The initial lojas.
 */
export async function writeCrmUser(
  tx: DbClient,
  user: { id: string; email: string; name: string },
  unitIds: readonly string[],
): Promise<void> {
  await insertCrmUser(tx, user);
  await replaceUnitIds(tx, user.id, unitIds);
}

/** A unique violation (`P2002`) — here, `user.email` or `user.id` already present. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Builds the handler over the given ports.
 *
 * @param ports - See {@link CreateUserPorts}.
 * @returns The handler: 201 with the new profile, or 409 on a taken e-mail.
 */
export function createHandler(ports: CreateUserPorts) {
  return async (request: FastifyRequest<{ Body: CreateUserBody }>, reply: FastifyReply) => {
    const { email, password, name } = request.body;
    // Repeats collapsed before the insert: `[a, a]` would hit user_unit's
    // primary key, whose P2002 this handler would report as "e-mail taken".
    const unitIds = distinctUnitIds(request.body.unitIds ?? []);
    let created: { id: string };
    try {
      created = await ports.createAuthUser({ email, password });
    } catch (error) {
      if (isAuthDuplicateEmail(error)) {
        return reply.code(409).send({});
      }
      throw error;
    }
    // A failure below leaves the Auth user without a CRM row, exactly as the
    // apps/api route did. Not compensated here; see this slice's AGENTS.md.
    try {
      await request.server.db.tx("accounts", (tx) =>
        writeCrmUser(tx, { id: created.id, email, name }, unitIds),
      );
    } catch (error) {
      if (isUniqueViolation(error) || isAuthDuplicateEmail(error)) {
        return reply.code(409).send({});
      }
      throw error;
    }
    return reply.code(201).send({ id: created.id, email, name, unitIds });
  };
}

/**
 * The slice's route over the given ports; the path is the hook's unit-exempt
 * `POST /users`, unchanged.
 *
 * @param ports - See {@link CreateUserPorts}.
 * @returns The route to register.
 */
export function createRoute(ports: CreateUserPorts): SliceRoute<typeof schema> {
  return { method: "POST", path: "/users", schema, handler: createHandler(ports) };
}
