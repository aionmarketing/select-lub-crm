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
 * this file keeps A1 (Customer.name), A2 (cadastro ids). The header above is the original's, whole.
 */
import { describe, expect, it } from "vitest";
import { customerSchema } from "./http.customer.js";
import { vehicleSchema } from "./http.vehicle.js";

const timestamps = {
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

function validCustomer() {
  return {
    id: "cus-1",
    name: "Ana",
    omieId: null,
    taxId: null,
    unitId: null,
    givenName: null,
    familyName: null,
    mergedInto: null,
    street: null,
    streetNumber: null,
    neighborhood: null,
    complement: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    origin: "whatsapp",
    status: "active",
    ...timestamps,
  };
}

describe("Customer", () => {
  it("parses a customer with null Omie, tax, and unit ids", () => {
    const parsed = customerSchema.parse(validCustomer());
    expect(parsed.omieId).toBeNull();
    expect(parsed.taxId).toBeNull();
    expect(parsed.unitId).toBeNull();
  });

  it("parses a customer with every new Cliente column null", () => {
    const parsed = customerSchema.parse(validCustomer());
    expect(parsed.givenName).toBeNull();
    expect(parsed.familyName).toBeNull();
    expect(parsed.mergedInto).toBeNull();
    expect(parsed.street).toBeNull();
    expect(parsed.streetNumber).toBeNull();
    expect(parsed.neighborhood).toBeNull();
    expect(parsed.complement).toBeNull();
    expect(parsed.city).toBeNull();
    expect(parsed.state).toBeNull();
    expect(parsed.postalCode).toBeNull();
    expect(parsed.country).toBeNull();
  });

  it("parses a customer with mergedInto set to a survivor id", () => {
    const parsed = customerSchema.parse({
      ...validCustomer(),
      mergedInto: "cus-survivor",
    });
    expect(parsed.mergedInto).toBe("cus-survivor");
  });

  it("parses a customer whose name is unknown (null)", () => {
    const parsed = customerSchema.parse({ ...validCustomer(), name: null });
    expect(parsed.name).toBeNull();
  });

  it("rejects an empty customer name", () => {
    expect(
      customerSchema.safeParse({ ...validCustomer(), name: "" }).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only customer name", () => {
    expect(
      customerSchema.safeParse({ ...validCustomer(), name: "   " }).success,
    ).toBe(false);
  });
});

describe("Vehicle", () => {
  it("parses a vehicle with null plate, make, model, version, year, and km", () => {
    const parsed = vehicleSchema.parse({
      id: "veh-1",
      customerId: "cus-1",
      omieId: null,
      plate: null,
      make: null,
      model: null,
      version: null,
      year: null,
      odometerKm: null,
      origin: "whatsapp",
      ...timestamps,
    });
    expect(parsed.customerId).toBe("cus-1");
    expect(parsed.plate).toBeNull();
    expect(parsed.year).toBeNull();
    expect(parsed.plateSourcedKeys).toEqual([]);
  });
});
