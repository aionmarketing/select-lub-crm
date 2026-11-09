/**
 * `GET /channel/status` — the WhatsApp connection state the Conversas screen
 * shows as its Conectado / Desconectado badge.
 *
 * Moved from `apps/api/src/conversations` (`channelStatus` on the conversations
 * store, and its route). It reads the STORED `whatsapp_connection.connection_state`
 * of the one configured Evolution instance — the same row Nova conversa's
 * `create` checks — and never the live probe, which only the send paths read
 * (memory: connectivity-has-two-sources-column-and-probe). No row reads as
 * `DISCONNECTED`.
 *
 * The path is unchanged, and `apps/api`'s auth hook still treats it specially
 * (`resolve-unit.ts`): the hook answers 401/403, this answers the state.
 */
import { channelStatusSchema, type ChannelState, type ChannelStatus } from "../contracts/http.js";
import type { FastifyRequest } from "fastify";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";

/** Response schema. */
export const schema = { response: { 200: channelStatusSchema } };

/**
 * Reads the configured instance's stored connection state.
 *
 * @param db - The database handle; runs on `db.tx("channel", …)`.
 * @param instanceName - The configured `EVOLUTION_INSTANCE_NAME`.
 * @returns The stored state, or `DISCONNECTED` when no row has that name.
 */
export async function getChannelStatus(db: Db, instanceName: string): Promise<ChannelStatus> {
  const connection = await db.tx("channel", (tx) =>
    tx.whatsAppConnection.findUnique({ where: { instanceName }, select: { connectionState: true } }),
  );
  return { state: (connection?.connectionState as ChannelState | undefined) ?? "DISCONNECTED" };
}

/**
 * The route, for the api's app.
 *
 * @param deps.instanceName - Resolves the configured instance name, once per
 *   request, so an app built for a test reads that test's connection.
 * @returns The route to register.
 */
export function route(deps: { instanceName: () => string }): SliceRoute<typeof schema> {
  return {
    method: "GET",
    path: "/channel/status",
    schema,
    handler: (request: FastifyRequest) => getChannelStatus(request.server.db, deps.instanceName()),
  };
}
