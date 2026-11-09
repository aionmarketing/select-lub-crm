/**
 * Test design (testing-strategy) — the current web answer as a re-resolve source, and its volume
 *
 * SUT: currentWebSource, pure.
 *
 * Oracle: background-oil-research D11 (the page behind the current answer, rebuilt from its row,
 *   held to the stored-reading anchoring) and ingest-harvested-manuals D5 (review of #189): the
 *   rebuilt spec keeps the capacity type of priced liters, and a volume a change does not use that
 *   the row recorded, so the re-resolve can still name it; a volume its passage does not state is
 *   not a source.
 */
import { describe, expect, it } from "vitest";
import type { MotulCompatibility } from "../../contracts/http.js";
import { currentWebSource } from "./current-answer.js";

const URL = "https://oficina.example.com.br/gol";
const cited = {
  sourcePublisher: "oficina.example.com.br",
  sourceDocument: "Tabela",
  sourcePage: "Gol",
  sourceAuthority: 3,
  sourceUrl: URL,
  sourceClassification: "licensed_database" as const,
};

function row(fields: Partial<MotulCompatibility>, excerpt: string): MotulCompatibility {
  return {
    id: "row",
    make: "Volkswagen",
    year: 2021,
    model: "Gol",
    version: "1.0",
    viscosityGrades: ["5W-40"],
    viscosity: "5W-40",
    classification: "",
    fillLiters: null,
    fillKind: null,
    consultedAt: "2026-09-27T12:00:00.000Z",
    rawPayload: null,
    ...cited,
    sourceExcerpt: excerpt,
    gradeSources: [{ grade: "5W-40", ...cited, sourceExcerpt: excerpt }],
    litersSource: null,
    ...fields,
  };
}

describe("currentWebSource and the capacity type", () => {
  it("keeps a dry volume the row recorded, for the validator to set aside", () => {
    const source = currentWebSource(row({ fillCondition: "dry", unusableFillLiters: 3.6 }, "SAE 5W-40, volume seco 3,6 L"));

    expect(source?.content).toMatchObject({ kind: "stored_spec", spec: { fillLiters: 3.6, fillKind: null, fillCondition: "dry" } });
  });

  it("keeps the capacity type of the liters the page stated", () => {
    const source = currentWebSource(
      row({ fillLiters: 3.3, fillKind: "unlabeled", fillCondition: "unlabeled", litersSource: { ...cited } }, "SAE 5W-40, 3,3 litros"),
    );

    expect(source?.content).toMatchObject({ spec: { fillLiters: 3.3, fillKind: "unlabeled", fillCondition: "unlabeled" } });
  });

  it("is not a source when its passage does not state the dry volume", () => {
    expect(currentWebSource(row({ fillCondition: "dry", unusableFillLiters: 3.6 }, "SAE 5W-40"))).toBeNull();
  });
});
