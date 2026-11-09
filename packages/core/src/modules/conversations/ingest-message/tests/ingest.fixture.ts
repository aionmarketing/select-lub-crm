/**
 * Shared setup for the `ingest-message` suites, moved with them from
 * `apps/worker/src/ingest/*.test.ts` (4A).
 *
 * Two things replace what the worker tests used:
 * - `createPrismaStore(tx, …)` is `createIngestStore(createDb(tx, …))`: the same
 *   port over this module's role and channel's contracts.
 * - The `onMessageInserted` hook the tests counted is the event
 *   `conversations/message-received`. {@link countMessagesReceived} subscribes to
 *   it and counts; the count means exactly what the hook count meant, since the
 *   event is published at the point the hook was called. Every counter is
 *   unsubscribed after its test.
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { afterEach } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { subscribe } from "../../../../kernel/events.js";
import { messageReceived } from "../../contracts/message-received.js";
import { runInTransactionOnTx, seedConnection, seedUnit } from "../../../../testing/index.js";
import { createIngestStore } from "../index.js";

export const db = () => prisma as PrismaClient;

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

/**
 * Counts `conversations/message-received` publications from now until the test ends.
 *
 * @returns A live count.
 */
export function countMessagesReceived(): { readonly count: number } {
  let count = 0;
  offs.push(
    subscribe(messageReceived, () => {
      count += 1;
    }),
  );
  return {
    get count() {
      return count;
    },
  };
}

/**
 * The ingest store over the test transaction.
 *
 * @param tx - The test transaction.
 * @returns The store.
 */
export function ingestStoreOn(tx: DbClient) {
  return createIngestStore(createDb(tx, runInTransactionOnTx(tx)));
}

/**
 * Seeds a unit and a connection and builds the ingest store on `tx`.
 *
 * @param tx - The test transaction.
 * @returns The connection row and the store.
 */
export async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  return { connection, store: ingestStoreOn(tx) };
}
