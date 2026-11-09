/**
 * Test design (testing-strategy) — the extractor reports the capacity type (D5)
 *
 * SUT: createModelOilSpecExtractor and createEscalationExtractor, through the real AI SDK and effort
 *   seam over a fake streamed transport (no socket; a placeholder key so the model path runs).
 *
 * Oracle: ingest-harvested-manuals D5 and the manuals PR 4 rulings (2026-09-26): the model answers
 *   `fillCondition`, and the legend is derived from it; an older reply with only `fillKind` still
 *   reads; the prompt names the four capacity types and reads a column table by the vehicle's own
 *   engine. The column-table note itself is background-oil-research D5's (PR 1), pinned in
 *   `spec-extractor.failed.test.ts`; here only that the prompt carries it exactly once.
 *   Timeouts are not this test's: they come from `internal/model-calls/limits.ts` (background-oil-research
 *   D2, task 1.9), and manuals PR 4's own timeout options were dropped (task 6.3).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerScript as answerSteps, fakeTransport, responsesStream as sseResponse } from "../model-calls/fake-openai.js";

const { COLUMN_TABLE_NOTE, createEscalationExtractor, createModelOilSpecExtractor, OIL_SPEC_SYSTEM_PROMPT } = await import("./spec-extractor.js");

const identity = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0" };
const source = {
  publisher: "vw.com.br",
  document: "Manual",
  page: "p. 301",
  content: { kind: "text" as const, text: "Quantidade de óleo do motor 3,3 litros" },
};
const reply = (fields: Record<string, unknown>) =>
  JSON.stringify({ viscosityGrades: ["5W-40"], classification: "", fillLiters: 3.3, ...fields });

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
});

describe("createModelOilSpecExtractor and the capacity type", () => {
  it.each([
    ["with_filter", "em_servico"],
    ["unlabeled", "unlabeled"],
    ["without_filter", null],
    ["dry", null],
  ] as const)("reads %s and derives the legend", async (fillCondition, fillKind) => {
    process.env.OPENAI_API_KEY = "placeholder-not-a-key";
    const transport = fakeTransport(() => sseResponse(answerSteps(reply({ fillCondition }))));

    expect(await createModelOilSpecExtractor({ transport: transport.fetch })(source, identity)).toMatchObject({ fillLiters: 3.3, fillCondition, fillKind });
  });

  it("still reads an older reply that carries only the legend", async () => {
    process.env.OPENAI_API_KEY = "placeholder-not-a-key";
    const transport = fakeTransport(() => sseResponse(answerSteps(reply({ fillKind: "em_servico" }))));

    expect(await createModelOilSpecExtractor({ transport: transport.fetch })(source, identity)).toMatchObject({
      fillCondition: "with_filter",
      fillKind: "em_servico",
    });
  });

  it("derives the capacity type on an escalation's settled answer too", async () => {
    process.env.OPENAI_API_KEY = "placeholder-not-a-key";
    const transport = fakeTransport(() => sseResponse(answerSteps(reply({ fillCondition: "dry" }))));

    expect(await createEscalationExtractor({ transport: transport.fetch })({ identity, conflicts: [], sources: [source] })).toMatchObject({
      fillCondition: "dry",
      fillKind: null,
    });
  });

  it("names the four capacity types, and carries the column-table note once", () => {
    for (const condition of ["with_filter", "without_filter", "dry", "unlabeled"]) {
      expect(OIL_SPEC_SYSTEM_PROMPT).toContain(`"${condition}"`);
    }
    expect(OIL_SPEC_SYSTEM_PROMPT).toContain("uma coluna por motor");
    expect(OIL_SPEC_SYSTEM_PROMPT.split("Leia a coluna do motor do veículo do orçamento")).toHaveLength(2);
    expect(OIL_SPEC_SYSTEM_PROMPT.split(COLUMN_TABLE_NOTE)).toHaveLength(2);
  });
});
