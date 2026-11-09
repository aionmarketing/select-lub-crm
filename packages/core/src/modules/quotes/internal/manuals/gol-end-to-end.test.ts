/**
 * Test design (testing-strategy) — the Gol's manual, from its located pages to the cache row
 *
 * SUT: readForIdentity over `golPages()` with the REAL passage selector and the REAL model
 *   extractor, both over one fake streamed OpenAI transport (no socket, a placeholder key); the
 *   reading's spec through its JSON column (`parseStoredManualSpec`); the stored-manual retriever;
 *   resolveOilSpec with a text extractor that throws (a stored reading calls no model); and
 *   mapPipelineResult, which builds the cache row the research run writes.
 *
 * Oracle: background-oil-research D22 (the Gol 2021 1.0's capacities row, "3,3 litros" in the
 *   1.0 column, reached by the selector's completion from a grades-only answer) and
 *   ingest-harvested-manuals D5 with the owner's ruling (2026-09-26): a single unlabelled volume
 *   prices, recorded as `unlabeled`. Both reply shapes reach the same row: the pre-D5 one
 *   (`fillKind` only) and the D5 one (`fillCondition`). Review of #189, which ran this as a
 *   scratch test; the stopgap it replaces dropped the 3,3 L.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerScript as answerSteps, fakeTransport, responsesStream as sseResponse, systemPromptOf, userPromptOf } from "../model-calls/fake-openai.js";
import { createOilSpecExtractor, resolveOilSpec, type OilSpecExtractor } from "../pipeline/oil-spec.js";
import { createModelPassageSelector } from "../pipeline/passage-selector.js";
import { createModelOilSpecExtractor, OIL_SPEC_SYSTEM_PROMPT } from "../pipeline/spec-extractor.js";
import { mapPipelineResult } from "../research/outcome.js";
import { createStoredManualRetriever } from "../retrieval/stored-manuals.js";
import { GOL_2021_10, GOL_GRADE_LINES, golPages } from "./fixtures/gol-located.js";
import { parseStoredManualSpec, readForIdentity } from "./read-for-identity.js";

const URL = "https://www.vw.com.br/manuais/gol-2021.pdf";
const META = { publisher: "vw.com.br", document: "Manual Gol 2021", sourceClass: "manufacturer_manual" as const };
const NOW = new Date("2026-09-27T15:00:00.000Z");
const GOL_PREFIXED = ["SAE 0W 30", "SAE 0W 40", "SAE 5W 30", "SAE 5W 40", "SAE 10W 30", "SAE 10W 40"];
const GOL_GRADES = ["0W-30", "0W-40", "5W-30", "5W-40", "10W-30", "10W-40"];

/** The number the selector's prompt gave the line with this text. */
function lineOf(prompt: string, text: string): number {
  for (const line of prompt.split("\n")) {
    const match = /^(\d+): (.*)$/.exec(line);
    if (match && match[2] === text) return Number(match[1]);
  }
  throw new Error(`not shown: ${text}`);
}

/**
 * One model: the extractor's calls (its system prompt) answer `extraction`; the selector's answer
 * only the grades' range, as five of the benchmark's six answers did, so the capacities row comes
 * from the completion (D22).
 */
function model(extraction: Record<string, unknown>) {
  return fakeTransport((request) => {
    if (systemPromptOf(request) === OIL_SPEC_SYSTEM_PROMPT) {
      return sseResponse(answerSteps(JSON.stringify(extraction)));
    }
    const prompt = userPromptOf(request);
    const range = { startLine: lineOf(prompt, GOL_GRADE_LINES[0]!), endLine: lineOf(prompt, GOL_GRADE_LINES[1]!) };
    return sseResponse(answerSteps(JSON.stringify({ ranges: [range] })));
  });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "placeholder-not-a-key";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
});

describe("the Gol 2021 1.0's manual, read and researched", () => {
  it.each([
    ["pre-D5, fillKind only", { fillKind: "unlabeled" }],
    ["D5, fillCondition", { fillCondition: "unlabeled" }],
  ])("reaches a verified 3,3 L unlabelled row from a %s reply", async (_shape, fill) => {
    const transport = model({ viscosityGrades: GOL_PREFIXED, classification: "", fillLiters: 3.3, ...fill, engineCoverage: "one", enginesNamed: [] });

    const outcome = await readForIdentity(
      { url: URL, pages: golPages(), identity: GOL_2021_10, meta: META, k: 6 },
      { selectPassage: createModelPassageSelector({ transport: transport.fetch }), extract: createModelOilSpecExtractor({ transport: transport.fetch }) },
    );
    expect(outcome).toMatchObject({ status: "verified", citedPage: "pp. 238, 301" });
    if (outcome.status !== "verified") throw new Error("unreachable");
    expect(outcome.excerpt).toContain("3,3 litros");

    // As the reading job stores it, and the store reads it back.
    const spec = parseStoredManualSpec(JSON.parse(JSON.stringify(outcome.spec)));
    expect(spec).not.toBeNull();
    const reading = { url: URL, citedPage: outcome.citedPage, excerpt: outcome.excerpt, spec: spec! };
    const noModel = vi.fn<OilSpecExtractor>(async () => {
      throw new Error("a model was called for a stored manual reading");
    });

    const result = await resolveOilSpec(GOL_2021_10, {
      retrieve: createStoredManualRetriever({ listManualReadings: async () => [reading] }),
      extract: createOilSpecExtractor(noModel),
    });

    expect(noModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "verified", viscosityGrades: GOL_GRADES, fillLiters: 3.3, fillKind: "unlabeled", fillCondition: "unlabeled" });
    expect(mapPipelineResult(result, GOL_2021_10, NOW)).toMatchObject({
      kind: "verified",
      cacheRow: { fillLiters: 3.3, fillKind: "unlabeled", fillCondition: "unlabeled", unusableFillLiters: null, sourcePage: "pp. 238, 301", sourceUrl: URL },
    });
  });
});
