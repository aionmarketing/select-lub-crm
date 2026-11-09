/**
 * `GET /conversations/:id/services` — the service orders of whoever a
 * conversation is with, for the Conversas rail.
 *
 * Moved from `apps/api/src/services/routes.ts`. The conversation must hang off a
 * connection of the caller's loja, or it is a 404. Its customer is the one it
 * names, when that customer is in the loja; otherwise the loja's customer whose
 * phone is the conversation's chat key. No customer resolving is a 200 with
 * `{ customerId: null, services: [] }`, not a 404 — the conversation exists.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { conversationServicesSchema, type Service } from "../contracts/http.js";
import { idParams, notFoundBody } from "../internal/params.js";
import { customerUnitId, servicesOfCustomer } from "../internal/service-reads.js";

/** Request and response schemas. */
export const schema = {
  params: idParams,
  response: { 200: conversationServicesSchema, 404: notFoundBody },
};

/** What the route answers for a conversation in the loja. */
export type ConversationServices = { customerId: string | null; services: Service[] };

/**
 * The customer a conversation resolves to, in the caller's loja.
 *
 * One `db.tx` per read, as the route's store calls were: the conversation
 * (`getCadastroLink`), the named customer's loja (`getCustomer`), then the phone
 * match (`findCustomerByPhone`). All three tables are other modules', read as
 * foreign reads. The phone matched is the conversation's `chatKey`: the old link
 * returned it AS the phone.
 *
 * @returns `undefined` when the conversation is unknown or out of loja; `null`
 *   when it is in the loja but no customer resolves; otherwise the customer id.
 */
async function resolveCustomer(
  db: Db,
  unitId: string,
  conversationId: string,
): Promise<string | null | undefined> {
  const link = await db.tx("services", (tx) =>
    tx.conversation.findFirst({
      where: { id: conversationId, whatsappConnection: { unitId } },
      select: { id: true, customerId: true, chatKey: true },
    }),
  );
  if (!link) {
    return undefined;
  }
  const namedId = link.customerId;
  if (namedId) {
    const namedUnit = await db.tx("services", (tx) => customerUnitId(tx, namedId));
    if (namedUnit === unitId) {
      return namedId;
    }
  }
  const phone = await db.tx("services", (tx) =>
    tx.customerPhone.findFirst({
      where: { normalized: link.chatKey, customer: { unitId } },
      orderBy: { updatedAt: "desc" },
      select: { customerId: true },
    }),
  );
  return phone?.customerId ?? null;
}

/**
 * Lists the services of a conversation's customer.
 *
 * @param db - The database handle.
 * @param unitId - The caller's loja.
 * @param conversationId - The conversation.
 * @returns The customer id and its services, newest first; `{ customerId: null,
 *   services: [] }` when no customer resolves; `null` when the conversation is
 *   unknown or not in the loja.
 */
export async function listConversationServices(
  db: Db,
  unitId: string,
  conversationId: string,
): Promise<ConversationServices | null> {
  const customerId = await resolveCustomer(db, unitId, conversationId);
  if (customerId === undefined) {
    return null;
  }
  if (customerId === null) {
    return { customerId: null, services: [] };
  }
  const services = await db.tx("services", (tx) => servicesOfCustomer(tx, customerId));
  return { customerId, services };
}

/**
 * The handler: 200 with the customer and its services, or 404.
 *
 * @param request - Parsed params; the hook has set the caller's unit.
 * @param reply - Used for the 404.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof idParams> }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const listed = await listConversationServices(request.server.db, unitId, request.params.id);
  if (!listed) {
    return reply.code(404).send({});
  }
  return listed;
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/conversations/:id/services",
  schema,
  handler,
};
