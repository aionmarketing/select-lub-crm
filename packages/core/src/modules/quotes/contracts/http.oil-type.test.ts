/**
 * Test design (testing-strategy) — the lubricant oil type in the contracts (add-lubricant-oil-type)
 *
 * SUT: `lubricantDetailSchema`, `quoteOptionsResultSchema` (parse only) and
 *   `descriptionNamesGrade`.
 *
 * Oracle: the shared-types delta "Lubricant-detail contract" — `oilType` is always present, one
 *   of SINTETICO / SEMISSINTETICO / MINERAL or null; a label or a misspelling fails; every oil
 *   card the quote-options contract carries carries it. And the oil-quote delta "A grade already
 *   in the description is not repeated", under the SAE normalization.
 *
 * Axes
 *   A1 oilType — each value / null / label / misspelling / omitted
 *   A2 card site — options card / no_capacity card / conflict card
 *   A3 grade in description — exact / unhyphenated lower case / with SAE / absent / a longer
 *      grade sharing digits (15W-40 vs 5W-40, the fixture far from the wrong answer)
 */
import { describe, expect, it } from "vitest";
import { descriptionNamesGrade, lubricantDetailSchema } from "./http.catalog.js";
import {
  gradeConflictWithCardsFixture,
  lubricantDetailFixture,
  noCapacityWithCardsFixture,
  quoteOptionsWithFiltersFixture,
} from "./http.fixtures.js";
import { quoteOptionsResultSchema } from "./http.oil-quote.js";

describe("lubricant-detail oilType", () => {
  it.each(["SINTETICO", "SEMISSINTETICO", "MINERAL"] as const)("parses %s and keeps it", (oilType) => {
    expect(lubricantDetailSchema.parse({ ...lubricantDetailFixture, oilType }).oilType).toBe(oilType);
  });

  it("parses null as no recorded type", () => {
    expect(lubricantDetailSchema.parse({ ...lubricantDetailFixture, oilType: null }).oilType).toBeNull();
  });

  it.each(["Sintético", "SINTETICA", ""])("rejects %j", (oilType) => {
    expect(lubricantDetailSchema.safeParse({ ...lubricantDetailFixture, oilType }).success).toBe(false);
  });

  it("rejects an omitted oilType", () => {
    const rest: Record<string, unknown> = { ...lubricantDetailFixture };
    delete rest.oilType;
    expect(lubricantDetailSchema.safeParse(rest).success).toBe(false);
  });
});

describe("quote cards carry the oil type", () => {
  it("an options card parses with its lubricant's oil type", () => {
    const parsed = quoteOptionsResultSchema.parse(quoteOptionsWithFiltersFixture);
    expect(parsed.status === "options" && parsed.options[0]?.lubricant.oilType).toBe("SINTETICO");
  });

  it("an options card without the field fails parse", () => {
    const card = quoteOptionsWithFiltersFixture.options[0]!;
    const lubricant: Record<string, unknown> = { ...card.lubricant };
    delete lubricant.oilType;
    expect(
      quoteOptionsResultSchema.safeParse({ ...quoteOptionsWithFiltersFixture, options: [{ ...card, lubricant }] }).success,
    ).toBe(false);
  });

  it.each([
    ["no_capacity", noCapacityWithCardsFixture],
    ["conflicting_sources", gradeConflictWithCardsFixture],
  ] as const)("a %s result's cards parse with the oil type", (_status, fixture) => {
    expect(quoteOptionsResultSchema.safeParse(fixture).success).toBe(true);
  });
});

describe("descriptionNamesGrade", () => {
  it.each([
    ["Super 3000 0W-20", "0W-20", true],
    ["8100 Eco-nergy 5w30", "5W-30", true],
    ["Top Turbo SAE 5W 30", "5W-30", true],
    ["8100 Eco-nergy", "5W-30", false],
    ["F1 Master 15W-40", "5W-40", false],
    ["Tecno 10W-40", "0W-40", false],
  ])("%j names %s: %s", (description, grade, expected) => {
    expect(descriptionNamesGrade(description, grade)).toBe(expected);
  });
});
