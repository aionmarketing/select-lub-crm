/**
 * ============================================================================
 * TEST DESIGN STRATEGY: resolveOil catalog chain
 * ============================================================================
 *
 * Setup: `resolveOil(params)` with `globalThis.fetch` replaced. Motul is never
 * contacted. Pathname picks the fake JSON (brands / models / types / vehicle).
 *
 * Techniques in THIS file: EP of the discriminated status, decision coverage
 * of resolveOil's `if`s, BVA none (catalog strings / missing vs present).
 *
 * Spec: openspec/specs/quotes/motul-recommendation/spec.md — Discriminated oil
 * resolution. Matching ignores case, diacritics, and non-alphanumerics.
 * Catalog category for brands is CAR (opaque identifier chain).
 *
 * Axis — how far the caller filled the chain (each step needs vs unmatched):
 *   missing field → needs + options
 *   value not in catalog → unmatched + options
 *   all four match + usable flatten → ok
 *   flatten null OR fetch throws → unavailable
 *
 * Decisions in resolveOil (D1–D9 true and false; catch D10):
 *   D1 !brand          D2 !matchedBrand
 *   D3 !year           D4 year not in list
 *   D5 !model          D6 !matchedModel
 *   D7 !submodel       D8 !matchedSubModel
 *   D9 !recommendation D10 catch → unavailable
 *
 * | Params                         | D taken T     | Out          | `it`                                      |
 * |:-------------------------------|:--------------|:-------------|:------------------------------------------|
 * | {}                             | D1            | needs brand  | asks for brand options when brand omitted |
 * | brand=ZZZ                      | D1 F, D2      | unmatched    | unmatched brand lists catalog options     |
 * | CHEVROLET, no year             | D3            | needs year   | asks for year options when year omitted   |
 * | CHEVROLET + 1999               | D4            | unmatched    | unmatched year lists catalog years        |
 * | CHEVROLET+2012, no model       | D5            | needs model  | asks for model options when model omitted |
 * | …+Uno                          | D6            | unmatched    | unmatched model lists catalog models      |
 * | …+Captiva, no submodel         | D7            | needs sub    | asks for submodel options when omitted    |
 * | …+Captiva+Nope                 | D8            | unmatched    | unmatched submodel lists catalog types    |
 * | full match (simple.json)       | all F until ok| ok           | returns flattened recommendation when matched |
 * | full match, empty components   | D9            | unavailable  | unavailable when flatten returns null     |
 * | TypeError on brands            | D10           | unavailable  | unavailable when Motul HTTP throws        |
 * | category CAR                   | (query)       | —            | requests vehicle brands with category CAR |
 * | chèvrolet vs CHEVROLET (GM)    | D2 F          | needs year   | matches brand ignoring case and diacritics|
 *
 * Fails if: status/field wrong, options omit the seeded catalog value, ok
 * invents a product, unavailable throws, categoryId is not CAR.
 *
 * Out of scope: live Motul HTTP; every vehicle Motul sells.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resetMotulBreaker } from "./client.js";
import { resolveOil } from "./resolver.js";
import type { MotulRecommendation } from "./wire.js";

const originalFetch = globalThis.fetch;
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "./fixtures");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loadVehicle(name: string): MotulRecommendation {
  const raw = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as {
    vehicle: MotulRecommendation;
  };
  return raw.vehicle;
}

const catalog = {
  brands: [{ id: "b1", name: "CHEVROLET (GM)", years: ["2012"] }],
  models: [{ id: "m1", name: "Captiva" }],
  types: [{ id: "s1", name: "2.4L SIDI ECOTEC" }],
};

function fakeMotul(options?: {
  vehicle?: MotulRecommendation | null;
  fail?: boolean;
}) {
  return async (input: Parameters<typeof fetch>[0]) => {
    if (options?.fail) throw new TypeError("fetch failed");
    const url = input instanceof URL ? input : new URL(String(input));
    const path = url.pathname;
    if (path.includes("vehicle-brands")) {
      return jsonResponse(200, { brands: catalog.brands });
    }
    if (path.includes("vehicle-models")) {
      return jsonResponse(200, { models: catalog.models });
    }
    if (path.includes("vehicle-types")) {
      return jsonResponse(200, { types: catalog.types });
    }
    if (path.includes("recommendations")) {
      const vehicle = options?.vehicle === undefined
        ? loadVehicle("simple.json")
        : options.vehicle;
      return jsonResponse(200, { vehicle });
    }
    return jsonResponse(404, { error: "unexpected path" });
  };
}

describe("resolveOil catalog category", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("requests vehicle brands with category CAR", async () => {
    let requested: URL | undefined;
    globalThis.fetch = async (input) => {
      requested = input instanceof URL ? input : new URL(String(input));
      return jsonResponse(200, { brands: [] });
    };

    await resolveOil({});

    expect(requested?.pathname).toContain("vehicle-brands");
    expect(requested?.searchParams.get("categoryId")).toBe("CAR");
  });
});

describe("resolveOil decisions", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("asks for brand options when brand omitted", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({});

    expect(result).toEqual({
      status: "needs",
      field: "brand",
      options: ["CHEVROLET (GM)"],
    });
  });

  it("unmatched brand lists catalog options", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({ brand: "ZZZ" });

    expect(result).toEqual({
      status: "unmatched",
      field: "brand",
      options: ["CHEVROLET (GM)"],
    });
  });

  it("matches brand ignoring case and diacritics", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({ brand: "chèvrolet (gm)" });

    expect(result).toMatchObject({ status: "needs", field: "year" });
    if (result.status === "needs") {
      expect(result.options).toEqual(["2012"]);
    }
  });

  it("asks for year options when year omitted", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({ brand: "CHEVROLET (GM)" });

    expect(result).toEqual({
      status: "needs",
      field: "year",
      options: ["2012"],
    });
  });

  it("unmatched year lists catalog years", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({ brand: "CHEVROLET (GM)", year: "1999" });

    expect(result).toEqual({
      status: "unmatched",
      field: "year",
      options: ["2012"],
    });
  });

  it("asks for model options when model omitted", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({ brand: "CHEVROLET (GM)", year: "2012" });

    expect(result).toEqual({
      status: "needs",
      field: "model",
      options: ["Captiva"],
    });
  });

  it("unmatched model lists catalog models", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({
      brand: "CHEVROLET (GM)",
      year: "2012",
      model: "Uno",
    });

    expect(result).toEqual({
      status: "unmatched",
      field: "model",
      options: ["Captiva"],
    });
  });

  it("asks for submodel options when submodel omitted", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({
      brand: "CHEVROLET (GM)",
      year: "2012",
      model: "Captiva",
    });

    expect(result).toEqual({
      status: "needs",
      field: "submodel",
      options: ["2.4L SIDI ECOTEC"],
    });
  });

  it("unmatched submodel lists catalog types", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({
      brand: "CHEVROLET (GM)",
      year: "2012",
      model: "Captiva",
      submodel: "2.0",
    });

    expect(result).toEqual({
      status: "unmatched",
      field: "submodel",
      options: ["2.4L SIDI ECOTEC"],
    });
  });

  it("returns flattened recommendation when matched", async () => {
    globalThis.fetch = fakeMotul();

    const result = await resolveOil({
      brand: "CHEVROLET (GM)",
      year: "2012",
      model: "Captiva",
      submodel: "2.4L SIDI ECOTEC",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.recommendation.vehicle).toContain("CHEVROLET (GM)");
      expect(result.recommendation.vehicle).toContain("Captiva");
      expect(result.recommendation.vehicle).toContain("2.4L SIDI ECOTEC");
      expect(result.recommendation.vehicle).toContain("2012");
      expect(result.recommendation.parts.motor).toBeDefined();
    }
  });

  it("unavailable when flatten returns null", async () => {
    globalThis.fetch = fakeMotul({
      vehicle: { ...loadVehicle("simple.json"), components: [] },
    });

    const result = await resolveOil({
      brand: "CHEVROLET (GM)",
      year: "2012",
      model: "Captiva",
      submodel: "2.4L SIDI ECOTEC",
    });

    expect(result).toEqual({ status: "unavailable" });
  });

  it("unavailable when Motul HTTP throws", async () => {
    globalThis.fetch = fakeMotul({ fail: true });

    const result = await resolveOil({ brand: "CHEVROLET (GM)" });

    expect(result).toEqual({ status: "unavailable" });
  });
});

/**
 * Added by oil-quote-retrieval-hardening task 2.3.
 *
 * Oracle: specs/quotes/motul-client-resilience/spec.md — "The failure returned while the breaker is
 * open SHALL still map to `{ status: "unavailable" }` in the resolver, so the oil-quote
 * dialog can keep offering the previous cache row."
 *
 * The one cell worth sampling: `unavailable` is load-bearing downstream. It is what lets the
 * dialog offer a previous row, and it is distinct from `none` ("this car is not covered"),
 * which offers nothing. A breaker that produced any other shape would silently turn a
 * known-down gateway into a car nobody has data for.
 */
describe("resolveOil with the breaker open", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetMotulBreaker();
  });

  it("reports unavailable without sending a request", async () => {
    resetMotulBreaker();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    };

    // Three exhausted cycles open it.
    for (let i = 0; i < 3; i += 1) {
      await resolveOil({ brand: "Fiat", year: "2021", model: "Argo", submodel: "1.0" });
    }
    const afterOpen = calls;

    const result = await resolveOil({ brand: "Fiat", year: "2021", model: "Argo", submodel: "1.0" });

    expect(result.status).toBe("unavailable");
    expect(calls).toBe(afterOpen);
  });
});
