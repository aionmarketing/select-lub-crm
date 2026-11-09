/**
 * Test design (testing-strategy) — the capacity type decides what prices (D5)
 *
 * SUT: validateExtractedSpec and verifiedFrom (through resolveOilSpec), pure.
 *
 * Oracle: ingest-harvested-manuals D5 and the oil-quote delta "The capacity type is recorded, and
 *   only an in-service volume prices the oil"; the owner, 2026-09-26: a with-filter volume
 *   prices; an unlabeled one prices (the extractor is told: only when it is the single volume); a
 *   without-filter or dry one never prices, and is kept to tell the attendant; an extraction that
 *   predates D5 reads its type from its legend.
 */
import { describe, expect, it } from "vitest";
import { resolveOilSpec, validateExtractedSpec, type ExtractedOilSpec, type RetrievedSource } from "./oil-spec.js";

const base: ExtractedOilSpec = { viscosityGrades: ["5W-40"], classification: "", fillLiters: 4, fillKind: null };
const identity = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0" };

describe("validateExtractedSpec and the capacity type", () => {
  it("prices a with-filter volume as in-service", () => {
    expect(validateExtractedSpec({ ...base, fillCondition: "with_filter" })).toMatchObject({
      fillLiters: 4,
      fillKind: "em_servico",
      fillCondition: "with_filter",
      unusableFillLiters: null,
    });
  });

  it("prices an unlabeled volume, as unlabeled", () => {
    expect(validateExtractedSpec({ ...base, fillCondition: "unlabeled" })).toMatchObject({
      fillLiters: 4,
      fillKind: "unlabeled",
      fillCondition: "unlabeled",
    });
  });

  it.each(["without_filter", "dry"] as const)("never prices a %s volume, and keeps it aside", (condition) => {
    expect(validateExtractedSpec({ ...base, fillCondition: condition })).toMatchObject({
      fillLiters: null,
      fillKind: null,
      fillCondition: condition,
      unusableFillLiters: 4,
    });
  });

  it("reads an extraction that predates D5 from its legend", () => {
    expect(validateExtractedSpec({ ...base, fillKind: "em_servico" })).toMatchObject({ fillLiters: 4, fillCondition: "with_filter" });
    expect(validateExtractedSpec({ ...base, fillKind: "unlabeled" })).toMatchObject({ fillLiters: 4, fillCondition: "unlabeled" });
  });

  it("keeps nothing of an implausible volume, whatever its type", () => {
    expect(validateExtractedSpec({ ...base, fillLiters: 40, fillCondition: "dry" })).toMatchObject({
      fillLiters: null,
      fillCondition: null,
      unusableFillLiters: null,
    });
  });
});

describe("a quote's capacity type across sources", () => {
  const source = (publisher: string, authority: 1 | 5): RetrievedSource => ({
    publisher,
    document: "d",
    page: "p",
    authority,
    content: { kind: "text", text: "x" },
  });

  it("prices one source's usable volume over another's unusable one", async () => {
    const result = await resolveOilSpec(identity, {
      retrieve: async () => ({ status: "found", sources: [source("manual", 1), source("catalog", 5)] }),
      extract: async (s) =>
        s.publisher === "manual" ? { ...base, fillCondition: "dry", fillLiters: 3.6 } : { ...base, fillCondition: "with_filter" },
    });

    expect(result).toMatchObject({ status: "verified", fillLiters: 4, fillCondition: "with_filter", unusableFill: null });
  });

  it("tells the highest-authority unusable volume when no source gave a usable one", async () => {
    const result = await resolveOilSpec(identity, {
      retrieve: async () => ({ status: "found", sources: [source("manual", 1), source("catalog", 5)] }),
      extract: async (s) =>
        s.publisher === "manual"
          ? { ...base, fillCondition: "without_filter", fillLiters: 3.6 }
          : { ...base, fillCondition: "dry", fillLiters: 4.2 },
    });

    expect(result).toMatchObject({
      status: "verified",
      fillLiters: null,
      fillCondition: null,
      unusableFill: { liters: 3.6, condition: "without_filter" },
    });
  });

  // Review of #189: an escalation only picks among the candidates' values, so the capacity type
  // is the one the liters are cited to, never the escalation's own label — the caption and the
  // citation agree. Two sources disagree on the liters (4 vs 4,5 L); the escalation settles on 4.
  it.each([
    ["unlabeled", "with_filter", "unlabeled"],
    ["with_filter", "unlabeled", "em_servico"],
  ] as const)("keeps the cited source's %s when an escalation labels the same liters %s", async (cited, escalated, legend) => {
    const result = await resolveOilSpec(identity, {
      retrieve: async () => ({ status: "found", sources: [source("manual", 1), source("catalog", 5)] }),
      extract: async (s) =>
        s.publisher === "manual" ? { ...base, fillLiters: 4, fillCondition: cited } : { ...base, fillLiters: 4.5, fillCondition: "with_filter" },
      escalate: async () => ({ ...base, fillLiters: 4, fillCondition: escalated }),
    });

    expect(result).toMatchObject({
      status: "verified",
      settledByEscalation: true,
      fillLiters: 4,
      fillCondition: cited,
      fillKind: legend,
      litersCitation: { publisher: "manual" },
    });
  });
});
