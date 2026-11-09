/**
 * Port for listing mock Omie service orders for one client.
 */
import type { MockServiceOrder } from "./dataset.js";

/** Lists mock OS rows keyed by the client's Omie id. Never opens a network connection. */
export type OmieServiceOrdersPort = {
  /**
   * Returns mock service orders for one Omie client.
   *
   * @param clientOmieId - Omie client id; unknown ids return `[]`.
   * @returns Cloned OS rows for that client.
   */
  listByClient(clientOmieId: string): Promise<MockServiceOrder[]>;
};

/**
 * Groups mock OS rows by client so `listByClient` is O(orders of that client), not
 * O(all orders) per call.
 *
 * @param rows - Dataset OS clone.
 * @returns Map from `clientOmieId` to that client's orders (same row objects as `rows`).
 */
export function indexMockServiceOrdersByClient(rows: MockServiceOrder[]) {
  const byClient = new Map<string, MockServiceOrder[]>();
  for (const row of rows) {
    const list = byClient.get(row.clientOmieId);
    if (list) {
      list.push(row);
    } else {
      byClient.set(row.clientOmieId, [row]);
    }
  }
  return byClient;
}

/**
 * In-memory service-order port seeded from the mock dataset.
 *
 * Indexes by `clientOmieId` once at construction so import of a large TIDSCI
 * dump is O(orders), not O(clients × orders).
 *
 * @param rows - Dataset clone the source owns; mutations stay on that clone.
 * @returns Port whose `listByClient` clones the indexed bucket for that client.
 */
export function createMockServiceOrdersPort(rows: MockServiceOrder[]): OmieServiceOrdersPort {
  const byClient = indexMockServiceOrdersByClient(rows);
  return {
    async listByClient(clientOmieId) {
      return structuredClone(byClient.get(clientOmieId) ?? []);
    },
  };
}
