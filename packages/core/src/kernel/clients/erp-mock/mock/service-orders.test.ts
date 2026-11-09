/**
 * Test design (testing-strategy)
 *
 * Setup: `indexMockServiceOrdersByClient` + `createMockServiceOrdersPort`.
 *   Fixture OS from `mockOmieDataset`. Synthetic 3×1000 rows for the index.
 *
 * Oracle: omie-mock — listByClient still clones fixture rows; import must not
 *   scan every order per client (map lookup, not filter of the full array).
 *
 * Axes: A1 client known / unknown; A2 index vs full-array scan.
 * Outputs: O1 cloned fixture OS; O2 empty; O3 map bucket size 1000, 3 keys.
 *
 * Decision: missing key → []; present key → clone bucket only.
 */
import { describe, expect, it } from "vitest";
import { mockOmieDataset, type MockServiceOrder } from "./dataset.js";
import { createMockServiceOrdersPort, indexMockServiceOrdersByClient } from "./service-orders.js";

describe("createMockServiceOrdersPort", () => {
  it("returns clones of the fixture OS for the linked client", async () => {
    const data = mockOmieDataset();
    const port = createMockServiceOrdersPort(data.serviceOrders);
    const listed = await port.listByClient("omie-mock-linked");

    expect(listed).toEqual(data.serviceOrders);
    expect(listed[0]).not.toBe(data.serviceOrders[0]);
    expect(await port.listByClient("unknown")).toEqual([]);
  });

  it("indexes 3 clients × 1000 orders so listByClient does not scan the full array", async () => {
    const rows: MockServiceOrder[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const clientOmieId = `client-${i % 3}`;
      rows.push({
        omieId: `os-${i}`,
        clientOmieId,
        vehicleOmieId: null,
        performedAt: "2026-01-01T00:00:00.000Z",
        description: "NF",
        kind: "nf",
        status: "concluido",
        amount: 1,
        odometerKm: null,
      });
    }
    const index = indexMockServiceOrdersByClient(rows);
    expect(index.size).toBe(3);
    expect(index.get("client-0")).toHaveLength(1000);
    const port = createMockServiceOrdersPort(rows);
    const listed = await port.listByClient("client-1");
    expect(listed).toHaveLength(1000);
    expect(listed.every((row) => row.clientOmieId === "client-1")).toBe(true);
  });
});
