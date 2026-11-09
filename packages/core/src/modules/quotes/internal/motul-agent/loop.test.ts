/**
 * Test design (testing-strategy)
 *
 * Setup: runMotulAgent / findOil with vi.mock on generateText and
 * resolveOil. fetch is spied so Motul HTTP is never used.
 *
 * Spec rule (openspec/specs/quotes/motul-recommendation/spec.md):
 *   Structured quote path does not invent products with a language model.
 *   A human reviews the draft before send. unavailable is forwarded as-is.
 *
 * Partitions (one numbered group = tool/LLM outcomes the spec treats the same):
 *
 *   P1 VALID   — draft path: generateText returns a suggestion string;
 *                fetch is not called
 *   P2 VALID   — findOil relays `{ status: "unavailable" }` verbatim
 *                (no recommendation field, no MOTUL/5W- in the JSON)
 *   P3 VALID   — runMotulAgent surfaces that unavailable JSON as the draft
 *                instead of inventing a product name
 *
 *   P4 VALID   — generateText returns "" → FALLBACK_REPLY (D1 false)
 *   P5 INVALID — generateText throws → FALLBACK_REPLY (D2 catch)
 *
 * Output partitions:
 *   O1 — draft string from generateText, fetch call count 0 (P1)
 *   O2 — `{ status: "unavailable" }` with no MOTUL/5W- (P2/P3)
 *   O3 — FALLBACK_REPLY (P4/P5)
 *
 * Decisions in runMotulAgent:
 *   D1 `result.text || FALLBACK` — T: non-empty text (P1). F: empty string (P4).
 *   D2 try vs catch — T path: P1/P3/P4. F path: generateText throws (P5).
 *
 * Limits: none. `status` is a fixed string, not a count.
 *
 * Sampled-cell
 *   draft generateText            | P1 D1 T D2 T | O1 | fetch>0 or empty draft
 *   findOil unavailable           | P2           | O2 | MOTUL in JSON
 *   agent surfaces unavailable    | P3           | O2 | invented product
 *   empty generateText            | P4 D1 F      | O3 | non-fallback
 *   generateText throws           | P5 D2 F      | O3 | throw escapes
 *
 * Map from each `it` to a partition:
 *
 *   returns a draft suggestion and only calls mocked generateText — P1
 *   relays an unavailable resolveOil result verbatim through findOil — P2
 *   runMotulAgent surfaces unavailable tool output instead of inventing products
 *     — P3
 *   returns the fallback reply when generateText yields an empty string — P4
 *   returns the fallback reply when generateText throws — P5
 *
 * What would make a test fail:
 *   a draft containing "MOTUL 8100" when resolveOil returned unavailable
 *
 * Not in this file: live OpenAI or Motul HTTP; clicking Enviar on the draft.
 */
import { generateText, type ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOil } from "../../../../kernel/clients/motul/index.js";
import { findOil } from "./tools.js";
import { runMotulAgent } from "./loop.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

vi.mock("../../../../kernel/clients/motul/index.js", () => ({
  resolveOil: vi.fn(),
}));

const mockedGenerateText = vi.mocked(generateText);
const mockedResolveOil = vi.mocked(resolveOil);
const toolExecuteOptions = {
  toolCallId: "t1",
  messages: [] as ModelMessage[],
  context: {},
};

describe("runMotulAgent", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a draft suggestion and only calls mocked generateText", async () => {
    mockedGenerateText.mockResolvedValue({
      text: "Sugestão: MOTUL 8100 X-CESS GEN2 5W-40 (rascunho).",
    } as Awaited<ReturnType<typeof generateText>>);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const messages: ModelMessage[] = [
      { role: "user", content: "Argo 2020" },
    ];

    const draft = await runMotulAgent(messages);

    expect(draft).toBe(
      "Sugestão: MOTUL 8100 X-CESS GEN2 5W-40 (rascunho).",
    );
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("relays an unavailable resolveOil result verbatim through findOil", async () => {
    const unavailable = { status: "unavailable" as const };
    mockedResolveOil.mockResolvedValue(unavailable);

    const toolResult = await findOil.execute!(
      { brand: "FIAT" },
      toolExecuteOptions,
    );

    expect(toolResult).toEqual(unavailable);
    expect(toolResult).not.toHaveProperty("recommendation");
    expect(JSON.stringify(toolResult)).not.toMatch(/MOTUL|5W-/);
    expect(mockedResolveOil).toHaveBeenCalledTimes(1);
  });

  it("runMotulAgent surfaces unavailable tool output instead of inventing products", async () => {
    const unavailable = { status: "unavailable" as const };
    mockedResolveOil.mockResolvedValue(unavailable);
    mockedGenerateText.mockImplementation(async (opts) => {
      const tools = (
        opts as unknown as { tools: { findOil: typeof findOil } }
      ).tools;
      const toolResult = await tools.findOil.execute!(
        { brand: "FIAT" },
        toolExecuteOptions,
      );
      return { text: JSON.stringify(toolResult) } as Awaited<
        ReturnType<typeof generateText>
      >;
    });

    const draft = await runMotulAgent([
      { role: "user", content: "óleo para um Fiat" },
    ]);

    expect(JSON.parse(draft)).toEqual(unavailable);
    expect(draft).not.toMatch(/MOTUL|5W-/);
    expect(mockedResolveOil).toHaveBeenCalled();
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("returns the fallback reply when generateText yields an empty string", async () => {
    mockedGenerateText.mockResolvedValue({
      text: "",
    } as Awaited<ReturnType<typeof generateText>>);

    const draft = await runMotulAgent([{ role: "user", content: "Argo 2020" }]);

    expect(draft).toBe(
      "Não foi possível gerar a sugestão agora. Tente de novo em instantes.",
    );
  });

  it("returns the fallback reply when generateText throws", async () => {
    mockedGenerateText.mockRejectedValue(new Error("openai down"));

    const draft = await runMotulAgent([{ role: "user", content: "Argo 2020" }]);

    expect(draft).toBe(
      "Não foi possível gerar a sugestão agora. Tente de novo em instantes.",
    );
  });
});
