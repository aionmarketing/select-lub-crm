/**
 * Test design (testing-strategy)
 *
 * Setup: mockOmieDataset() clones. No HTTP, no DB.
 *
 * Oracle: omie-mock — Mock data is deterministic and re-runnable.
 *
 * Axes: two successive reads of the catalog.
 * Output: deep-equal ids for clients, OS, products, vehicles, duplicate pairs.
 *
 * Decision: structuredClone each call (no shared mutable catalog).
 * Out of scope: live Omie; GitHub #5 merge execution; GitHub #29 live mapping.
 * Unautomated: pushing a mock vehicle id to a real tenant (no live Omie in CI).
 * "Reader can tell a guess from a validated mapping" is sampled below against
 * kernel/clients/erp-mock/mock/README.md (GitHub #29 / #5 labels).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mockOmieDataset } from "./dataset.js";

describe("mockOmieDataset", () => {
  it("returns identical data on two reads", () => {
    const first = mockOmieDataset();
    const second = mockOmieDataset();

    expect(first).toEqual(second);
    expect(first.clients.map((row) => row.omieId)).toEqual([
      "omie-mock-linked",
      "omie-mock-matchable",
      "omie-mock-dup-a",
      "omie-mock-dup-b",
    ]);
    expect(first.serviceOrders[0]?.omieId).toBe("os-mock-1");
    expect(first.products[0]?.omieId).toBe("cat-motul-8100-5w30");
    expect(first.products.map((row) => row.omieId)).toContain("cat-tecfil-pel108");
    expect(first.products.map((row) => row.omieId)).toContain("cat-tecfil-gi50-7");
    expect(first.vehicleIds[0]?.vehicleOmieId).toBe("veh-omie-mock-1");
    expect(first.duplicatePairs[0]).toEqual({
      leftOmieId: "omie-mock-dup-a",
      rightOmieId: "omie-mock-dup-b",
    });
  });

  it("labels vehicle ids, duplicate pairs, and TIDSCI mapping as unvalidated stand-ins", () => {
    const readme = readFileSync(join(import.meta.dirname, "README.md"), "utf8");
    expect(readme).toContain("GitHub #29");
    expect(readme).toContain("unvalidated");
    expect(readme).toContain("GitHub #5");
    expect(readme).toContain("GitHub #27");
    expect(readme).not.toMatch(/are confirmed Omie keys|are live Omie keys/i);
  });
});
