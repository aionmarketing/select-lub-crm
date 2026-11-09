/**
 * Test design (testing-strategy)
 *
 * Setup: zod safeParse/parse on the verified-spec cache row and the quote-options
 * result. No HTTP, no DB, no Motul.
 *
 * Spec: openspec/specs/shared-types/spec.md
 * (Quote options carry fill liters; CompatibilidadeMotul is a cache row) and
 * openspec/specs/quotes/motul-compatibility/spec.md (cache stores engine fill liters and
 * provenance).
 *
 * Techniques: EP (one invalid class per `it`), BVA on the ordered cutoffs the new
 * contracts add (viscosityGrades .min(1); options fillLiters > 0), decision-table
 * coverage of the fillLiters/fillKind co-nullability rule, and branch coverage of
 * the two result arms this change adds or widens.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * S1 viscosityGrades - a LIST, never collapsed to one grade (D12)
 *   EP valid: ["5W-40"] (source listed one); ["5W-40", "5W-30"] (source listed two)
 *   BVA: [] (below the .min(1) cutoff) | [""] (element fails trim().min(1))
 *
 * S2 fillLiters / fillKind co-nullability - null "exactly when" (D2)
 *   Decision table, all four rows:
 *     liters set + kind set   -> valid (a capacity was verified)
 *     liters null + kind null -> valid (grade verified, capacity was not)
 *     liters set + kind null  -> invalid (which legend produced it is unknown)
 *     liters null + kind set  -> invalid (a legend with no volume)
 *
 * S3 fillKind vocabulary - closed enum em_servico | unlabeled
 *   EP valid: "em_servico"; "unlabeled"
 *   EP invalid: "seco" - the deliberate case: dry fill is a REAL Motul legend that
 *    the picker can read, and the contract's job is to keep it from ever reaching
 *    a card as the multiplier. A typo would not prove that.
 *
 * S4 options fillLiters magnitude - strictly positive on an `options` result
 *   BVA: 0 (below; a verified grade with no capacity is `no_capacity`, not a
 *    zero-litre card) | 0.1 (above) | absent (the field is required)
 *
 * S5 options provenance - publisher/document/page non-empty when status is options
 *   EP valid: all three named
 *   EP invalid: sourcePublisher "" (an uncited spec must not price a card)
 *
 * S6 result arms this change touches
 *   EP valid: `no_capacity` with grades, its cards and no volume (D24); `options` still carrying a
 *    `matched` filter slot (the tecfil-filter-pricing contract must survive)
 *
 * ----------------------------------------------------------------------------
 * Out of scope
 * ----------------------------------------------------------------------------
 * - SAE *pattern* validation (`nW-nn`): D10 step 5 puts that in the application
 *   validator, not the contract, so a monograde source is not rejected at parse.
 * - Filter-slot arms and the Tecfil cache row: filter-contracts.test.ts owns those.
 * - Rounding of unitPrice x liters: apps/web owns that (D4).
 */
import { describe, expect, it } from "vitest";
import { motulCompatibilityFixture, noCapacityWithCardsFixture, quoteOptionsWithFiltersFixture } from "./http.fixtures.js";
import { motulCompatibilitySchema } from "./http.motul-compatibility.js";
import { quoteOptionsResultSchema } from "./http.oil-quote.js";

describe("CompatibilidadeMotul verified-spec row", () => {
  it("parses a row carrying several listed grades, service-fill liters, and provenance", () => {
    const parsed = motulCompatibilitySchema.parse(motulCompatibilityFixture);

    expect(parsed.viscosityGrades).toEqual(["5W-40", "5W-30"]);
    expect(parsed.fillLiters).toBe(3.5);
    expect(parsed.fillKind).toBe("em_servico");
    expect(parsed.sourcePublisher).toBe("Peugeot do Brasil");
  });

  it("parses a grade-only row, where capacity was not verified", () => {
    const parsed = motulCompatibilitySchema.parse({
      ...motulCompatibilityFixture,
      fillLiters: null,
      fillKind: null,
    });

    expect(parsed.fillLiters).toBeNull();
    expect(parsed.fillKind).toBeNull();
  });

  it("rejects an empty viscosityGrades list", () => {
    const result = motulCompatibilitySchema.safeParse({
      ...motulCompatibilityFixture,
      viscosityGrades: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a blank grade inside the list", () => {
    const result = motulCompatibilitySchema.safeParse({
      ...motulCompatibilityFixture,
      viscosityGrades: [""],
    });

    expect(result.success).toBe(false);
  });

  it("rejects liters without the legend that produced them", () => {
    const result = motulCompatibilitySchema.safeParse({
      ...motulCompatibilityFixture,
      fillLiters: 4.2,
      fillKind: null,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a legend with no liters", () => {
    const result = motulCompatibilitySchema.safeParse({
      ...motulCompatibilityFixture,
      fillLiters: null,
      fillKind: "em_servico",
    });

    expect(result.success).toBe(false);
  });

  it("rejects dry fill as a stored quote legend", () => {
    const result = motulCompatibilitySchema.safeParse({
      ...motulCompatibilityFixture,
      fillLiters: 6.5,
      fillKind: "seco",
    });

    expect(result.success).toBe(false);
  });
});

describe("quote-options result", () => {
  it("parses an options result with grades, liters, provenance, and a matched filter slot", () => {
    const parsed = quoteOptionsResultSchema.parse(quoteOptionsWithFiltersFixture);

    expect(parsed.status).toBe("options");
    if (parsed.status !== "options") {
      throw new Error("expected an options result");
    }
    expect(parsed.viscosityGrades).toEqual(["5W-40", "5W-30"]);
    expect(parsed.fillLiters).toBe(3.5);
    expect(parsed.filters.oil.status).toBe("matched");
  });

  it("rejects an options result with no fillLiters", () => {
    const withoutLiters: Record<string, unknown> = { ...quoteOptionsWithFiltersFixture };
    delete withoutLiters.fillLiters;

    const result = quoteOptionsResultSchema.safeParse(withoutLiters);

    expect(result.success).toBe(false);
  });

  it("rejects an options result whose fillLiters is zero", () => {
    const result = quoteOptionsResultSchema.safeParse({
      ...quoteOptionsWithFiltersFixture,
      fillLiters: 0,
    });

    expect(result.success).toBe(false);
  });

  it("accepts the smallest positive fill volume", () => {
    const result = quoteOptionsResultSchema.safeParse({
      ...quoteOptionsWithFiltersFixture,
      fillLiters: 0.1,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an options result with an empty viscosityGrades list", () => {
    const result = quoteOptionsResultSchema.safeParse({
      ...quoteOptionsWithFiltersFixture,
      viscosityGrades: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an options result whose spec has no publisher", () => {
    const result = quoteOptionsResultSchema.safeParse({
      ...quoteOptionsWithFiltersFixture,
      sourcePublisher: "",
    });

    expect(result.success).toBe(false);
  });

  // background-oil-research D24 (task 5.7): a missing volume now carries its cards and filters for
  // the attendant to price from a typed volume, and still no volume of its own.
  it("parses no_capacity with its cards and filters, and no fillLiters", () => {
    const parsed = quoteOptionsResultSchema.parse(noCapacityWithCardsFixture);

    expect(parsed.status).toBe("no_capacity");
    expect(parsed).toHaveProperty("options", noCapacityWithCardsFixture.options);
    expect(parsed).not.toHaveProperty("fillLiters");
  });

  it("rejects no_capacity without cards, with no card, or carrying a volume", () => {
    const { options, ...withoutCards } = noCapacityWithCardsFixture;
    void options;

    expect(quoteOptionsResultSchema.safeParse(withoutCards).success).toBe(false);
    expect(quoteOptionsResultSchema.safeParse({ ...noCapacityWithCardsFixture, options: [] }).success).toBe(false);
    expect(quoteOptionsResultSchema.safeParse({ ...noCapacityWithCardsFixture, fillLiters: 4 }).success).toBe(false);
  });
});

/**
 * Added with `conflicting_sources` (oil-quote-liters-pricing task 7.5).
 *
 * Axes
 *   K1 conflict count — 1 / 0 (below the .min(1) cutoff)
 *   K2 values per conflict — 2 / 1 (below the .min(2) cutoff: one value is not a conflict)
 *   K3 sourceAuthority — 1 / null (a historical source never declared a tier) / 7 (out of 1–5)
 *
 * Sampled cells (one row per `it`)
 *   1 conflict, 2 values, tiers 1 and 5 | K1,K2,K3 | parses, no cards
 *   1 conflict, 1 value                  | K2       | fails parse
 *   0 conflicts                          | K1       | fails parse
 *   authority 7                          | K3       | fails parse
 */
describe("quote-options conflicting_sources", () => {
  const manualValue = {
    value: "4.3",
    sourcePublisher: "Volkswagen do Brasil",
    sourceDocument: "Manual do Proprietário Polo 2021",
    sourcePage: "p. 287",
    sourceAuthority: 1,
  };
  const catalogValue = {
    value: "4",
    sourcePublisher: "CarroRac",
    sourceDocument: "tabela de aplicação",
    sourcePage: "Polo AW, 1.0 TSI",
    sourceAuthority: 5,
  };

  it("parses a litre conflict with two cited values and carries no cards", () => {
    const parsed = quoteOptionsResultSchema.parse({
      status: "conflicting_sources",
      conflicts: [{ field: "fillLiters", values: [manualValue, catalogValue] }],
    });

    expect(parsed.status).toBe("conflicting_sources");
    expect(parsed).not.toHaveProperty("options");
  });

  it("rejects a conflict with a single value", () => {
    const result = quoteOptionsResultSchema.safeParse({
      status: "conflicting_sources",
      conflicts: [{ field: "fillLiters", values: [manualValue] }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty conflict list", () => {
    const result = quoteOptionsResultSchema.safeParse({
      status: "conflicting_sources",
      conflicts: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an authority tier outside 1–5", () => {
    const result = quoteOptionsResultSchema.safeParse({
      status: "conflicting_sources",
      conflicts: [
        { field: "fillLiters", values: [manualValue, { ...catalogValue, sourceAuthority: 7 }] },
      ],
    });

    expect(result.success).toBe(false);
  });
});

/**
 * Added by web-search-source-adapter task 1.1.
 *
 * Oracle: specs/shared-types/spec.md — the cache row gains nullable `sourceClassification`
 * (closed to the five document classes) and nullable `sourceExcerpt`, both absent on rows
 * written before the columns existed and on fixture/Motul sources.
 *
 * Axes
 *   W1 classification — a valid class / `other` / absent / null
 *   W2 excerpt — present / absent
 *
 * Sampled cells (one row per `it`)
 *   manufacturer_manual + excerpt | W1,W2 | parses, both readable
 *   both absent                   | W1,W2 | parses — the fixture and Motul case, and every
 *      row written before this change
 *   `other`                       | W1    | fails parse. THE closed-enum check: `other` is a
 *      class the searching model can emit, and it must never reach a stored row, because a
 *      page it could not place has no tier
 *   arbitrary string              | W1    | fails parse
 */
describe("verified-spec row — web source columns", () => {
  it("parses a web-found row carrying its class and the passage read", () => {
    const parsed = motulCompatibilitySchema.parse({
      ...motulCompatibilityFixture,
      sourceAuthority: 1,
      sourceUrl: "https://example.test/manual.html",
      sourceClassification: "manufacturer_manual",
      sourceExcerpt: "Capacidade com filtro: 4,2 litros. Viscosidade 5W-40.",
    });

    expect(parsed.sourceClassification).toBe("manufacturer_manual");
    expect(parsed.sourceExcerpt).toContain("4,2 litros");
  });

  it("parses a row with neither, which is every fixture and Motul row", () => {
    const parsed = motulCompatibilitySchema.parse(motulCompatibilityFixture);

    expect(parsed.sourceClassification).toBeUndefined();
    expect(parsed.sourceExcerpt).toBeUndefined();
  });

  it("rejects `other` as a stored classification", () => {
    const result = motulCompatibilitySchema.safeParse({
      ...motulCompatibilityFixture,
      sourceClassification: "other",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a classification outside the five classes", () => {
    const result = motulCompatibilitySchema.safeParse({
      ...motulCompatibilityFixture,
      sourceClassification: "blog_post",
    });

    expect(result.success).toBe(false);
  });
});
