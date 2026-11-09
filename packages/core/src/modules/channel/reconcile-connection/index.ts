/**
 * `reconcile-connection` — brings the stored connection state in line with what
 * Evolution reports now.
 *
 * Moved from `apps/worker/src/ingest/reconcile.ts`. Its two queries,
 * `listConnections` and `updateConnectionState`, are channel's
 * `contracts/connections.ts` since 4A, shared with `conversations`' handling of
 * the `connection.update` webhook. It lists every `whatsapp_connection`, asks Evolution for each one's
 * live state, and writes the answer — skipping any connection whose lookup fails
 * or returns a state it does not recognise.
 *
 * NOT A JOB OF ITS OWN (ruling Q2-A). It runs once at start-up and then on the
 * worker's heartbeat, AFTER the ingest retry pass, inside one worker-level job, so
 * the two stay serialized as they were.
 *
 * ORDERED AGAINST WEBHOOKS BY OBSERVATION TIME (owner rulings, 2026-09-25). Each
 * connection's answer is written as observed at the instant just BEFORE its own
 * probe, and `updateConnectionState` writes only what is newer than the stored
 * observation: a `connection.update` the CRM received after the probe started
 * wins, and one received earlier, even if its retry is processed later, loses.
 *
 * The Evolution GET is awaited OUTSIDE any transaction (W2-C12): the list is read
 * in one `db.tx("channel")`, and each write is its own.
 */
import type { Db } from "../../../kernel/db.js";
import { listConnections, updateConnectionState } from "../contracts/connections.js";
import type { EvolutionConnectionState } from "../internal/ports.js";

export type { EvolutionConnectionState, EvolutionConnectionStateResult } from "../internal/ports.js";

/**
 * Polls Evolution for each connection and stores the state it reports.
 *
 * @param db - The database handle; every query runs on `db.tx("channel", …)`.
 * @param connectionState - Evolution's live connection-state reader.
 * @param clock - When each probe starts; defaults to the wall clock. Tests pin it.
 * @returns Resolves after every connection has been polled.
 */
export async function reconcileConnection(
  db: Db,
  connectionState: EvolutionConnectionState,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const connections = await listConnections(db);
  for (const connection of connections) {
    // Taken per connection, before its own probe: with several connections one
    // time for the whole loop would date the later answers too early.
    const observedAt = clock();
    const result = await connectionState.getConnectionState(connection.instanceName);
    if (!result.ok) {
      continue;
    }
    await updateConnectionState(db, { connectionId: connection.id, state: result.evolutionState, observedAt });
  }
}
