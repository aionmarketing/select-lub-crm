/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse on plate-lookup contracts. No HTTP.
 *
 * Spec: three distinguishable outcomes plus unavailable; malformed plate is a
 * 422 code, not a not_found.
 *
 * Axes
 * A1 status — found / not_found / failed reasons / unavailable
 * A2 body — plate present / retry / empty plate
 * A3 (align-shipped-ui-to-pdf-artboards retrofit) plateSourcedFieldKeySchema
 *   entry — each of make/model/version/year / an excluded Veículo key
 *
 * Outputs: O1 parse ok; O2 safeParse fails
 *
 * plateSourcedFieldKeySchema is reused, not redeclared, by
 * vehicle.ts's three schemas (vehicleSchema, vehicleCreateBodySchema,
 * vehicleFieldEditSchema — see vehicle-write.test.ts), so sampling it once
 * here at its definition covers the element type for all three; only each
 * schema's own integration (does it still use this exact element schema)
 * needs a separate, smaller sample there.
 *
 * Oracle: openspec/specs/plate-lookup/plate-lookup/spec.md "Fields a lookup fills are
 * marked plate-sourced" — "The mark SHALL cover make, model, version and
 * year only — plate is the key the lookup was made from, and odometerKm is
 * never returned by a lookup."
 */
import { describe, expect, it } from "vitest";
import { invalidPlateErrorSchema, plateLookupBodySchema, plateLookupResponseSchema, plateSourcedFieldKeySchema } from "./http.plate-lookup.js";

describe("plateLookupBodySchema", () => {
  it("parses a plate and an optional retry flag", () => {
    expect(plateLookupBodySchema.parse({ plate: "abc-1d23" }).plate).toBe("abc-1d23");
    expect(plateLookupBodySchema.parse({ plate: "ABC1D23", retry: true }).retry).toBe(true);
  });

  it("rejects an empty plate", () => {
    expect(plateLookupBodySchema.safeParse({ plate: "" }).success).toBe(false);
  });
});

describe("plateLookupResponseSchema", () => {
  it("parses found, not_found, failed and unavailable as distinct shapes", () => {
    expect(
      plateLookupResponseSchema.parse({
        status: "found",
        source: "provider",
        provider: "agregados-propria",
        cached: false,
        fields: { make: "VW", year: 2021 },
      }).status,
    ).toBe("found");
    expect(
      plateLookupResponseSchema.parse({
        status: "not_found",
        source: "provider",
        provider: "placas",
        cached: true,
        lookedUpAt: "2026-09-05T12:00:00.000Z",
        recordedOutcome: "miss",
      }).status,
    ).toBe("not_found");
    expect(
      plateLookupResponseSchema.parse({
        status: "failed",
        reason: "exhausted_balance",
      }),
    ).toEqual({ status: "failed", reason: "exhausted_balance" });
    expect(plateLookupResponseSchema.parse({ status: "unavailable" })).toEqual({
      status: "unavailable",
    });
  });

  it("parses the malformed-plate error body", () => {
    expect(invalidPlateErrorSchema.parse({ code: "invalid_plate" }).code).toBe("invalid_plate");
  });
});

describe("plateSourcedFieldKeySchema", () => {
  it.each(["make", "model", "version", "year"] as const)("accepts %s", (key) => {
    expect(plateSourcedFieldKeySchema.parse(key)).toBe(key);
  });

  it.each(["plate", "odometerKm"])(
    "rejects %s — the lookup never marks it plate-sourced",
    (key) => {
      expect(plateSourcedFieldKeySchema.safeParse(key).success).toBe(false);
    },
  );
});
