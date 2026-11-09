/**
 * Test design (testing-strategy)
 *
 * Setup: `parsePlate` alone, no HTTP and no adapters.
 *
 * Spec: openspec/specs/plate-lookup/plate-lookup/spec.md
 * — "Plate is normalized and validated before any billed call": accept old
 * `ABC1234` and Mercosul `ABC1D23`, strip punctuation and case, reject anything
 * else without calling a provider.
 *
 * Techniques: EP over the two accepted formats and the invalid class; BVA on
 * length (6 / 7 / 8) and on the Mercosul letter position, which is the only
 * character slot where the two formats disagree.
 *
 * Axes
 * A1 surface noise
 *   EP clean: already normalized
 *   EP noisy: hyphen, spaces, lower case, dot
 * A2 format
 *   EP old (3 letters, 4 digits)
 *   EP Mercosul (3 letters, digit, letter, 2 digits)
 *   EP invalid: wrong length, letter in a digit slot, digit in a letter slot
 *
 * Outputs: O1 normalized plate string; O2 `null`
 *
 * Sampled-cell table
 * it                                          | axes            | O | fails if
 * accepts an already normalized Mercosul plate| A1 clean+A2 mer | 1 | null
 * accepts an already normalized old plate     | A1 clean+A2 old | 1 | null
 * strips punctuation, spaces and case         | A1 noisy        | 1 | not ABC1D23
 * rejects a plate that is all letters         | A2 invalid      | 2 | non-null
 * rejects six and eight character plates      | A2 invalid BVA  | 2 | non-null
 * rejects a letter in the wrong position      | A2 invalid BVA  | 2 | non-null
 * rejects empty and punctuation-only input    | A2 invalid      | 2 | non-null
 *
 * Decision / branch map (`parsePlate`)
 * D1 PLATE.test  T: returns normalized; F: returns null
 * D2 regex alternation  old branch vs Mercosul branch, both covered
 *
 * Out of scope: whether the plate exists in any registry — that is the
 * provider's answer, not this function's. Non-Brazilian plate formats.
 */
import { describe, expect, it } from "vitest";
import { parsePlate } from "./plate.js";

describe("parsePlate", () => {
  it("accepts an already normalized Mercosul plate", () => {
    expect(parsePlate("ABC1D23")).toBe("ABC1D23");
  });

  it("accepts an already normalized old plate", () => {
    expect(parsePlate("ABC1234")).toBe("ABC1234");
  });

  it.each([
    ["hyphen", "abc-1d23"],
    ["spaces", "  ABC 1D23  "],
    ["lower case", "abc1d23"],
    ["dot", "abc.1d23"],
  ])("strips %s and upper-cases", (_label, input) => {
    expect(parsePlate(input)).toBe("ABC1D23");
  });

  it("strips a hyphen from the old format too", () => {
    expect(parsePlate("abc-1234")).toBe("ABC1234");
  });

  it("rejects a plate that is all letters", () => {
    expect(parsePlate("ZZZZZZZ")).toBeNull();
  });

  it.each([
    ["six characters", "ABC123"],
    ["eight characters", "ABC12345"],
  ])("rejects %s", (_label, input) => {
    expect(parsePlate(input)).toBeNull();
  });

  it("rejects a letter in a digit-only position", () => {
    // Mercosul puts its letter fifth; fourth must always be a digit.
    expect(parsePlate("ABCD123")).toBeNull();
  });

  it("rejects a digit in the leading letter block", () => {
    expect(parsePlate("AB11D23")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["punctuation only", "---"],
  ])("rejects %s input", (_label, input) => {
    expect(parsePlate(input)).toBeNull();
  });
});
