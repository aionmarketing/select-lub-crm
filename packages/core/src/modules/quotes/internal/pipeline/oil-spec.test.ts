/**
 * Test design (testing-strategy)
 *
 * SUT: resolveOilSpec and its deterministic helpers (internal/pipeline/oil-spec.ts).
 *
 * Split by topic under the 300-line cap (adopt-modular-vertical-slices 2B.1). This file
 * holds the core resolution: grounding, Motul payloads, SAE normalisation. Refusal signals
 * are in oil-spec.refusals.test.ts; source handling in oil-spec.sources.test.ts.
 *
 * Setup: both ports are injected fakes (D8). No HTTP, no Motul, no model, no web search.
 * Every fake records its calls, because several rules here are about a call NOT happening.
 *
 * Oracle: oil-quote-liters-pricing D8, D10, D12 and specs/quotes/oil-quote/spec.md — "Engine fill
 * liters come from a retrieved reputable source" (grounded only; service fill; the LLM does
 * not pick a catalog oil) and "Ambiguous engine is clarification".
 *
 * Axes
 *   R1 retrieve outcome — found with sources / none / unavailable / needs_clarification
 *   R2 extractor answer — full spec / grades but no capacity / null (source silent)
 *   R3 source content kind — motul_flatten (deterministic) / text (model-backed)
 *   R4 grade count in the source — one / several (D12: never collapsed)
 *   R5 capacity legend in a Motul payload — em serviço + seco / unlabeled singleton /
 *      seco only (the deliberate case: a real legend that must not become a multiplier)
 *   R6 extracted liters plausibility — inside bounds / above MAX_PLAUSIBLE_FILL_LITERS
 *
 * Outputs
 *   O1 verified spec (grades, liters, kind, citation)
 *   O2 no_spec
 *   O3 needs_clarification with the options
 *   O5 unavailable (adapters down, distinct from a car simply not covered)
 *   O4 whether the extractor was called at all
 *
 * Sampled cells (one row per `it`)
 *   found + text + two grades       | R1,R3,R4 | O1 | fails if the list is collapsed to one
 *   found + flatten + two products  | R3,R4    | O1 | fails if only products[0] is read
 *   found + flatten seco only       | R5       | O1 liters null | fails if 6,5 L prices a card
 *   none                            | R1       | O2,O4 not called | fails if the model is
 *      asked to supply a spec with no document in hand — the memory-answer path
 *   unavailable                     | R1       | O5 unavailable, O4 not called
 *   needs_clarification             | R1       | O3 | fails if the first engine is chosen
 *   extractor returns null          | R2       | O2 | fails if a silent source becomes a spec
 *   liters 90                       | R6       | O1 liters null | fails if a drum volume prices
 *
 * Out of scope: the model HTTP call itself (spec-extractor.ts owns the provider wiring; D8
 * forbids exercising it here); cache reuse and catalog matching (options.test.ts); BRL
 * rounding (apps/web).
 */
import { describe, expect, it, vi } from "vitest";
import type { FlatRecommendation } from "../../../../kernel/clients/motul/index.js";
import {
  createOilSpecExtractor,
  extractFromMotulFlatten,
  motulViscosityGrades,
  normalizeSaeGrades,
  resolveOilSpec,
  validateExtractedSpec,
} from "./oil-spec.js";
import type {
  AuthoritativeSourceRetriever,
  ExtractedOilSpec,
  OilSpecExtractor,
  RetrieveResult,
  RetrievedSource,
} from "./oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = {
  make: "Volkswagen",
  year: 2014,
  model: "Polo",
  version: "1.6 MSI",
};

const citation = {
  publisher: "Volkswagen do Brasil",
  document: "Manual do Proprietário Polo (2014)",
  page: "Seção 10 — Capacidades",
};

function textSource(text: string): RetrievedSource {
  return { ...citation, content: { kind: "text", text } };
}

function flattenSource(parts: FlatRecommendation["parts"]): RetrievedSource {
  return {
    ...citation,
    content: { kind: "motul_flatten", recommendation: { vehicle: "fixture", parts } },
  };
}

function retrieverReturning(result: RetrieveResult) {
  return vi.fn<AuthoritativeSourceRetriever>().mockResolvedValue(result);
}

function extractorReturning(spec: ExtractedOilSpec | null) {
  return vi.fn<OilSpecExtractor>().mockResolvedValue(spec);
}

describe("resolveOilSpec — grounding", () => {
  it("verifies a spec a cited passage states, keeping every listed grade", async () => {
    const retrieve = retrieverReturning({
      status: "found",
      sources: [textSource("Use 5W-30 ou 5W-40. Capacidade com filtro: 4,2 litros.")],
    });
    const extract = extractorReturning({
      viscosityGrades: ["5W-30", "5W-40"],
      classification: "VW 502 00",
      fillLiters: 4.2,
      fillKind: "em_servico",
    });

    const result = await resolveOilSpec(identity, { retrieve, extract });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error("expected a verified spec");
    }
    expect(result.viscosityGrades).toEqual(["5W-30", "5W-40"]);
    expect(result.fillLiters).toBe(4.2);
    expect(result.fillKind).toBe("em_servico");
    expect(result.citation).toEqual(citation);
  });

  it("does not extract when no adapter returned a source", async () => {
    const retrieve = retrieverReturning({ status: "none" });
    const extract = extractorReturning({
      viscosityGrades: ["5W-30"],
      classification: "API SP",
      fillLiters: 4,
      fillKind: "em_servico",
    });

    const result = await resolveOilSpec(identity, { retrieve, extract });

    expect(result.status).toBe("no_spec");
    // The memory-answer path: with nothing retrieved there is nothing to read, so the
    // extractor must never be given the chance to answer from what it already knows.
    expect(extract).not.toHaveBeenCalled();
  });

  it("reports unavailable, not no_spec, when every adapter was down", async () => {
    const retrieve = retrieverReturning({ status: "unavailable" });
    const extract = extractorReturning(null);

    const result = await resolveOilSpec(identity, { retrieve, extract });

    // Kept apart from no_spec: only this outcome may fall back to a previous cache row.
    expect(result.status).toBe("unavailable");
    expect(extract).not.toHaveBeenCalled();
  });

  it("misses when the retrieved source states no spec", async () => {
    const retrieve = retrieverReturning({
      status: "found",
      sources: [textSource("Este capítulo trata da pressão dos pneus.")],
    });
    const extract = extractorReturning(null);

    const result = await resolveOilSpec(identity, { retrieve, extract });

    expect(result.status).toBe("no_spec");
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("misses when the extracted grades are not SAE at all", async () => {
    const retrieve = retrieverReturning({
      status: "found",
      sources: [textSource("Óleo recomendado: consulte a concessionária.")],
    });
    const extract = extractorReturning({
      viscosityGrades: ["consulte a concessionária"],
      classification: "",
      fillLiters: 4,
      fillKind: "em_servico",
    });

    const result = await resolveOilSpec(identity, { retrieve, extract });

    expect(result.status).toBe("no_spec");
  });

  it("asks for clarification instead of choosing the first engine", async () => {
    const retrieve = retrieverReturning({
      status: "needs_clarification",
      options: ["1.6 MSI", "1.6 MSI Flex"],
    });
    const extract = extractorReturning(null);

    const result = await resolveOilSpec(identity, { retrieve, extract });

    // Motul's "more than one engine matches" is `several` (background-oil-research D10).
    expect(result).toEqual({
      status: "needs_clarification",
      coverage: "several",
      options: ["1.6 MSI", "1.6 MSI Flex"],
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("keeps a grade-only spec so the caller can show the missing-volume state", async () => {
    const retrieve = retrieverReturning({
      status: "found",
      sources: [textSource("Viscosidade: 5W-30.")],
    });
    const extract = extractorReturning({
      viscosityGrades: ["5W-30"],
      classification: "API SP",
      fillLiters: null,
      fillKind: null,
    });

    const result = await resolveOilSpec(identity, { retrieve, extract });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error("expected a verified spec");
    }
    expect(result.viscosityGrades).toEqual(["5W-30"]);
    expect(result.fillLiters).toBeNull();
  });

  it("drops a volume too large to be a crankcase", async () => {
    const retrieve = retrieverReturning({
      status: "found",
      sources: [textSource("Embalagem de 90 litros. Viscosidade 5W-30.")],
    });
    const extract = extractorReturning({
      viscosityGrades: ["5W-30"],
      classification: "",
      fillLiters: 90,
      fillKind: "em_servico",
    });

    const result = await resolveOilSpec(identity, { retrieve, extract });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error("expected a verified spec");
    }
    expect(result.fillLiters).toBeNull();
    expect(result.fillKind).toBeNull();
  });
});

describe("Motul payloads are read deterministically", () => {
  const twoProducts: FlatRecommendation["parts"] = {
    Motor: {
      capacities: [
        { volume: "6,5", note: "Volume seco." },
        { volume: "4,20", note: "Volume em serviço." },
      ],
      products: [
        { name: "8100 X-cess 5W-40", code: "a", recOrder: 1, spec: "API SN" },
        { name: "6100 Synergie+ 5W-30", code: "b", recOrder: 2, spec: "API SP" },
      ],
    },
  };

  it("collects every motor product's grade, not only the first", () => {
    expect(motulViscosityGrades({ vehicle: "fixture", parts: twoProducts })).toEqual([
      "5W-40",
      "5W-30",
    ]);
  });

  it("supplies service-fill liters without any model call", async () => {
    const textExtractor = vi.fn<OilSpecExtractor>().mockResolvedValue(null);
    const extract = createOilSpecExtractor(textExtractor);

    const result = await resolveOilSpec(identity, {
      retrieve: retrieverReturning({
        status: "found",
        sources: [flattenSource(twoProducts)],
      }),
      extract,
    });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error("expected a verified spec");
    }
    expect(result.fillLiters).toBe(4.2);
    expect(result.fillKind).toBe("em_servico");
    expect(result.viscosityGrades).toEqual(["5W-40", "5W-30"]);
    // A structured payload is parsed in code, so the model is never in this path.
    expect(textExtractor).not.toHaveBeenCalled();
  });

  it("records dry fill but refuses it as the multiplier", async () => {
    const dryOnly: FlatRecommendation["parts"] = {
      Motor: {
        capacities: [{ volume: "6,5", note: "Volume seco." }],
        products: [{ name: "8100 X-cess 5W-40", code: "a", recOrder: 1, spec: "API SN" }],
      },
    };

    const result = await resolveOilSpec(identity, {
      retrieve: retrieverReturning({ status: "found", sources: [flattenSource(dryOnly)] }),
      extract: createOilSpecExtractor(vi.fn<OilSpecExtractor>().mockResolvedValue(null)),
    });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") {
      throw new Error("expected a verified spec");
    }
    expect(result.fillLiters).toBeNull();
    expect(result.dryFillLiters).toBe(6.5);
    // D5: the attendant is told a dry volume was found, and that a change does not use it.
    expect(result.unusableFill).toEqual({ liters: 6.5, condition: "dry" });
    expect(result.fillCondition).toBeNull();
  });

  it("routes prose to the model extractor", async () => {
    const textExtractor = vi.fn<OilSpecExtractor>().mockResolvedValue({
      viscosityGrades: ["0W-20"],
      classification: "API SP",
      fillLiters: 3.7,
      fillKind: "em_servico",
    });

    const spec = await createOilSpecExtractor(textExtractor)(
      textSource("Capacidade: 3,7 litros. Viscosidade 0W-20."),
      identity,
    );

    expect(spec).toMatchObject({ fillLiters: 3.7 });
    expect(textExtractor).toHaveBeenCalledTimes(1);
  });

  it("reads liters and classification straight off a flatten payload", () => {
    expect(extractFromMotulFlatten({ vehicle: "fixture", parts: twoProducts })).toEqual({
      viscosityGrades: ["5W-40", "5W-30"],
      classification: "API SN",
      fillLiters: 4.2,
      fillKind: "em_servico",
      fillCondition: "with_filter",
    });
  });
});

describe("SAE normalization", () => {
  it("hyphenates, upper-cases, and de-duplicates without reordering", () => {
    expect(normalizeSaeGrades([" 5w30 ", "5W-30", "10W40"])).toEqual(["5W-30", "10W-40"]);
  });

  it("drops values that are not SAE multigrades", () => {
    expect(normalizeSaeGrades(["API SP", "", "5W-30"])).toEqual(["5W-30"]);
  });

  it("clears liters that carry no legend", () => {
    expect(
      validateExtractedSpec({
        viscosityGrades: ["5W-30"],
        classification: "",
        fillLiters: 4.2,
        fillKind: null,
      }),
    ).toEqual({
      viscosityGrades: ["5W-30"],
      classification: "",
      fillLiters: null,
      fillKind: null,
      fillCondition: null,
      unusableFillLiters: null,
    });
  });
});

