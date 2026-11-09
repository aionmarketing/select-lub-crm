/**
 * Test design (testing-strategy)
 *
 * Setup: zod safeParse/parse on the filter-detail, CompatibilidadeTecfil, and
 * quote-options filter contracts. No HTTP, no DB, no Tecfil call.
 *
 * Spec: openspec/changes/tecfil-filter-pricing/specs/shared-types/spec.md
 * (Filter-detail contract; CompatibilidadeTecfil is a cache row; Quote options
 * carry filter slots) and specs/tecfil-compatibility/spec.md (row content is the
 * fitment, not a price).
 *
 * Techniques: EP (one invalid class per `it`), BVA on the two ordered cutoffs the
 * new contracts add (partNumber trim().min(1); matched candidates .min(1)), and
 * branch coverage of each discriminated-union arm.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * F1 filterType vocabulary - closed enum OLEO | COMBUSTIVEL
 *   EP valid: "OLEO"; "COMBUSTIVEL"
 *   EP invalid: "AR" (a real filter kind deliberately out of scope, so the
 *    rejection is about the contract and not about a typo)
 *
 * F2 partNumber (trim then min 1)
 *   EP valid: "PEL108"; "GI50/7" (the slash survives - normalization for matching
 *    is the API's job, not the contract's)
 *   BVA: "" (below) | "   " (trim then "", below) | "P" (edge after trim, not
 *    sampled; "PEL108" stands for the valid class)
 *
 * F3 Tecfil cache identity - make/year/model/version all required, no vehicleId
 *   EP valid: complete identity, application + matchedBy, rawPayload null
 *   EP invalid: payload keyed by vehicleId with the identity fields omitted
 *
 * F4 Tecfil candidate lists - arrays that MAY be empty
 *   EP valid: one oil candidate with a cross-reference + empty fuel list;
 *    both lists empty (Tecfil lists no filter of either type)
 *   Not an axis: a non-empty list is not a cutoff here - emptiness is meaningful
 *    data on the cache row, unlike on a `matched` slot (see F6)
 *
 * F5 engine nullability - application.engine null (unanimity) vs named
 *   EP valid: null with matchedBy.engine "unanimous"; "1.4 8V" with "picked"
 *
 * F6 filter slot arm - matched / no_catalog_match / no_fitment / unavailable
 *   EP valid: each of the four arms
 *   BVA matched candidates: [] (below min 1) | one candidate (edge)
 *
 * F7 `filters` presence on an `options` result - required, not optional
 *   EP valid: options payload carrying `filters`
 *   EP invalid: options payload with oil cards and no `filters`
 *
 * F8 filters.source - cached / pending (with stopped) / unavailable / unmatched
 *   (background-oil-research D15; the reuse prompt this axis used to cover is retired)
 *   EP valid: pending with stopped false
 *   EP invalid: pending without stopped; fresh; previous_after_failure
 *
 * ----------------------------------------------------------------------------
 * Sampled cells (case | axis | would-miss)
 * ----------------------------------------------------------------------------
 * oil filter-detail parses                | F1 F2 valid | -
 * fuel filter-detail parses               | F1 valid    | OLEO hardcoded
 * rejects filterType "AR"                 | F1 invalid  | open string
 * rejects empty partNumber                | F2 below    | no min(1)
 * rejects whitespace partNumber           | F2 trim     | min(1) without trim
 * cache row with candidates parses        | F3 F4 F5    | -
 * cache row with empty lists parses       | F4 empty    | .min(1) on the lists
 * rejects vehicleId-keyed cache payload   | F3 invalid  | optional identity
 * matched slot with one candidate parses  | F6 edge     | -
 * rejects matched slot with no candidates | F6 below    | no min(1)
 * each unresolved arm parses              | F6 arms     | a missing arm
 * unmatched source names its field        | F6 F7       | required application
 * options without filters is rejected     | F7 invalid  | .optional()
 * pending source with stopped            | F8 valid    | pending not in the enum
 * pending without stopped rejected        | F8 invalid  | stopped optional for pending
 * fresh / previous_after_failure rejected | F8 invalid  | retired sources still accepted
 * every new fixture parses                | all         | a drifted fixture
 *
 * Out of scope: part-number normalization and candidate matching (they live in
 * apps/api `filters.ts`); the Tecfil wire rows and the `filtros` grammar, which
 * the shared package deliberately does not export; persistence.
 */
import { describe, expect, it } from "vitest";
import { catalogItemSchema, filterDetailSchema } from "./http.catalog.js";
import { filterCatalogItemFixture, filterDetailFixture, quoteOptionsWithFiltersFixture, tecfilCompatibilityFixture } from "./http.fixtures.js";
import { quoteFilterSlotSchema, quoteFiltersSchema, quoteOptionsResultSchema } from "./http.oil-quote.js";
import { tecfilCompatibilitySchema } from "./http.tecfil-compatibility.js";

function validFilterDetail() {
  return { catalogItemId: "cat-tecfil-pel108", filterType: "OLEO", partNumber: "PEL108" };
}

function validTecfilCache() {
  return {
    id: "tecfil-1",
    make: "PEUGEOT",
    year: 2011,
    model: "207 Passion SW",
    version: "1.4i 8V - TU3",
    application: { manufacturer: "PEUGEOT", vehicle: "207", engine: null },
    matchedBy: { manufacturer: "exact", vehicle: "picked", engine: "unanimous" },
    oilFilters: [
      {
        tecfilNumber: "PEL108",
        tecfilProductCode: 1108,
        description: "Filtro de Oleo Lubrificante",
        crossReferences: [{ brand: "AUTHOMIX", number: "FOL0108" }],
      },
    ],
    fuelFilters: [],
    consultedAt: "2026-09-03T18:00:00.000Z",
    rawPayload: null,
  };
}

function matchedOilSlot() {
  return {
    status: "matched",
    candidates: [{ ...filterCatalogItemFixture, filter: filterDetailFixture }],
  };
}

function validOptionsResult() {
  const source = {
    sourcePublisher: "Peugeot do Brasil",
    sourceDocument: "Manual do Proprietário 207 (2011)",
    sourcePage: "Seção 8 — Capacidades",
    sourceAuthority: 1,
    sourceUrl: null,
  };
  return {
    status: "options",
    viscosityGrades: ["5W-40"],
    viscosity: "5W-40",
    classification: "API SN",
    fillLiters: 3.5,
    fillKind: "em_servico",
    fillCondition: "with_filter",
    ...source,
    gradeSources: [{ grade: "5W-40", ...source }],
    litersSource: source,
    consultedAt: "2026-08-20T15:00:00.000Z",
    options: [],
    filters: {
      source: "cached",
      consultedAt: "2026-09-03T18:00:00.000Z",
      application: { manufacturer: "PEUGEOT", vehicle: "207", engine: null },
      oil: matchedOilSlot(),
      fuel: { status: "no_fitment" },
    },
  };
}

describe("filter-detail contract", () => {
  it("parses an oil filter-detail", () => {
    const parsed = filterDetailSchema.parse(validFilterDetail());

    expect(parsed.filterType).toBe("OLEO");
    expect(parsed.partNumber).toBe("PEL108");
  });

  it("parses a fuel filter-detail keeping the slash in the part number", () => {
    const parsed = filterDetailSchema.parse({
      ...validFilterDetail(),
      filterType: "COMBUSTIVEL",
      partNumber: "GI50/7",
    });

    expect(parsed.filterType).toBe("COMBUSTIVEL");
    expect(parsed.partNumber).toBe("GI50/7");
  });

  it("rejects a filter type outside the two in scope", () => {
    expect(
      filterDetailSchema.safeParse({ ...validFilterDetail(), filterType: "AR" }).success,
    ).toBe(false);
  });

  it("rejects an empty part number", () => {
    expect(
      filterDetailSchema.safeParse({ ...validFilterDetail(), partNumber: "" }).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only part number", () => {
    expect(
      filterDetailSchema.safeParse({ ...validFilterDetail(), partNumber: "   " }).success,
    ).toBe(false);
  });
});

describe("CompatibilidadeTecfil contract", () => {
  it("parses a cache row with candidates, provenance, and no price", () => {
    const parsed = tecfilCompatibilitySchema.parse(validTecfilCache());

    expect(parsed.oilFilters[0]?.crossReferences[0]?.number).toBe("FOL0108");
    expect(parsed.application.engine).toBeNull();
    expect(parsed.matchedBy.engine).toBe("unanimous");
    expect("vehicleId" in parsed).toBe(false);
    expect("price" in parsed).toBe(false);
    expect("catalogItemId" in parsed).toBe(false);
  });

  it("parses a named engine matched by the picker", () => {
    const parsed = tecfilCompatibilitySchema.parse({
      ...validTecfilCache(),
      application: { manufacturer: "PEUGEOT", vehicle: "207", engine: "1.4 8V" },
      matchedBy: { manufacturer: "exact", vehicle: "exact", engine: "picked" },
    });

    expect(parsed.application.engine).toBe("1.4 8V");
  });

  it("parses a cache row whose candidate lists are both empty", () => {
    const parsed = tecfilCompatibilitySchema.parse({
      ...validTecfilCache(),
      oilFilters: [],
      fuelFilters: [],
    });

    expect(parsed.oilFilters).toEqual([]);
    expect(parsed.fuelFilters).toEqual([]);
  });

  it("rejects a payload keyed by vehicleId instead of the identity", () => {
    const row = validTecfilCache();

    expect(
      tecfilCompatibilitySchema.safeParse({
        id: row.id,
        vehicleId: "veh-1",
        application: row.application,
        matchedBy: row.matchedBy,
        oilFilters: row.oilFilters,
        fuelFilters: row.fuelFilters,
        consultedAt: row.consultedAt,
        rawPayload: null,
      }).success,
    ).toBe(false);
  });
});

describe("quote-options filter slots", () => {
  it("parses a matched slot carrying one candidate with its filter-detail", () => {
    const parsed = quoteFilterSlotSchema.parse(matchedOilSlot());

    expect(parsed.status).toBe("matched");
    expect(parsed.status === "matched" && parsed.candidates[0]?.filter.partNumber).toBe(
      "PEL108",
    );
  });

  it("rejects a matched slot with no candidates", () => {
    expect(
      quoteFilterSlotSchema.safeParse({ status: "matched", candidates: [] }).success,
    ).toBe(false);
  });

  it("parses each unresolved slot arm", () => {
    expect(
      quoteFilterSlotSchema.parse({ status: "no_catalog_match", tecfilNumbers: ["GI50/7"] })
        .status,
    ).toBe("no_catalog_match");
    expect(quoteFilterSlotSchema.parse({ status: "no_fitment" }).status).toBe("no_fitment");
    expect(quoteFilterSlotSchema.parse({ status: "unavailable" }).status).toBe("unavailable");
  });

  it("parses an unmatched source naming the field, with no application or date", () => {
    const parsed = quoteFiltersSchema.parse({
      source: "unmatched",
      consultedAt: null,
      application: null,
      unmatchedField: "vehicle",
      oil: { status: "no_fitment" },
      fuel: { status: "no_fitment" },
    });

    expect(parsed.unmatchedField).toBe("vehicle");
    expect(parsed.application).toBeNull();
  });

  it("rejects an options result that carries oil cards and no filters", () => {
    const result = validOptionsResult();

    expect(
      quoteOptionsResultSchema.safeParse({
        status: result.status,
        viscosity: result.viscosity,
        classification: result.classification,
        consultedAt: result.consultedAt,
        options: result.options,
      }).success,
    ).toBe(false);
  });

  it("parses an options result carrying filters", () => {
    const parsed = quoteOptionsResultSchema.parse(validOptionsResult());

    expect(parsed.status === "options" && parsed.filters.oil.status).toBe("matched");
  });

  // oil-quote D11 (owner, 2026-09-25): the dialog captions each card with its grade's source.
  it("rejects an options result that names no source per grade", () => {
    const withoutGrades: Record<string, unknown> = validOptionsResult();
    delete withoutGrades.gradeSources;
    const withoutLiters: Record<string, unknown> = validOptionsResult();
    delete withoutLiters.litersSource;

    expect(quoteOptionsResultSchema.safeParse(withoutGrades).success).toBe(false);
    expect(quoteOptionsResultSchema.safeParse({ ...validOptionsResult(), gradeSources: [] }).success).toBe(false);
    expect(quoteOptionsResultSchema.safeParse(withoutLiters).success).toBe(false);
  });

  // background-oil-research D15: the quote never calls Tecfil, so the filters come from the stored
  // fitment and the identity's Tecfil state; `pending` says whether waiting can resolve it.
  it("parses a pending Tecfil source with stopped, no date and no application", () => {
    const parsed = quoteOptionsResultSchema.parse({
      ...validOptionsResult(),
      filters: { source: "pending", stopped: false, consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } },
    });

    expect(parsed.status === "options" && parsed.filters).toMatchObject({ source: "pending", stopped: false });
  });

  it("rejects a pending Tecfil source without stopped", () => {
    expect(
      quoteFiltersSchema.safeParse({ source: "pending", consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } }).success,
    ).toBe(false);
  });

  it.each(["fresh", "previous_after_failure"])("rejects the %s source the quote no longer produces", (source) => {
    expect(quoteOptionsResultSchema.safeParse({ ...validOptionsResult(), filters: { ...validOptionsResult().filters, source } }).success).toBe(false);
  });
});

describe("filter fixtures", () => {
  it("parses every exported filter and Tecfil fixture", () => {
    expect(catalogItemSchema.safeParse(filterCatalogItemFixture).success).toBe(true);
    expect(filterDetailSchema.safeParse(filterDetailFixture).success).toBe(true);
    expect(tecfilCompatibilitySchema.safeParse(tecfilCompatibilityFixture).success).toBe(
      true,
    );
    expect(
      quoteOptionsResultSchema.safeParse(quoteOptionsWithFiltersFixture).success,
    ).toBe(true);
  });
});
