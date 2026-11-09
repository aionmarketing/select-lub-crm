/**
 * Test design (testing-strategy) — the capacity type in the contracts (D5)
 *
 * SUT: motulCompatibilitySchema and quoteOptionsResultSchema, parse only.
 *
 * Oracle: the ingest-harvested-manuals delta for shared-types, "CompatibilidadeMotul is a cache
 *   row" and "Quote options carry fill liters": priced liters are `with_filter` or `unlabeled`;
 *   an unusable volume (`without_filter`, `dry`) is recorded only without priced liters; an
 *   `options` result carries the capacity type; `no_capacity` may name the unusable volume; a row
 *   written before the capacity type still parses.
 */
import { describe, expect, it } from "vitest";
import { motulCompatibilityFixture, noCapacityWithCardsFixture, quoteOptionsWithFiltersFixture } from "./http.fixtures.js";
import { motulCompatibilitySchema } from "./http.motul-compatibility.js";
import { quoteOptionsResultSchema } from "./http.oil-quote.js";

describe("the cache row's capacity type", () => {
  it("parses a row written before the capacity type", () => {
    expect(motulCompatibilitySchema.safeParse(motulCompatibilityFixture).success).toBe(true);
  });

  it("parses priced liters with a priced type", () => {
    expect(motulCompatibilitySchema.safeParse({ ...motulCompatibilityFixture, fillCondition: "with_filter" }).success).toBe(true);
  });

  it("rejects priced liters of an unusable type", () => {
    expect(
      motulCompatibilitySchema.safeParse({ ...motulCompatibilityFixture, fillLiters: 3.6, fillKind: "unlabeled", fillCondition: "dry" }).success,
    ).toBe(false);
  });

  it("parses an unusable volume without priced liters", () => {
    expect(
      motulCompatibilitySchema.safeParse({
        ...motulCompatibilityFixture,
        fillLiters: null,
        fillKind: null,
        fillCondition: "without_filter",
        unusableFillLiters: 3.6,
      }).success,
    ).toBe(true);
  });

  it("rejects an unusable volume beside priced liters, or of a priced type", () => {
    expect(motulCompatibilitySchema.safeParse({ ...motulCompatibilityFixture, fillCondition: "dry", unusableFillLiters: 3.6 }).success).toBe(false);
    expect(
      motulCompatibilitySchema.safeParse({ ...motulCompatibilityFixture, fillLiters: null, fillKind: null, fillCondition: "unlabeled", unusableFillLiters: 3.6 })
        .success,
    ).toBe(false);
  });
});

describe("quote options and the capacity type", () => {
  it("rejects an options result without a capacity type", () => {
    const without: Record<string, unknown> = { ...quoteOptionsWithFiltersFixture };
    delete without.fillCondition;

    expect(quoteOptionsResultSchema.safeParse(without).success).toBe(false);
  });

  it("rejects an options result whose capacity type is not a priced one", () => {
    expect(quoteOptionsResultSchema.safeParse({ ...quoteOptionsWithFiltersFixture, fillCondition: "dry" }).success).toBe(false);
  });

  // background-oil-research D24 (task 5.7): the missing volume carries its cards for a typed volume,
  // and the unusable volume it names is still never a priced volume of its own.
  it("parses a no_capacity result that names an unusable volume, with its cards and no fillLiters", () => {
    const parsed = quoteOptionsResultSchema.safeParse({ ...noCapacityWithCardsFixture, unusableFill: { liters: 3.6, condition: "dry" } });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toHaveProperty("options", noCapacityWithCardsFixture.options);
    expect(parsed.data).not.toHaveProperty("fillLiters");
  });

  it("rejects a no_capacity result naming a priced type as unusable", () => {
    expect(
      quoteOptionsResultSchema.safeParse({ ...noCapacityWithCardsFixture, unusableFill: { liters: 3.6, condition: "with_filter" } }).success,
    ).toBe(false);
  });
});
