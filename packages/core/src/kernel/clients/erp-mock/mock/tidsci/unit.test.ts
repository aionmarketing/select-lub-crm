/**
 * Test design (testing-strategy)
 *
 * Setup: unitIdForNewTidsciCustomer pure helper. No Prisma.
 *
 * Oracle: omie-sync — new TIDSCI client → Select Lub; emp schemas share that
 *   unit; re-upsert is not this function (create-only); fixture flag unset →
 *   null so unitId is not forced.
 *
 * Axes: A1 dataset tidsci / unset; A2 Select Lub present / missing (oldest).
 * Outputs: O1 named id; O2 oldest id; O3 null.
 */
import { describe, expect, it } from "vitest";
import { unitIdForNewTidsciCustomer } from "./unit.js";

const selectLub = { id: "unit-sl", name: "Select Lub" };
const other = { id: "unit-old", name: "Other" };

describe("unitIdForNewTidsciCustomer", () => {
  it("assigns Select Lub on first TIDSCI upsert", () => {
    expect(unitIdForNewTidsciCustomer("tidsci", [other, selectLub])).toBe("unit-sl");
  });

  it("gives two emp-origin clients the same unit id", () => {
    const emp01 = unitIdForNewTidsciCustomer("tidsci", [selectLub]);
    const emp04 = unitIdForNewTidsciCustomer("tidsci", [selectLub]);
    expect(emp01).toBe(emp04);
    expect(emp01).toBe("unit-sl");
  });

  it("falls back to the oldest unit when Select Lub is missing", () => {
    expect(unitIdForNewTidsciCustomer("tidsci", [other])).toBe("unit-old");
  });

  it("does not force a unit when the fixture dataset flag is unset", () => {
    expect(unitIdForNewTidsciCustomer(undefined, [selectLub])).toBeNull();
    expect(unitIdForNewTidsciCustomer("", [selectLub])).toBeNull();
  });
});
