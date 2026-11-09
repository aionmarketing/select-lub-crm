/**
 * Test design (testing-strategy) — the passage selector on a web page: the lines it reports,
 * and the narrowed input (tasks 1.4, 1.10)
 *
 * SUT: createModelPassageSelector, and resolveOilSpec over it, through the real SDK and effort seam
 *   over a fake streamed transport (a fake model reading the numbered text it was sent). No
 *   socket, no key.
 *
 * Oracle:
 *   - review of #182 (L1): a caller that maps a passage back to pages reads the selector's spans —
 *     0-based, `to` exclusive, margin included — rather than searching the text;
 *   - background-oil-research D4 / `research-model-calls` "The model reads a narrowed passage of a long
 *     text": a long web page is narrowed to its oil windows, each kept line under its ORIGINAL
 *     number; the range is validated against and sliced from the original page, so the stored
 *     excerpt is verbatim page text; a page with no hit is sent capped, as before;
 *   - D2 / "A selector timeout degrades to the narrowed text": the extractor then reads the
 *     narrowed text, not the whole capped page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerScript as answerSteps, createdEvent, fakeTransport, responsesStream as sseResponse, userPromptOf, type CapturedRequest } from "../model-calls/fake-openai.js";
import { ELISION } from "./narrow-text.js";
import { resolveOilSpec, type OilSpecExtractor, type RetrievedSource } from "./oil-spec.js";
import { createModelPassageSelector, numberLines, PASSAGE_MARGIN_LINES, PASSAGE_SHORT_PAGE_CHARS } from "./passage-selector.js";

const identity = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0" };
const pageOf = (lines: string[]): RetrievedSource => ({ publisher: "vw.com.br", document: "Manual", page: "p. 1", content: { kind: "text", text: lines.join("\n") } });

/** The user prompt of a captured request. */
const promptOf = (request: CapturedRequest) => userPromptOf(request);

/** A fake model answering one range, by original line numbers it finds in the prompt. */
function answering(range: (prompt: string) => { startLine: number; endLine: number }) {
  return fakeTransport((request) => sseResponse(answerSteps(JSON.stringify({ ranges: [range(promptOf(request))] }))));
}

/** The number the prompt shows a line under. */
function shownAs(prompt: string, text: string): number {
  const match = prompt.split("\n").find((line) => line.endsWith(`: ${text}`));
  if (!match) throw new Error(`not shown: ${text}`);
  return Number(match.split(":")[0]);
}

/** A 400-line, ~20 000-character page with the capacities table on lines 300–302. */
function longPage(): string[] {
  const lines = Array.from({ length: 400 }, (_unused, index) => `Parágrafo ${index + 1} do texto do site, sem nada sobre o motor, preenchido.`);
  lines[299] = "Capacidades do motor 1.0";
  lines[300] = "Quantidade de óleo do motor com filtro: 3,3 litros";
  lines[301] = "Viscosidade SAE 5W-40";
  return lines;
}

beforeEach(() => {
  vi.useFakeTimers();
  process.env.OPENAI_API_KEY = "placeholder-not-a-key";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createModelPassageSelector on a page with no oil line", () => {
  it("sends the capped page numbered as before, and returns the chosen lines with the margin", async () => {
    const lines = Array.from({ length: 40 }, (_unused, i) => `linha ${i + 1} ${"x".repeat(Math.ceil(PASSAGE_SHORT_PAGE_CHARS / 40))}`);
    const transport = answering(() => ({ startLine: 20, endLine: 22 }));

    const pending = createModelPassageSelector({ transport: transport.fetch })(pageOf(lines), identity);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pending;

    expect(promptOf(transport.requests[0]!)).toContain(numberLines(lines.join("\n")));
    const from = 20 - 1 - PASSAGE_MARGIN_LINES;
    const to = 22 + PASSAGE_MARGIN_LINES;
    expect(out).toMatchObject({ status: "selected", lines: [{ from, to }] });
    if (out.status !== "selected" || out.source.content.kind !== "text") throw new Error("expected a text passage");
    expect(out.source.content.text).toBe(lines.slice(from, to).join("\n"));
  });
});

describe("createModelPassageSelector on a long web page (D4)", () => {
  it("finds a table 300 lines down a 20 000-character page, shown under its original numbers", async () => {
    const lines = longPage();
    const transport = answering((prompt) => ({ startLine: shownAs(prompt, lines[299]!), endLine: shownAs(prompt, lines[301]!) }));

    const pending = createModelPassageSelector({ transport: transport.fetch })(pageOf(lines), identity);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pending;

    const prompt = promptOf(transport.requests[0]!);
    expect(lines.join("\n").length).toBeGreaterThan(19_000);
    expect(prompt).toContain(`301: ${lines[300]}`);
    // Narrowed: far prose is elided, not sent.
    expect(prompt).toContain(ELISION);
    expect(prompt).not.toContain(`1: ${lines[0]}`);
    expect(prompt.length).toBeLessThan(3_000);
    expect(out).toMatchObject({ status: "selected", lines: [{ from: 299 - PASSAGE_MARGIN_LINES, to: 302 + PASSAGE_MARGIN_LINES }] });
  });

  it("drops a range on lines the model was never shown, and falls back to the narrowed text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lines = longPage();
    // Lines 1–2 of the original page were elided: a valid page line number, but not one it saw.
    const transport = answering(() => ({ startLine: 1, endLine: 2 }));

    const pending = createModelPassageSelector({ transport: transport.fetch })(pageOf(lines), identity);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pending;

    expect(out.status).toBe("unavailable");
    expect(out.status === "unavailable" && out.fallback?.content).toMatchObject({ text: expect.stringContaining(lines[300]!) });
  });

  it("stores verbatim page text, sliced from the original page", async () => {
    const lines = longPage();
    const transport = answering((prompt) => ({ startLine: shownAs(prompt, lines[300]!), endLine: shownAs(prompt, lines[301]!) }));

    const pending = createModelPassageSelector({ transport: transport.fetch })(pageOf(lines), identity);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pending;

    if (out.status !== "selected") throw new Error("expected a selection");
    const expected = lines.slice(300 - PASSAGE_MARGIN_LINES, 302 + PASSAGE_MARGIN_LINES).join("\n");
    expect(out.source.content).toEqual({ kind: "text", text: expected });
    expect(out.source.excerpt).toBe(expected);
  });

  it("falls back to the narrowed text when the selector reaches its ceiling, and the extractor reads that", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lines = longPage();
    const transport = fakeTransport(() => sseResponse([{ afterMs: 1_000, event: createdEvent() }]));
    const extract = vi.fn<OilSpecExtractor>(async () => null);

    const pending = resolveOilSpec(identity, {
      retrieve: async () => ({ status: "found", sources: [pageOf(lines)] }),
      extract,
      selectPassage: createModelPassageSelector({ transport: transport.fetch }),
    });
    await vi.advanceTimersByTimeAsync(250_000);
    await pending;

    const read = extract.mock.calls[0]![0];
    const text = read.content.kind === "text" ? read.content.text : "";
    expect(text).toContain(lines[300]);
    expect(text).toContain(ELISION);
    expect(text).not.toContain(lines[0]);
    expect(text.length).toBeLessThan(lines.join("\n").length / 5);
  });
});
