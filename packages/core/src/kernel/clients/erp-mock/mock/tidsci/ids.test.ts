/**
 * Test design (testing-strategy)
 *
 * Setup: `allocateOmieLookingId` with a `Set`. No HTTP, no archive.
 *
 * Oracle: omie-mock — visible ids are 10–12 digit decimal strings; same source
 *   tuple is stable until a collision, then increment.
 *
 * Axes: A1 source key identity; A2 used-set occupancy (free / hash taken).
 * Outputs: O1 10–12 digits; O2 same key + empty used → same digits; O3 increment.
 *
 * Decision map: n < 10^9 bump; while used increment; wrap at 10^12 (wrap
 *   unsampled — would need 10^12 occupied ids).
 */
import { describe, expect, it } from "vitest";
import { allocateOmieLookingId, isOmieLookingId } from "./ids.js";

describe("allocateOmieLookingId", () => {
  it("emits a 10–12 digit decimal string that is stable for the same source tuple", () => {
    const first = allocateOmieLookingId("client|schema|emp01|10", new Set());
    const second = allocateOmieLookingId("client|schema|emp01|10", new Set());

    expect(isOmieLookingId(first)).toBe(true);
    expect(first).toBe(second);
    expect(first).not.toMatch(/emp01|tidsci-/);
  });

  it("increments when the hashed id is already taken", () => {
    const used = new Set<string>();
    const first = allocateOmieLookingId("client|cpf|52998224725", used);
    const occupied = new Set([first]);
    const collided = allocateOmieLookingId("client|cpf|52998224725", occupied);

    expect(collided).toBe((BigInt(first) + 1n).toString());
    expect(isOmieLookingId(collided)).toBe(true);
  });
});
