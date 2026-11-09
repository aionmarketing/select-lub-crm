/**
 * Test design (testing-strategy)
 *
 * Setup: pure filterCompatibleCatalogItems; no HTTP/DB.
 *
 * Oracle: oil-quote spec "Quote offers only compatible catalog items" (AC-CONV-09
 * match, near-miss viscosity, inactive excluded, item without lubricant-detail
 * excluded) plus "Empty lubricant classification matches on viscosity alone"
 * (split-catalog-lubricant-detail delta).
 *
 * Axes
 *   A1 lubricant-detail — present vs null (item is not an oil)
 *   A2 viscosity — equal vs different
 *   A3 classification on the child — non-empty equal | non-empty different | empty
 *   A4 active — true vs false
 *
 * Outputs: O1 matching item only; O2 empty
 *
 * Sampled-cell table
 *   it                                   | axes                  | O | fails if
 *   matches Motul seed, drops near-miss   | A1 yes A2 eq/neq A3 eq A4 on | O1 | near-miss offered
 *   near-miss viscosity alone             | A2 neq                | O2 | miss offered
 *   inactive with matching child          | A4 off                | O2 | inactive offered
 *   item with no lubricant-detail         | A1 null               | O2 | non-oil offered
 *   empty classification, viscosity match | A3 empty              | O1 | required classification
 *   non-empty classification mismatch     | A3 neq                | O2 | classification ignored
 *
 * Decision map (catalogItemMatchesSpec)
 *   D1 !active            F match its; T inactive it
 *   D2 lubricant == null  F match its; T no-child it
 *   D3 viscosity neq      F match its; T near-miss it
 *   D4 classification ""  T empty-classification it; F match its
 *   D5 classification eq  T match its; F mismatch it
 *
 * Out of scope: Motul HTTP; quote UI; Prisma include shape (options.test.ts).
 */
import { describe, expect, it } from "vitest";
import { catalogItemFixture, inactiveCatalogItemFixture, lubricantDetailFixture } from "../../contracts/http.js";
import { filterCompatibleCatalogItems } from "../catalog/match.js";

const spec = { viscosityGrades: ["5W-40"], classification: "API SN" };

/** `catalogItemFixture` carrying its own oil spec — viscosity 5W-40, classification API SN. */
const motulSeed = { ...catalogItemFixture, lubricant: lubricantDetailFixture };

const nearMiss = {
  ...catalogItemFixture,
  id: "cat-near",
  lubricant: { ...lubricantDetailFixture, catalogItemId: "cat-near", viscosity: "5W-30" },
};

describe("filterCompatibleCatalogItems", () => {
  it("offers only the item whose viscosity and classification match", () => {
    const offered = filterCompatibleCatalogItems([motulSeed, nearMiss], spec);

    expect(offered.map((row) => row.id)).toEqual([motulSeed.id]);
  });

  it("returns empty when viscosity is a near-miss", () => {
    const offered = filterCompatibleCatalogItems([nearMiss], spec);

    expect(offered).toEqual([]);
  });

  it("excludes an inactive item even when its lubricant-detail matches", () => {
    const inactiveMatch = {
      ...inactiveCatalogItemFixture,
      active: false,
      lubricant: { ...lubricantDetailFixture, catalogItemId: inactiveCatalogItemFixture.id },
    };

    expect(filterCompatibleCatalogItems([inactiveMatch], spec)).toEqual([]);
  });

  it("does not offer an active item that has no lubricant-detail", () => {
    const filter = { ...catalogItemFixture, id: "cat-filter", lubricant: null };

    const offered = filterCompatibleCatalogItems([filter, motulSeed], spec);

    expect(offered.map((row) => row.id)).toEqual([motulSeed.id]);
  });

  it("offers an empty-classification lubricant on viscosity alone", () => {
    const noClassification = {
      ...catalogItemFixture,
      id: "cat-generic",
      lubricant: { catalogItemId: "cat-generic", viscosity: "5W-40", classification: "" },
    };

    const offered = filterCompatibleCatalogItems([noClassification], spec);

    expect(offered.map((row) => row.id)).toEqual([noClassification.id]);
  });

  it("offers an oil whose classification differs from the spec, and keeps that string", () => {
    // Owner decision 2026-09-09 (D13): classification is information, not a filter.
    // API grades are cumulative, so this API SP oil more than satisfies a car asking for
    // API SN — literal equality used to reject it, which is the bug this replaces.
    const laterClassification = {
      ...catalogItemFixture,
      id: "cat-seed-other",
      lubricant: {
        catalogItemId: "cat-seed-other",
        viscosity: "5W-40",
        classification: "API SP",
      },
    };
    const noClassification = {
      ...catalogItemFixture,
      id: "cat-generic",
      lubricant: { catalogItemId: "cat-generic", viscosity: "5W-40", classification: "" },
    };

    const offered = filterCompatibleCatalogItems([laterClassification, noClassification], spec);

    expect(offered.map((row) => row.id)).toEqual([laterClassification.id, noClassification.id]);
    // The string still travels to the dialog, so the attendant can judge it.
    expect(offered[0]?.lubricant.classification).toBe("API SP");
  });

  it("offers oils when the cited source stated no classification at all", () => {
    // The common case with real sources: a row giving viscosity and fill volume and no
    // certification. Comparing the catalog's string against "" rejected the whole catalog.
    const certified = {
      ...catalogItemFixture,
      id: "cat-certified",
      lubricant: {
        catalogItemId: "cat-certified",
        viscosity: "5W-40",
        classification: "API SERVICE SQ-RC, ILSAC GF-7A",
      },
    };

    const offered = filterCompatibleCatalogItems([certified], {
      viscosityGrades: ["5W-40"],
    });

    expect(offered.map((row) => row.id)).toEqual([certified.id]);
  });
});

/**
 * Added by oil-quote-liters-pricing task 3.3 (design D12).
 *
 * Oracle: specs/quotes/oil-quote/spec.md — "Catalog match is any listed SAE". A cited source may
 * list more than one grade for the same engine, and the quote must offer a card for each
 * grade the workshop actually stocks.
 *
 * Axes
 *   M1 grades listed by the source — one / two
 *   M2 how many of them the catalog stocks — both / one / neither
 *
 * Outputs: O5 which items come back
 *
 * Sampled cells (one row per `it`)
 *   two listed, both stocked | M1 two, M2 both | O5 both items |
 *      fails if the matcher stops at the first grade, which is today's products[0] bug
 *   two listed, one stocked  | M1 two, M2 one  | O5 that one   |
 *      fails if a missing grade makes the whole quote empty
 */
describe("filterCompatibleCatalogItems — several listed grades", () => {
  const thirtyGrade = {
    ...catalogItemFixture,
    id: "cat-30",
    active: true,
    lubricant: { catalogItemId: "cat-30", viscosity: "5W-30", classification: "" },
    filter: null,
  };
  const fortyGrade = {
    ...catalogItemFixture,
    id: "cat-40",
    active: true,
    lubricant: { catalogItemId: "cat-40", viscosity: "5W-40", classification: "" },
    filter: null,
  };

  it("offers a card for every listed grade the catalog stocks", () => {
    const offered = filterCompatibleCatalogItems([thirtyGrade, fortyGrade], {
      viscosityGrades: ["5W-30", "5W-40"],
    });

    expect(offered.map((item) => item.id)).toEqual(["cat-30", "cat-40"]);
  });

  it("still offers the stocked grade when the other listed grade is absent", () => {
    const offered = filterCompatibleCatalogItems([fortyGrade], {
      viscosityGrades: ["5W-30", "5W-40"],
    });

    expect(offered.map((item) => item.id)).toEqual(["cat-40"]);
  });
});

// add-lubricant-oil-type — oil-quote "The oil type is informative and never filters an offer".
describe("the oil type never filters an offer", () => {
  const at5w30 = (id: string, oilType: "SINTETICO" | "SEMISSINTETICO" | "MINERAL" | null) => ({
    ...catalogItemFixture,
    id,
    active: true,
    lubricant: { catalogItemId: id, viscosity: "5W-30", classification: "", oilType },
    filter: null,
  });
  const catalog = [at5w30("mineral", "MINERAL"), at5w30("untyped", null), at5w30("sintetico", "SINTETICO"), at5w30("semi", "SEMISSINTETICO")];

  it("offers oils of every type and none alike, in catalog order", () => {
    const withType = filterCompatibleCatalogItems(catalog, { viscosityGrades: ["5W-30"] });
    const withoutType = filterCompatibleCatalogItems(
      catalog.map((row) => ({ ...row, lubricant: { catalogItemId: row.lubricant.catalogItemId, viscosity: row.lubricant.viscosity, classification: "" } })),
      { viscosityGrades: ["5W-30"] },
    );

    expect(withType.map((item) => item.id)).toEqual(["mineral", "untyped", "sintetico", "semi"]);
    expect(withType.map((item) => item.id)).toEqual(withoutType.map((item) => item.id));
  });

  it("offers a mineral oil as the only stocked grade, so the quote is not empty", () => {
    expect(filterCompatibleCatalogItems([at5w30("mineral", "MINERAL")], { viscosityGrades: ["5W-30"] }).map((item) => item.id)).toEqual(["mineral"]);
  });
});
