/**
 * `list-unit-pendings` — GET `/reconciliation-pendings`. Lists the caller's unit's open reconciliation pendings, each with its customer's name.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { pendingToDto } from "../contracts/cadastro-dto.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { globalPendingListSchema, notFoundBody } from "../contracts/routes.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  response: { 200: globalPendingListSchema, 404: notFoundBody },
};

/**
 * Handles the request.
 *
 * @param request - The parsed request.
 * @param reply - The reply.
 * @returns The response body.
 */
export async function handler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const rows = await cadastroStore.listOpenPendingsForUnit(unitId);
  return rows.map((row) => ({
    ...pendingToDto(row),
    customerName: row.customerName,
  }));
}

export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/reconciliation-pendings",
  schema,
  handler,
};
