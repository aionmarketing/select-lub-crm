/**
 * Test design (testing-strategy)
 *
 * Setup: `hasAnyField` and `foundOrNotFound` plus a hand-written fake provider,
 * no HTTP and no fixtures.
 *
 * Spec: openspec/specs/plate-lookup/plate-lookup/spec.md
 * — "Unknown fields are omitted, never invented" (a lookup yielding no usable
 * field reports not-found carrying no values) and "The fallback provider runs
 * only when the primary does not answer" (a failure is distinguishable from a
 * miss).
 *
 * Techniques: EP over the three outcome shapes; BVA on the field count, whose
 * boundary between `not_found` and `found` is exactly one present field.
 *
 * Axes
 * A1 field presence
 *   EP none: every key absent, and the empty object
 *   EP one: a single field present (the boundary)
 *   EP many: several fields present
 * A2 source
 *   EP provider (billed)
 *   EP mock (not billed)
 *
 * Outputs: O1 `found` with fields; O2 `not_found`; O3 `failed` with a reason
 *
 * Sampled-cell table
 * it                                            | axes          | O | fails if
 * reports no usable field as not_found          | A1 none       | 2 | found
 * treats an explicit undefined as absent        | A1 none       | 2 | found
 * promotes a single present field to found      | A1 one BVA    | 1 | not_found
 * carries every present field through           | A1 many       | 1 | field dropped
 * keeps the raw payload on found                | A1 many       | 1 | raw missing
 * omits raw when the caller passes none         | A1 many+A2 mock| 1 | raw present
 * marks a mock result unbilled and sourced mock | A2 mock       | 1 | billed true
 * a fake expresses all three outcomes           | A1+A2 all     |1,2,3| shape mismatch
 *
 * Decision / branch map (`foundOrNotFound`)
 * D1 hasAnyField  T: returns found; F: returns not_found
 *
 * Out of scope: type-level rejection of a hand-built `found` with no fields.
 * The invariant is enforced at runtime here instead, because an AtLeastOne
 * generic is the kind of type gymnastics `.claude/rules/typing-discipline.md`
 * rules out; every adapter routes through `foundOrNotFound`.
 */
import { describe, expect, it } from "vitest";
import {
  foundOrNotFound,
  hasAnyField,
  type LookupResult,
  type PlateProvider,
} from "./port.js";

const provider = { source: "provider", provider: "test-vendor", billed: true } as const;
const mock = { source: "mock", provider: "mock", billed: false } as const;

describe("hasAnyField", () => {
  it("is false for an empty field set", () => {
    expect(hasAnyField({})).toBe(false);
  });

  it("is false when every key is explicitly undefined", () => {
    expect(hasAnyField({ make: undefined, year: undefined })).toBe(false);
  });

  it("is true for a single present field", () => {
    expect(hasAnyField({ make: "VW" })).toBe(true);
  });
});

describe("foundOrNotFound", () => {
  it("reports no usable field as not_found", () => {
    const result = foundOrNotFound({}, provider);
    expect(result.status).toBe("not_found");
    expect(result).not.toHaveProperty("fields");
  });

  it("treats an explicitly undefined field as absent", () => {
    expect(foundOrNotFound({ version: undefined }, provider).status).toBe("not_found");
  });

  it("promotes a single present field to found", () => {
    const result = foundOrNotFound({ make: "VW" }, provider);
    expect(result).toMatchObject({ status: "found", fields: { make: "VW" } });
  });

  it("carries every present field through", () => {
    const fields = {
      make: "VW",
      model: "GOL",
      version: "1.0 FLEX 12V 4P",
      year: 2021,
      displacementCc: 999,
      fuel: "ALCOOL/GASOLINA",
    };
    expect(foundOrNotFound(fields, provider)).toMatchObject({ status: "found", fields });
  });

  it("keeps the raw payload on found", () => {
    const raw = { marca: "VW" };
    const result = foundOrNotFound({ make: "VW" }, provider, raw);
    expect(result).toMatchObject({ status: "found", raw });
  });

  it("marks a mock result unbilled and sourced mock", () => {
    expect(foundOrNotFound({ make: "VW" }, mock)).toMatchObject({
      status: "found",
      source: "mock",
      billed: false,
    });
  });
});

describe("PlateProvider", () => {
  it("lets a fake express all three outcomes", async () => {
    const results: Record<string, LookupResult> = {
      AAA1A11: foundOrNotFound({ make: "VW" }, provider),
      BBB2B22: foundOrNotFound({}, provider),
      CCC3C33: {
        status: "failed",
        provider: "test-vendor",
        billed: false,
        reason: "exhausted_balance",
        billedCalls: [],
      },
    };
    const fake: PlateProvider = {
      name: "test-vendor",
      lookup: async (plate) =>
        results[plate] ?? {
          status: "failed",
          provider: "test-vendor",
          billed: false,
          reason: "provider_error",
          billedCalls: [],
        },
    };

    expect((await fake.lookup("AAA1A11")).status).toBe("found");
    expect((await fake.lookup("BBB2B22")).status).toBe("not_found");
    expect(await fake.lookup("CCC3C33")).toMatchObject({
      status: "failed",
      reason: "exhausted_balance",
      billed: false,
    });
  });
});
