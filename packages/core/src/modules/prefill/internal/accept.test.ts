/**
 * Test design (testing-strategy)
 *
 * Setup: pendingPrefillEntries against plain PrefillFields objects.
 *
 * Oracle: assistive-prefill-accept-all — accept-all walks pending keys in
 * the closed v1 field order; keys that are not pending are skipped.
 *
 * Axes
 *   A1 key presence: present vs omitted
 *   A2 key order on the object vs v1 enum order
 *
 * Sampled-cell
 *   plate then name on the object | A2 scrambled | name then plate | object-key order
 *   omitted year                  | A1 omitted   | no year row     | year: undefined row
 *
 * Decision map
 *   D1 Object.hasOwn(field) T: name/plate; F: year omitted
 *
 * Out of scope: HTTP persist (cadastro.prefill.test); customer create.
 */
import { describe, expect, it } from "vitest";
import { pendingPrefillEntries } from "./accept.js";

describe("pendingPrefillEntries", () => {
  it("emits present keys in v1 field order, not object insertion order", () => {
    const entries = pendingPrefillEntries({ plate: "ABC1D23", name: "Ana", year: 2020 });

    expect(entries).toEqual([
      { field: "name", value: "Ana" },
      { field: "plate", value: "ABC1D23" },
      { field: "year", value: 2020 },
    ]);
  });

  it("skips keys that are not on the pending map", () => {
    const entries = pendingPrefillEntries({ name: "Ana" });

    expect(entries.map((row) => row.field)).toEqual(["name"]);
  });
});
