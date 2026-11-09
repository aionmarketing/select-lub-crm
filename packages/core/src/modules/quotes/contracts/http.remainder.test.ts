/**
 * Test design (testing-strategy)
 *
 * Setup: zod safeParse/parse on remainder contracts. No HTTP, no DB.
 *
 * Spec: openspec/changes/shared-types-remainder/specs/shared-types/spec.md
 * (and Conversas TagSummary: inbox chips stay id/name/color only).
 *
 * Techniques: EP (one invalid class per `it`), BVA on ordered cutoffs
 * (trim().min(1), price ≥ 0, lines.min(1), sortOrder integer), branch
 * coverage of schema decisions (trim empty vs not; price negative vs
 * zero; lines empty vs ≥1; template enum vs unique refine).
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 name/text (trim then min(1)) — Customer.name, Tag.name, Template.text,
 *    OilQuote.generatedMessageText
 *   EP valid: one+ non-space chars (sampled "Ana", "A", fixtures); Customer.name null
 *   EP invalid: empty ""; whitespace-only "   " (own `it`s grouped by field)
 *   BVA: "" (below), "   " (trim→""), "A" (edge after trim)
 *
 * A2 nullable cadastro ids — Customer.omieId/taxId/unitId; Cliente columns
 *    givenName/familyName/mergedInto/street/streetNumber/neighborhood/
 *    complement/city/state/postalCode/country; Vehicle plate cluster;
 *    OilQuote.conversationId
 *   EP valid: all null; mergedInto set to a survivor id string
 *   EP invalid: omitted required keys (not sampled; zod required-field
 *    miss is contract-hidden relative to the spec scenarios)
 *
 * A3 Motul cache identity + viscosity/classification — trim min(1);
 *    required make/year/model/version; no vehicleId/brand/price
 *   EP valid: complete identity + non-empty spec strings, rawPayload null
 *   EP invalid: empty viscosity; empty classification; payload keyed by
 *    vehicleId without identity fields (own `it`s)
 *   Spec: openspec/changes/motul-compatibility-by-model/specs/shared-types/spec.md
 *
 * A4 catalog/quote price and stock — number ≥ 0
 *   BVA price: -0.01 (below) | 0 (edge) | 0.01 (above, not sampled; 89.9 fixture)
 *   BVA stock: -0.001 (below; Decimal(12,3) scale) | 0 (edge, the seeded value)
 *   EP active: true | false (both valid)
 *
 * A9 lubricant-detail (split-catalog-lubricant-detail delta) — the oil spec
 *    moved off CatalogItem onto its own row
 *   EP valid: non-empty viscosity + non-empty classification (fixture);
 *    non-empty viscosity + empty classification (matches on viscosity alone)
 *   EP invalid: empty viscosity; whitespace-only viscosity (own `it`s)
 *   Not an axis: classification has no min(1), so "" is a valid class, not an edge
 *
 * A5 quote lines length
 *   BVA: [] (below min 1) | one line (edge)
 *
 * A6 Tag vs TagSummary
 *   EP Tag: sortOrder 0 + active false + color null
 *   EP TagSummary: {id,name,color} without sortOrder/active
 *   EP invalid Tag: empty name; non-integer sortOrder 0.5
 *
 * A7 Template allowedVariables
 *   EP valid: ["nome_cliente","placa"]; [] (empty allowed list)
 *   EP invalid: unknown name; duplicate entries
 *   status: active | inactive (sampled active in fixture + validTemplate;
 *    inactive in its own `it`)
 *
 * A8 fixtures — each exported remainder fixture is a valid payload
 *
 * Outputs: O1 parse success; O2 safeParse.success === false
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * it                                              | axes        | O | fails if
 * parses customer with null Omie/tax/unit ids     | A2          | 1 | parse throws
 * parses customer with all new Cliente columns null | A2        | 1 | parse throws
 * parses customer with mergedInto set to an id    | A2          | 1 | parse throws
 * parses customer with name null                  | A1 null     | 1 | parse throws
 * rejects empty customer name                     | A1 ""       | 2 | success
 * rejects whitespace-only customer name           | A1 "   "    | 2 | success
 * parses vehicle with null plate cluster          | A2          | 1 | parse throws
 * parses Motul cache without brand or price       | A3          | 1 | has vehicleId/brand/price
 * rejects empty Motul viscosity                   | A3          | 2 | success
 * rejects empty Motul classification              | A3          | 2 | success
 * rejects Motul cache keyed only by vehicleId     | A3          | 2 | success
 * package does not depend on Motul                | A3          | — | motul in deps
 * parses catalog price 0 and stock 0 when active   | A4 edge     | 1 | parse throws
 * parses inactive catalog item                    | A4 active F | 1 | parse throws
 * rejects negative catalog price                  | A4 below    | 2 | success
 * rejects negative catalog stock                  | A4 below    | 2 | success
 * parses viscosity with empty classification      | A9 valid    | 1 | parse throws
 * rejects empty lubricant viscosity               | A9 ""       | 2 | success
 * rejects whitespace-only lubricant viscosity     | A9 "   "    | 2 | success
 * parses quote with null conversation and 1 line  | A5 edge     | 1 | parse throws
 * rejects empty quote lines                       | A5 below    | 2 | success
 * rejects whitespace generated message            | A1          | 2 | success
 * parses quote line of inactive catalog, new price| A4 snapshot | 1 | parse throws
 * parses inactive tag with sortOrder 0            | A6          | 1 | parse throws
 * rejects empty tag name                          | A1          | 2 | success
 * TagSummary parses without sortOrder or active   | A6          | 1 | parse throws
 * parses template with both allowed variables     | A7          | 1 | parse throws
 * parses template with status inactive            | A7 status F | 1 | parse throws
 * rejects empty template text                     | A1          | 2 | success
 * rejects unknown template variable               | A7          | 2 | success
 * rejects duplicate template variables            | A7          | 2 | success
 * remainder fixtures parse                        | A8          | 1 | any fixture fails
 *
 * ----------------------------------------------------------------------------
 * Decision / branch map (zod checks that are real decisions)
 * ----------------------------------------------------------------------------
 * trim().min(1) true (non-empty) — valid name/text/viscosity its
 * trim().min(1) false — empty/whitespace its
 * nullable Customer.name true — null name it
 * price nonnegative true — price 0 / fixtures; false — -0.01
 * stock nonnegative true — stock 0 / fixtures; false — -0.001
 * lubricant viscosity trim().min(1) true — "5W-40"; false — "" and "   "
 * lines.min(1) true — one-line quote; false — []
 * template enum member true — nome_cliente/placa; false — unknown
 * unique refine true — two distinct vars; false — duplicate placa
 * template status active — validTemplate; inactive — own it
 * TagSummary object keys — inbox payload without Tag fields
 *
 * Out of scope: PATCH/pending schemas (omie-sync.test.ts); Motul HTTP
 * wire types; Prisma/HTTP; every missing-required-key combo; price 0.01
 * (same partition as 0 once -0.01 is the below-edge sample).
 *
 * Split from `packages/shared-types/src/remainder.test.ts` (5.1d) by owning module;
 * this file keeps A1 (OilQuote.generatedMessageText), A3 (Motul cache), A4 (price and stock), A5 (quote lines), A9 (lubricant detail), and the every-fixture parse. The header above is the original's, whole.
 */
import { describe, expect, it } from "vitest";
import { tagFixture, tagSchema, templateFixture, templateSchema } from "../../conversations/contracts/http.js";
import { customerFixture, customerSchema, vehicleFixture, vehicleSchema } from "../../customers/contracts/http.js";
import { catalogItemSchema, lubricantDetailSchema } from "./http.catalog.js";
import { catalogItemFixture, inactiveCatalogItemFixture, lubricantDetailFixture, motulCompatibilityFixture, oilQuoteFixture } from "./http.fixtures.js";
import { motulCompatibilitySchema } from "./http.motul-compatibility.js";
import { oilQuoteSchema } from "./http.oil-quote.js";

const timestamps = {
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

function validCatalogItem() {
  return {
    id: "cat-1",
    brand: "Motul",
    description: "8100",
    price: 0,
    stock: 0,
    active: true,
    ...timestamps,
  };
}

function validLubricantDetail() {
  return {
    catalogItemId: "cat-1",
    viscosity: "5W-40",
    classification: "API SN",
    // Required-nullable since add-lubricant-oil-type; its own cases are in http.oil-type.test.ts.
    oilType: null,
  };
}

function validMotulCache() {
  return {
    id: "motul-1",
    make: "PEUGEOT",
    year: 2011,
    model: "207 Passion SW",
    version: "1.4i 8V - TU3",
    viscosityGrades: ["5W-40"],
    viscosity: "5W-40",
    classification: "API SN",
    fillLiters: 3.5,
    fillKind: "em_servico" as const,
    consultedAt: "2026-08-20T15:00:00.000Z",
    rawPayload: null,
    sourcePublisher: "Peugeot do Brasil",
    sourceDocument: "Manual do Proprietário 207 (2011)",
    sourcePage: "Seção 8 — Capacidades",
  };
}

function validQuoteLine() {
  return {
    catalogItemId: "cat-1",
    brand: "Motul",
    description: "8100",
    price: 89.9,
  };
}

function validQuote() {
  return {
    id: "quote-1",
    customerId: "cus-1",
    vehicleId: "veh-1",
    conversationId: null,
    lines: [validQuoteLine()],
    generatedMessageText: "Troca de óleo",
    createdBy: "user-1",
    ...timestamps,
  };
}

describe("MotulCompatibility", () => {
  it("parses a cache row without brand or price", () => {
    const parsed = motulCompatibilitySchema.parse(validMotulCache());
    expect(parsed).not.toHaveProperty("vehicleId");
    expect(parsed).not.toHaveProperty("brand");
    expect(parsed).not.toHaveProperty("price");
    expect(parsed.make).toBe("PEUGEOT");
    expect(parsed.year).toBe(2011);
  });

  it("rejects empty viscosity", () => {
    expect(
      motulCompatibilitySchema.safeParse({
        ...validMotulCache(),
        viscosity: "",
      }).success,
    ).toBe(false);
  });

  // Inverted 2026-09-16, deliberately. This asserted the opposite until the
  // constraint was found to contradict the data it describes: all six rows of
  // `packages/core/fixtures/oil-sources.json` carry `classification: ""`
  // truthfully, because those sources state grades and capacity and no API or
  // ACEA class. `catalog.ts`'s `lubricantDetailSchema` already documented the
  // intent in words — empty matches on viscosity alone. Restoring `min(1)`
  // would force the seed to invent a class no cited document supports.
  it("accepts an empty classification, which matches on viscosity alone", () => {
    const parsed = motulCompatibilitySchema.parse({
      ...validMotulCache(),
      classification: "",
    });

    expect(parsed.classification).toBe("");
    expect(parsed.viscosity).toBe(validMotulCache().viscosity);
  });

  it("normalises a whitespace-only classification to empty", () => {
    // So no caller mistakes "   " for a real class.
    expect(
      motulCompatibilitySchema.parse({
        ...validMotulCache(),
        classification: "   ",
      }).classification,
    ).toBe("");
  });

  it("rejects a cache row keyed only by vehicleId", () => {
    expect(
      motulCompatibilitySchema.safeParse({
        id: "motul-1",
        vehicleId: "veh-1",
        viscosity: "5W-40",
        classification: "API SN",
        consultedAt: "2026-08-20T15:00:00.000Z",
        rawPayload: null,
      }).success,
    ).toBe(false);
  });
});

describe("CatalogItem", () => {
  it("parses an active catalog item with price 0 and stock 0", () => {
    const parsed = catalogItemSchema.parse(validCatalogItem());
    expect(parsed.price).toBe(0);
    expect(parsed.stock).toBe(0);
    expect(parsed.active).toBe(true);
  });

  it("parses an inactive catalog item", () => {
    const parsed = catalogItemSchema.parse({
      ...validCatalogItem(),
      active: false,
    });
    expect(parsed.active).toBe(false);
  });

  it("rejects a negative catalog price", () => {
    expect(
      catalogItemSchema.safeParse({ ...validCatalogItem(), price: -0.01 })
        .success,
    ).toBe(false);
  });

  it("rejects a negative catalog stock", () => {
    expect(
      catalogItemSchema.safeParse({ ...validCatalogItem(), stock: -0.001 })
        .success,
    ).toBe(false);
  });
});

describe("LubricantDetail", () => {
  it("parses a viscosity with an empty classification", () => {
    const parsed = lubricantDetailSchema.parse({
      ...validLubricantDetail(),
      classification: "",
    });
    expect(parsed.viscosity).toBe("5W-40");
    expect(parsed.classification).toBe("");
  });

  it("rejects an empty viscosity", () => {
    expect(
      lubricantDetailSchema.safeParse({ ...validLubricantDetail(), viscosity: "" })
        .success,
    ).toBe(false);
  });

  it("rejects a whitespace-only viscosity", () => {
    expect(
      lubricantDetailSchema.safeParse({ ...validLubricantDetail(), viscosity: "   " })
        .success,
    ).toBe(false);
  });
});

describe("OilQuote", () => {
  it("parses a quote with a null conversation id and one frozen line", () => {
    const parsed = oilQuoteSchema.parse(validQuote());
    expect(parsed.conversationId).toBeNull();
    expect(parsed.lines).toHaveLength(1);
  });

  it("rejects empty quote lines", () => {
    expect(
      oilQuoteSchema.safeParse({ ...validQuote(), lines: [] }).success,
    ).toBe(false);
  });

  it("rejects empty or whitespace-only generated message", () => {
    expect(
      oilQuoteSchema.safeParse({ ...validQuote(), generatedMessageText: "" })
        .success,
    ).toBe(false);
    expect(
      oilQuoteSchema.safeParse({
        ...validQuote(),
        generatedMessageText: "   ",
      }).success,
    ).toBe(false);
  });

  it("parses a frozen line for an inactive catalog item at a different price", () => {
    const parsed = oilQuoteSchema.parse({
      ...validQuote(),
      lines: [
        {
          catalogItemId: inactiveCatalogItemFixture.id,
          brand: inactiveCatalogItemFixture.brand,
          description: inactiveCatalogItemFixture.description,
          price: 99.9,
        },
      ],
    });
    expect(inactiveCatalogItemFixture.active).toBe(false);
    expect(parsed.lines[0]?.catalogItemId).toBe(inactiveCatalogItemFixture.id);
    expect(parsed.lines[0]?.price).not.toBe(inactiveCatalogItemFixture.price);
  });
});

describe("remainder fixtures", () => {
  it("parses every exported remainder fixture", () => {
    expect(customerSchema.safeParse(customerFixture).success).toBe(true);
    expect(vehicleSchema.safeParse(vehicleFixture).success).toBe(true);
    expect(
      motulCompatibilitySchema.safeParse(motulCompatibilityFixture).success,
    ).toBe(true);
    expect(catalogItemSchema.safeParse(catalogItemFixture).success).toBe(true);
    expect(
      catalogItemSchema.safeParse(inactiveCatalogItemFixture).success,
    ).toBe(true);
    expect(
      lubricantDetailSchema.safeParse(lubricantDetailFixture).success,
    ).toBe(true);
    expect(oilQuoteSchema.safeParse(oilQuoteFixture).success).toBe(true);
    expect(tagSchema.safeParse(tagFixture).success).toBe(true);
    expect(templateSchema.safeParse(templateFixture).success).toBe(true);
  });
});
