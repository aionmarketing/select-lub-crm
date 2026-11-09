/**
 * Test design (testing-strategy) — one identity's reading of a stored manual (D7)
 *
 * SUT: readForIdentity, with fake passage selectors and extractors (no model, no database).
 *
 * Oracle: ingest-harvested-manuals D4/D6/D7: the identity's pages are located, the selector
 *   picks the passage, the extractor reads THAT passage once, and the reading is cited to the
 *   page it came from, with the source's publisher, label and class (tier 1 for a manual).
 *   `verified` when the extraction has a valid grade; `stated_nothing` when no page mentions oil,
 *   the selector finds no passage, or the passage names no usable oil; `failed` (retried later)
 *   when the model failed. A selector that is unavailable leaves the K pages to be read whole.
 */
import { describe, expect, it, vi } from "vitest";
import { EXTRACTION_FAILED, type ExtractedOilSpec, type OilSpecExtractor, type RetrievedSource } from "../pipeline/oil-spec.js";
import type { PassageSelector } from "../pipeline/passage-selector.js";
import { parseStoredManualSpec, readForIdentity, type ManualSourceMeta } from "./read-for-identity.js";

const URL_PDF = "https://www.vw.com.br/manuais/gol-2021.pdf";
const GOL = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const META: ManualSourceMeta = { publisher: "vw.com.br", document: "Manual Gol 2021", sourceClass: "manufacturer_manual" };
const PAGES = [
  { pageNumber: 1, text: "Manual do Proprietário" },
  { pageNumber: 3, text: "Capacidades e especificações\nÓleo do motor 1.0 12V\nViscosidade SAE 5W-40\nCapacidade com filtro: 4,0 litros" },
];
const SPEC: ExtractedOilSpec = {
  viscosityGrades: ["5W-40"],
  classification: "",
  fillLiters: 4,
  fillKind: "em_servico",
  engineCoverage: "one",
  enginesNamed: [],
};
const input = { url: URL_PDF, pages: PAGES, identity: GOL, meta: META, k: 6 };

/** A selector that picks the given passage out of the joined pages, reporting its line range. */
const selecting = (passage: string): PassageSelector => async (source) => {
  const text = source.content.kind === "text" ? source.content.text : "";
  const from = text.split("\n").indexOf(passage.split("\n")[0]!);
  return {
    status: "selected",
    source: { ...source, excerpt: passage, content: { kind: "text", text: passage } },
    lines: [{ from, to: from + passage.split("\n").length }],
  };
};

describe("readForIdentity", () => {
  it("reads the selected passage once and cites the page it came from", async () => {
    const passage = "Viscosidade SAE 5W-40\nCapacidade com filtro: 4,0 litros";
    const extract = vi.fn<OilSpecExtractor>(async () => SPEC);

    const outcome = await readForIdentity(input, { selectPassage: selecting(passage), extract });

    expect(outcome).toEqual({ status: "verified", spec: { ...SPEC, ...META }, citedPage: "p. 3", excerpt: passage });
    expect(extract).toHaveBeenCalledTimes(1);
    const read = extract.mock.calls[0]![0] as RetrievedSource;
    expect(read).toMatchObject({ publisher: "vw.com.br", document: "Manual Gol 2021", page: "p. 3", url: URL_PDF, authority: 1, excerpt: passage });
    expect(read.content).toEqual({ kind: "text", text: passage });
  });

  it("cites only the page of the lines chosen, when several pages were sent", async () => {
    const two = [...PAGES, { pageNumber: 4, text: "Capacidades — Motor 1.6\nÓleo do motor: SAE 5W-40\nCapacidade com filtro: 4,5 litros" }];
    const passage = "Viscosidade SAE 5W-40\nCapacidade com filtro: 4,0 litros";

    const outcome = await readForIdentity({ ...input, pages: two }, { selectPassage: selecting(passage), extract: async () => SPEC });

    expect(outcome).toMatchObject({ status: "verified", citedPage: "p. 3" });
  });

  it("reads the located pages whole when the selector is unavailable, and cites them all", async () => {
    const extract = vi.fn<OilSpecExtractor>(async () => SPEC);

    const outcome = await readForIdentity(input, { selectPassage: async () => ({ status: "unavailable" }), extract });

    expect(outcome).toMatchObject({ status: "verified", citedPage: "p. 3" });
    expect((extract.mock.calls[0]![0] as RetrievedSource).content).toMatchObject({ text: expect.stringContaining("=== página 3 ===") });
  });

  it("states nothing, without a model call, when no page mentions oil", async () => {
    const extract = vi.fn<OilSpecExtractor>();
    const selectPassage = vi.fn<PassageSelector>();

    expect(await readForIdentity({ ...input, pages: [PAGES[0]!] }, { selectPassage, extract })).toMatchObject({ status: "stated_nothing" });
    expect(selectPassage).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it("states nothing when the selector finds no passage, without extracting", async () => {
    const extract = vi.fn<OilSpecExtractor>();

    expect(await readForIdentity(input, { selectPassage: async () => ({ status: "none" }), extract })).toMatchObject({
      status: "stated_nothing",
      citedPage: "p. 3",
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("states nothing when the passage names no oil, or no valid grade", async () => {
    expect(await readForIdentity(input, { extract: async () => null })).toMatchObject({ status: "stated_nothing", spec: null });
    const noGrade = { ...SPEC, viscosityGrades: ["ótimo"] };
    expect(await readForIdentity(input, { extract: async () => noGrade })).toMatchObject({
      status: "stated_nothing",
      spec: { ...noGrade, ...META },
    });
  });

  it("fails, to be retried, when the model fails or throws", async () => {
    expect(await readForIdentity(input, { extract: async () => EXTRACTION_FAILED })).toEqual({ status: "failed", why: "the extractor failed" });
    expect(
      await readForIdentity(input, {
        selectPassage: async () => {
          throw new Error("socket hang up");
        },
        extract: async () => SPEC,
      }),
    ).toMatchObject({ status: "failed", why: expect.stringContaining("socket hang up") });
  });

  it("keeps the engine coverage, so the quote still asks which engine", async () => {
    const several = { ...SPEC, engineCoverage: "several" as const, enginesNamed: ["1.0", "1.6"] };

    expect(await readForIdentity(input, { extract: async () => several })).toMatchObject({
      status: "verified",
      spec: { engineCoverage: "several", enginesNamed: ["1.0", "1.6"] },
    });
  });
});

describe("parseStoredManualSpec", () => {
  it("reads back what a reading stored, and refuses anything else", () => {
    expect(parseStoredManualSpec({ ...SPEC, ...META })).toEqual({ ...SPEC, ...META });
    expect(parseStoredManualSpec({ ...SPEC, ...META, sourceClass: "forum" })).toBeNull();
    expect(parseStoredManualSpec(null)).toBeNull();
  });
});
