/**
 * Test design (testing-strategy) — reading the cache row's capacity type (D5)
 *
 * SUT: readFillCondition, pure.
 *
 * Oracle: the shared-types delta "CompatibilidadeMotul is a cache row": priced liters are
 *   `with_filter` or `unlabeled`, and a row written before the column reads its type from its
 *   legend; an unusable volume is read only without priced liters, as `without_filter` or `dry`; a
 *   value the column should not hold is not trusted.
 */
import { describe, expect, it } from "vitest";
import { readFillCondition } from "./column-readers.js";

describe("readFillCondition", () => {
  it("reads a row written before the column from its legend", () => {
    expect(readFillCondition(4, "em_servico", null, null)).toEqual({ fillCondition: "with_filter", unusableFillLiters: null });
    expect(readFillCondition(4, "unlabeled", null, null)).toEqual({ fillCondition: "unlabeled", unusableFillLiters: null });
  });

  it("reads the column for priced liters, and distrusts an unusable type beside them", () => {
    expect(readFillCondition(4, "unlabeled", "unlabeled", null)).toEqual({ fillCondition: "unlabeled", unusableFillLiters: null });
    expect(readFillCondition(4, "em_servico", "dry", 3.6)).toEqual({ fillCondition: "with_filter", unusableFillLiters: null });
  });

  it("reads an unusable volume only without priced liters", () => {
    expect(readFillCondition(null, null, "dry", 3.6)).toEqual({ fillCondition: "dry", unusableFillLiters: 3.6 });
    expect(readFillCondition(null, null, "without_filter", 3.6)).toEqual({ fillCondition: "without_filter", unusableFillLiters: 3.6 });
  });

  it("reads nothing when there is no volume, or the column holds a priced type with no liters", () => {
    expect(readFillCondition(null, null, null, null)).toEqual({ fillCondition: null, unusableFillLiters: null });
    expect(readFillCondition(null, null, "with_filter", 3.6)).toEqual({ fillCondition: null, unusableFillLiters: null });
  });

  // Review of #189: one rule for the reader and the answer.
  it("reads a priced type with null liters and no unusable volume as no capacity type", () => {
    expect(readFillCondition(null, null, "with_filter", null)).toEqual({ fillCondition: null, unusableFillLiters: null });
    expect(readFillCondition(null, "unlabeled", "unlabeled", null)).toEqual({ fillCondition: null, unusableFillLiters: null });
  });

  it.each([0, -3.6])("treats an unusable volume of %s liters as absent", (liters) => {
    expect(readFillCondition(null, null, "dry", liters)).toEqual({ fillCondition: null, unusableFillLiters: null });
  });
});
