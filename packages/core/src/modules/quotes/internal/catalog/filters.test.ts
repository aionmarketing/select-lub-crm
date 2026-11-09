/**
 * Test design (testing-strategy)
 *
 * SUT: filterCandidatesFor / normalizePartNumber (apps/api/src/oil-quote/filters.ts).
 *
 * Oracle: oil-quote spec "Filter prices come from the Tecfil fitment" (delta
 * tecfil-filter-pricing) and design D8 — an offerable item is an ACTIVE catalog
 * row with a filter-detail OF THE ASKED TYPE whose part number, normalized to
 * uppercase alphanumerics, equals a fitted Tecfil number or one of that part's
 * cross-reference numbers. Brand is never compared.
 *
 * Axes (independent inputs; each is yes/no, so no BVA rows)
 *   A1 which list the number came from — Tecfil's own vs a cross-reference
 *   A2 punctuation in the two numbers — none vs `/` on one side only
 *   A3 row.active — true vs false
 *   A4 row detail — filter-detail vs lubricant-detail vs neither
 *   A5 row.filter.filterType vs asked type — equal vs different
 *   A6 candidate list — non-empty vs empty (output-domain edge: nothing can match)
 *
 * Outputs: O1 row offered; O2 row not offered (empty list)
 *
 * Sampled cells (one row per `it`)
 *   Tecfil number equal          | A1 own, A2 none     | O1 | fails if the own number is not consulted
 *   cross-reference equal        | A1 xref, A2 none    | O1 | fails if crossReferences are ignored
 *   `GI50/7` vs `GI507`          | A2 slash one side   | O1 | fails if normalization drops out
 *   inactive row                 | A3 false            | O2 | fails if `active` is not gated
 *   lubricant row                | A4 lubricant        | O2 | fails if a null filter-detail matches
 *   fuel detail, oil asked       | A5 different        | O2 | fails if the type is not compared
 *   empty candidate list         | A6 empty            | O2 | fails if an empty `wanted` set matches anything
 *   normalizePartNumber cases    | A2 both directions  | —  | fails if case/punctuation survive the key
 *
 * Decision map of filterCandidatesFor
 *   `wanted.size === 0`      true: empty-list test           false: every other test
 *   `!row.active`            true: inactive test             false: the match tests
 *   `row.filter == null`     true: lubricant test            false: the match tests
 *   `filterType !== type`    true: type-mismatch test        false: the match tests
 *   `wanted.has(...)`        true: the match tests           false: inactive/lubricant/type tests reach it via other rows in the same catalog
 *   numbersOf `filter("")`   true (kept): every test         false (dropped): the blank-number row in the empty-string test
 *
 * Out of scope: catalog ordering beyond "input order preserved" (no spec statement);
 * Prisma/memory adapters (memory.test.ts); slot assembly (options.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { TecfilFilterCandidate } from "../../contracts/http.js";
import { filterCandidatesFor, normalizePartNumber } from "../catalog/filters.js";
import type { CatalogRow } from "../store/store.js";

const timestamps = {
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function filterRow(
  id: string,
  partNumber: string,
  filterType: "OLEO" | "COMBUSTIVEL",
  active = true,
): CatalogRow {
  return {
    id,
    brand: "Qualquer",
    description: `Filtro ${partNumber}`,
    price: 32,
    stock: 0,
    active,
    ...timestamps,
    lubricant: null,
    filter: { catalogItemId: id, filterType, partNumber },
  };
}

const lubricantRow: CatalogRow = {
  id: "cat-oil",
  brand: "Motul",
  description: "8100 X-cess PEL108",
  price: 89.9,
  stock: 0,
  active: true,
  ...timestamps,
  lubricant: { catalogItemId: "cat-oil", viscosity: "5W-40", classification: "API SN", oilType: null },
  filter: null,
};

const pel108: TecfilFilterCandidate = {
  tecfilNumber: "PEL108",
  tecfilProductCode: 1108,
  description: "Filtro de Oleo Lubrificante",
  crossReferences: [{ brand: "AUTHOMIX", number: "FOL0108" }],
};

const gi507: TecfilFilterCandidate = {
  tecfilNumber: "GI50/7",
  tecfilProductCode: 5007,
  description: "Filtro de Combustivel",
  crossReferences: [],
};

describe("normalizePartNumber", () => {
  it.each([
    { input: "GI50/7", expected: "GI507" }, // punctuation dropped
    { input: "gi 50-7", expected: "GI507" }, // case folded, spaces and dashes dropped
    { input: "PEL108", expected: "PEL108" }, // already normalized
    { input: "///", expected: "" }, // no letters or digits left
  ])("turns $input into $expected", ({ input, expected }) => {
    expect(normalizePartNumber(input)).toBe(expected);
  });
});

describe("filterCandidatesFor", () => {
  it("offers the item whose number is the fitted Tecfil number", () => {
    const catalog = [filterRow("cat-tecfil-pel108", "PEL108", "OLEO")];

    const offered = filterCandidatesFor("OLEO", [pel108], catalog);

    expect(offered.map((row) => row.id)).toEqual(["cat-tecfil-pel108"]);
  });

  it("offers another brand's item through a cross-reference number", () => {
    const catalog = [filterRow("cat-authomix-fol0108", "FOL0108", "OLEO")];

    const offered = filterCandidatesFor("OLEO", [pel108], catalog);

    expect(offered.map((row) => row.id)).toEqual(["cat-authomix-fol0108"]);
  });

  it("matches GI50/7 against a catalog number written GI507", () => {
    const catalog = [filterRow("cat-gi507", "GI507", "COMBUSTIVEL")];

    const offered = filterCandidatesFor("COMBUSTIVEL", [gi507], catalog);

    expect(offered.map((row) => row.id)).toEqual(["cat-gi507"]);
  });

  it("does not offer an inactive item", () => {
    const catalog = [filterRow("cat-inactive", "GI50/7", "COMBUSTIVEL", false)];

    const offered = filterCandidatesFor("COMBUSTIVEL", [gi507], catalog);

    expect(offered).toEqual([]);
  });

  it("does not offer a lubricant whose description carries the number", () => {
    const catalog = [lubricantRow];

    const offered = filterCandidatesFor("OLEO", [pel108], catalog);

    expect(offered).toEqual([]);
  });

  it("does not offer a fuel-filter item for the oil slot", () => {
    const catalog = [filterRow("cat-wrong-type", "PEL108", "COMBUSTIVEL")];

    const offered = filterCandidatesFor("OLEO", [pel108], catalog);

    expect(offered).toEqual([]);
  });

  it("offers nothing when Tecfil fitted no part of that type", () => {
    const catalog = [filterRow("cat-tecfil-pel108", "PEL108", "OLEO")];

    const offered = filterCandidatesFor("OLEO", [], catalog);

    expect(offered).toEqual([]);
  });

  it("ignores a catalog number that normalizes to nothing", () => {
    const blank = filterRow("cat-blank", "///", "OLEO");
    const catalog = [blank, filterRow("cat-tecfil-pel108", "PEL108", "OLEO")];

    const offered = filterCandidatesFor("OLEO", [pel108], catalog);

    expect(offered.map((row) => row.id)).toEqual(["cat-tecfil-pel108"]);
  });
});
