/**
 * `whatsapp_connection` reads and the connection-state write, for the two paths
 * that move a connection's state: channel's own `reconcile-connection`, and
 * `conversations`' handling of Evolution's `connection.update` webhook, which
 * until 4A wrote this table directly under the login role (exception W3-C6).
 *
 * Each function runs its own `db.tx("channel", …)`.
 *
 * GUARDED BY `state_observed_at` (owner rulings, 2026-09-25). Each write carries
 * when its state was observed, and lands only when that is not older than the
 * stored one; before, the reconcile and a `connection.update` event were
 * last-writer-wins, so a retried old event could overwrite a fresh reconcile.
 * The webhook path observes at `webhook_event.created_at` (receipt time, fixed
 * across retries) and the reconcile just before each probe — both CRM clocks.
 * NOT Evolution's envelope `date_time`: in v2.3.7 that is the Evolution host's
 * local wall clock labelled "Z" (see migration
 * `20260925130000_connection_state_observed_at`), and must not be switched to.
 *
 * A TIE GOES TO THE LATER WRITE. `created_at` has millisecond precision, so two
 * webhooks received in the same millisecond carry the same time; "strictly
 * newer" would silently drop the second (say `open` right after `connecting`).
 * The same instant says nothing about order, so the write that runs later wins,
 * as before this guard.
 */
import type { Db } from "../../../kernel/db.js";

/** CRM connection state derived from Evolution session events. */
export type ConnectionState = "CONNECTING" | "CONNECTED" | "DEGRADED" | "DISCONNECTED";

const CONNECTION_STATE_UPDATE_FIELD = {
  CONNECTED: "lastConnectedAt",
  DISCONNECTED: "lastDisconnectedAt",
} as const;

/**
 * Every connection, by id and instance name.
 *
 * @param db - The database handle.
 * @returns All `whatsapp_connection` rows, unfiltered.
 */
export function listConnections(db: Db): Promise<{ id: string; instanceName: string }[]> {
  return db.tx("channel", (tx) =>
    tx.whatsAppConnection.findMany({ select: { id: true, instanceName: true } }),
  );
}

/**
 * Resolves a connection from an Evolution instance name.
 *
 * @param db - The database handle.
 * @param instanceName - The instance on a webhook envelope.
 * @returns The connection's id, or null when no row has that name.
 */
export function findConnectionByInstanceName(db: Db, instanceName: string): Promise<{ id: string } | null> {
  return db.tx("channel", (tx) =>
    tx.whatsAppConnection.findUnique({ where: { instanceName }, select: { id: true } }),
  );
}

/**
 * Writes a connection's state if it was observed after the stored one, stamping
 * `last_connected_at` or `last_disconnected_at` for those two states with the
 * same observation time.
 *
 * @param db - The database handle.
 * @param input - The connection, its new state, and when that state was
 *   observed: a webhook's `webhook_event.created_at`, or the instant before the
 *   reconcile's probe.
 * @returns True when the row was written; false when the stored state was
 *   observed later (the older fact is dropped), or the connection does not exist.
 */
export async function updateConnectionState(
  db: Db,
  input: { connectionId: string; state: ConnectionState; observedAt: Date },
): Promise<boolean> {
  const timestampField =
    input.state in CONNECTION_STATE_UPDATE_FIELD
      ? CONNECTION_STATE_UPDATE_FIELD[input.state as keyof typeof CONNECTION_STATE_UPDATE_FIELD]
      : null;
  const result = await db.tx("channel", (tx) =>
    tx.whatsAppConnection.updateMany({
      where: {
        id: input.connectionId,
        OR: [{ stateObservedAt: null }, { stateObservedAt: { lte: input.observedAt } }],
      },
      data: {
        connectionState: input.state,
        stateObservedAt: input.observedAt,
        ...(timestampField ? { [timestampField]: input.observedAt } : {}),
      },
    }),
  );
  return result.count === 1;
}
