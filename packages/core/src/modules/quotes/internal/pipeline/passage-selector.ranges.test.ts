/**
 * Test design (testing-strategy) — passage selection keeps the grades and the capacities
 * (task 1.14, D22), over a Gol-shaped manual
 *
 * SUT: createModelPassageSelector (real SDK and effort seam, a fake model over a fake transport
 *   that answers ranges computed from the numbered text it was sent), completeSpans,
 *   capacityAnchors / isGradeLine, and readForIdentity end to end. No socket, no key.
 *
 * Oracle: design.md D22 and the `research-model-calls` delta "Passage selection keeps the grades and
 *   the capacities, even on different pages": the ranges are validated one by one, widened by
 *   the margin, merged and joined in line order with one `[…]` line; when they miss the grade
 *   lines or the capacity anchors the narrowed text holds, windows around them are added, each
 *   on its own page, with no model call; nothing is added the text does not hold; a selection
 *   with no valid range is `unavailable`. The fixture (`manuals/fixtures/gol-located.ts`) is the
 *   Gol's six located pages, grades on p. 238, decoys on pp. 239–240, capacities on p. 301.
 *
 * Cells (one per `it`)
 *   grades-only answer (5 of the benchmark's 6)   | + the capacities row, cited "pp. 238, 301", nothing of pp. 239–240
 *   capacities-only answer (the `max` run)        | + the grade lines of p. 238; the reading is verified, not stated_nothing
 *   grades + the top-up decoy, no row             | + the row
 *   predicates                                    | the anchor is the row, none of the seven decoys; grade forms
 *   an added window on a page's third line        | stops at that page's first line
 *   two valid ranges on two pages                 | both verbatim, in order, one `[…]`, stored excerpt equal
 *   one invalid range of two                      | dropped and logged, the other used
 *   every range invalid                           | unavailable; the extractor reads the narrowed text
 *   the old single-object reply                   | one range
 *   grades, decoys, no capacity anchor            | nothing added
 *   a two-span stored excerpt                     | D11's anchoring passes
 *   grades + the per-engine row alone (the live   | + the table from its `Capacidades` heading, so the column heads
 *     2026-09-27 answer, task 1.13)               |   reach the extractor, which then reads 3,3 L for the 1.0
 *   a one-figure row; a heading out of reach      | no table added; the table stops at the row's window
 *   a heading on the previous page; a web window  | the table starts on the row's page; it stays in the window
 *   with/without filter; "1.6L" beside a volume   | no table; the Gol's row still gets one (review of #190)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerScript as answerSteps, fakeTransport, responsesStream as sseResponse, userPromptOf } from "../model-calls/fake-openai.js";
import { citePages, locatePages, pagesForLines, type LocatedPages } from "../manuals/locate-pages.js";
import { GOL_2021_10, GOL_CAPACITIES_TABLE_HEAD, GOL_CAPACITY_ROW, GOL_DECOYS, GOL_GRADE_LINES, golPages } from "../manuals/fixtures/gol-located.js";
import { readForIdentity } from "../manuals/read-for-identity.js";
import { unanchoredValues } from "../retrieval/stored-manuals.js";
import type { OilSpecExtractor, RetrievedSource } from "./oil-spec.js";
import { capacityAnchors, ELISION, isGradeLine, litersFigures } from "./narrow-text.js";
import { completeSpans, createModelPassageSelector, type PassageSelection } from "./passage-selector.js";

const META = { publisher: "vw.com.br", document: "Manual Gol 2021", sourceClass: "manufacturer_manual" as const };

/** The numbered lines of the text the fake model was sent, by content. */
function numbered(prompt: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of prompt.split("\n")) {
    const match = /^(\d+): (.*)$/.exec(line);
    if (match) lines.set(Number(match[1]), match[2]!);
  }
  return lines;
}

/** The number of the line the model was shown with this text. */
function lineOf(prompt: string, text: string): number {
  for (const [number, line] of numbered(prompt)) if (line === text) return number;
  throw new Error(`not shown: ${text}`);
}

/** A fake model: answers with the reply `answer` builds from the prompt it received. */
function model(answer: (prompt: string) => unknown) {
  return fakeTransport((request) => {
    const prompt = userPromptOf(request);
    return sseResponse(answerSteps(JSON.stringify(answer(prompt))));
  });
}

/** Ranges around lines, by their text. */
const around = (prompt: string, first: string, last = first) => ({ startLine: lineOf(prompt, first), endLine: lineOf(prompt, last) });

/** A fake extractor that READS the passage: the grades and the 1.0 column's liters it prints. */
const reading: OilSpecExtractor = async (source) => {
  const text = source.content.kind === "text" ? source.content.text : "";
  const grades = [...text.matchAll(/SAE \d{1,2}W \d{2}/g)].map((match) => match[0]);
  const liters = text.includes("3,3 litros") ? 3.3 : null;
  return { viscosityGrades: grades, classification: "", fillLiters: liters, fillKind: liters ? "unlabeled" : null, engineCoverage: "one", enginesNamed: [] };
};

let located: LocatedPages;
let source: RetrievedSource;

async function select(answer: (prompt: string) => unknown): Promise<PassageSelection> {
  const transport = model(answer);
  const pending = createModelPassageSelector({ transport: transport.fetch })(source, GOL_2021_10, { lineToPage: located.lineToPage });
  await vi.advanceTimersByTimeAsync(1_000);
  return pending;
}

function passageOf(selection: PassageSelection): string {
  if (selection.status !== "selected" || selection.source.content.kind !== "text") throw new Error(`expected a passage, got ${selection.status}`);
  return selection.source.content.text;
}

beforeEach(() => {
  vi.useFakeTimers();
  process.env.OPENAI_API_KEY = "test-key-not-real";
  located = locatePages(golPages(), GOL_2021_10, 6);
  source = { publisher: META.publisher, document: META.document, page: citePages(located.pageNumbers), content: { kind: "text", text: located.text } };
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the fixture", () => {
  it("locates the six pages, long enough that the model is asked", () => {
    expect(located.pageNumbers).toEqual([96, 238, 239, 240, 270, 301]);
    expect(located.text.length).toBeGreaterThan(3_000);
  });
});

describe("completion over the Gol's located pages", () => {
  it("adds the capacities row to a grades-only answer, cites pp. 238, 301, and adds nothing of pp. 239–240", async () => {
    const selection = await select((prompt) => ({ ranges: [around(prompt, GOL_GRADE_LINES[0]!, GOL_GRADE_LINES[1]!)] }));

    const passage = passageOf(selection);
    expect(passage).toContain(GOL_CAPACITY_ROW.join("\n"));
    expect(passage).toContain(GOL_GRADE_LINES.join("\n"));
    for (const decoy of GOL_DECOYS) expect(passage).not.toContain(decoy);
    expect(selection.status === "selected" && citePages(pagesForLines(located, selection.lines))).toBe("pp. 238, 301");
  });

  it("adds the grade lines to a capacities-only answer, and the reading is verified", async () => {
    const transport = model((prompt) => ({ ranges: [around(prompt, GOL_CAPACITY_ROW[0]!, GOL_CAPACITY_ROW[1]!)] }));

    const pending = readForIdentity(
      { url: "https://www.vw.com.br/gol.pdf", pages: golPages(), identity: GOL_2021_10, meta: META, k: 6 },
      { selectPassage: createModelPassageSelector({ transport: transport.fetch }), extract: reading },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ status: "verified", citedPage: "pp. 238, 301" });
    expect(outcome.status === "verified" && outcome.excerpt).toContain(GOL_GRADE_LINES[0]);
  });

  it("adds the row when the answer holds the grades and the top-up note but not the row", async () => {
    const selection = await select((prompt) => ({
      ranges: [around(prompt, GOL_GRADE_LINES[0]!, GOL_GRADE_LINES[1]!), around(prompt, "(aproximadamente 0,5 l)")],
    }));

    expect(passageOf(selection)).toContain(GOL_CAPACITY_ROW.join("\n"));
  });

  it("keeps two valid ranges on two pages verbatim, in order, joined by one elision line, as the stored excerpt", async () => {
    const transport = model((prompt) => ({
      ranges: [around(prompt, GOL_CAPACITY_ROW[0]!, GOL_CAPACITY_ROW[1]!), around(prompt, GOL_GRADE_LINES[0]!, GOL_GRADE_LINES[1]!)],
    }));
    const extract = vi.fn(reading);

    const pending = readForIdentity(
      { url: "https://www.vw.com.br/gol.pdf", pages: golPages(), identity: GOL_2021_10, meta: META, k: 6 },
      { selectPassage: createModelPassageSelector({ transport: transport.fetch }), extract },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await pending;

    const lines = located.text.split("\n");
    const read = (extract.mock.calls[0]![0].content as { text: string }).text;
    const parts = read.split(`\n${ELISION}\n`);
    expect(parts).toHaveLength(2);
    // Grades (p. 238) first: line order, not the order the model answered.
    expect(parts[0]).toContain(GOL_GRADE_LINES[0]);
    expect(parts[1]).toContain(GOL_CAPACITY_ROW[0]);
    // Each part is a verbatim run of the located text's lines.
    for (const part of parts) expect(located.text).toContain(part);
    expect(lines.length).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ status: "verified", excerpt: read, citedPage: "pp. 238, 301" });
  });

  it("drops and logs an invalid range, and uses the other", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const selection = await select((prompt) => ({
      ranges: [{ startLine: 9_000, endLine: 9_001 }, around(prompt, GOL_GRADE_LINES[0]!, GOL_GRADE_LINES[1]!)],
    }));

    expect(passageOf(selection)).toContain(GOL_GRADE_LINES[0]);
    expect(logged).toHaveBeenCalledWith("passage-selector: range outside the text", JSON.stringify({ startLine: 9_000, endLine: 9_001 }));
  });

  it("is unavailable when every range is invalid, and the extractor then reads the narrowed text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const transport = model(() => ({ ranges: [{ startLine: 0, endLine: 3 }, { startLine: 9_000, endLine: 9_001 }] }));
    const extract = vi.fn(reading);

    const selection = await select(() => ({ ranges: [{ startLine: 0, endLine: 3 }] }));
    const pending = readForIdentity(
      { url: "https://www.vw.com.br/gol.pdf", pages: golPages(), identity: GOL_2021_10, meta: META, k: 6 },
      { selectPassage: createModelPassageSelector({ transport: transport.fetch }), extract },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await pending;

    expect(selection.status).toBe("unavailable");
    expect((extract.mock.calls[0]![0].content as { text: string }).text).toBe(located.text);
    expect(outcome).toMatchObject({ status: "verified", citedPage: citePages(located.pageNumbers) });
  });

  it("keeps a range's margin on its own page: a range opening p. 301 does not cite p. 270 (review of #184)", async () => {
    const selection = await select((prompt) => ({
      ranges: [around(prompt, GOL_GRADE_LINES[0]!, GOL_GRADE_LINES[1]!), around(prompt, "Dados técnicos", GOL_CAPACITY_ROW[1]!)],
    }));

    expect(selection.status === "selected" && citePages(pagesForLines(located, selection.lines))).toBe("pp. 238, 301");
  });

  it("reads the old single-object reply as one range", async () => {
    const selection = await select((prompt) => around(prompt, GOL_GRADE_LINES[0]!, GOL_GRADE_LINES[1]!));

    expect(passageOf(selection)).toContain(GOL_GRADE_LINES.join("\n"));
  });
});

describe("the anchor predicates", () => {
  it("find the capacities row as an anchor, and none of the seven decoys", () => {
    const lines = located.text.split("\n");
    const anchors = capacityAnchors(lines, located.lineToPage).map((anchor) => lines[anchor.line]);

    expect(anchors).toContain(GOL_CAPACITY_ROW[0]);
    for (const decoy of GOL_DECOYS) expect(anchors).not.toContain(decoy);
    // Every anchor is on p. 301.
    for (const anchor of capacityAnchors(lines, located.lineToPage)) expect(located.lineToPage[anchor.line]).toBe(301);
  });

  it.each(["0W-30", "0W30", "0W 30", "SAE 5W 40"])("reads %s as a grade line", (grade) => {
    expect(isGradeLine(`Viscosidade ${grade}`)).toBe(true);
  });

  it.each(GOL_DECOYS)("does not read the decoy %s as a grade line", (decoy) => {
    expect(isGradeLine(decoy)).toBe(false);
  });
});

describe("completeSpans", () => {
  it("stops an added window at its anchor's page boundary", () => {
    // p. 300 is five lines, p. 301 opens with its marker and has its row on its third line.
    const lines = ["=== página 300 ===", "a", "b", "c", "", "=== página 301 ===", "Capacidades", "Quantidade de óleo do motor", "3,3 litros", "d", "SAE 5W 40"];
    const lineToPage = [300, 300, 300, 300, 300, 301, 301, 301, 301, 301, 301];

    const spans = completeSpans(lines, [{ from: 10, to: 11 }], lineToPage);

    expect(spans[0]!.from).toBe(5);
    expect(lineToPage.slice(spans[0]!.from, spans[0]!.to).every((page) => page === 301)).toBe(true);
  });

  it("adds nothing to a text with grade lines and no capacity anchor, decoys and all", () => {
    const lines = [...GOL_GRADE_LINES, ...GOL_DECOYS];

    expect(completeSpans(lines, [{ from: 0, to: 2 }])).toEqual([{ from: 0, to: 2 }]);
  });
});

describe("a two-span stored excerpt", () => {
  it("passes the stored reading's anchoring (D11) with the grades and the liters", () => {
    const excerpt = [...GOL_GRADE_LINES, ELISION, ...GOL_CAPACITY_ROW].join("\n");

    expect(unanchoredValues(excerpt, ["0W-30", "0W-40", "5W-30", "5W-40", "10W-30", "10W-40"], 3.3)).toEqual([]);
  });
});

describe("the column heads of a per-engine capacities row (task 1.13)", () => {
  // What the live selector answered for the Gol 2021 on 2026-09-27: the grades, and the oil row
  // alone. With the ±3-line margin the column heads, 12 lines above the row, were cut.
  const liveAnswer = (prompt: string) => ({
    ranges: [around(prompt, GOL_GRADE_LINES[0]!, GOL_GRADE_LINES[1]!), around(prompt, GOL_CAPACITY_ROW[0]!, GOL_CAPACITY_ROW[1]!)],
  });

  it("keeps the table from its heading, so the engine columns reach the extractor", async () => {
    const passage = passageOf(await select(liveAnswer));

    expect(passage).toContain(GOL_CAPACITIES_TABLE_HEAD.join("\n"));
    expect(passage).toContain(GOL_CAPACITY_ROW.join("\n"));
    for (const decoy of GOL_DECOYS) expect(passage).not.toContain(decoy);
  });

  it("gives an extractor that needs the column heads the 1.0 column's 3,3 L", async () => {
    // Reads the liters only when the passage names the 1.0 column above the row, as a model must.
    const needsHeads: OilSpecExtractor = async (src) => {
      const text = src.content.kind === "text" ? src.content.text : "";
      const grades = [...text.matchAll(/SAE \d{1,2}W \d{2}/g)].map((match) => match[0]);
      const liters = text.includes("1.0 TOTALFLEX") && text.includes("3,3 litros") ? 3.3 : null;
      return { viscosityGrades: grades, classification: "", fillLiters: liters, fillKind: liters ? "unlabeled" : null, engineCoverage: liters ? "one" : "unknown", enginesNamed: [] };
    };
    const transport = model(liveAnswer);

    const pending = readForIdentity(
      { url: "https://www.vw.com.br/gol.pdf", pages: golPages(), identity: GOL_2021_10, meta: META, k: 6 },
      { selectPassage: createModelPassageSelector({ transport: transport.fetch }), extract: needsHeads },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({ status: "verified", citedPage: "pp. 238, 301", spec: { fillLiters: 3.3 } });
  });

  it("adds no table to a row with one figure, and stops at the row's window when the heading is out of reach", () => {
    const filler = (n: number) => Array.from({ length: n }, (_unused, i) => `linha ${i + 1}`);
    const one = ["Capacidades", ...filler(8), "Quantidade de óleo do motor", "3,5 litros"];
    expect(completeSpans(one, [{ from: 9, to: 11 }])).toEqual([{ from: 9, to: 11 }]);

    const far = ["Capacidades", ...filler(30), "Quantidade de óleo do motor", "3,3 litros 4 litros 4,5 litros"];
    // The row is line 31; the heading, 31 lines up, is past the 24-line reach: the window's top, 31 − 12.
    expect(completeSpans(far, [{ from: 31, to: 33 }])).toEqual([{ from: 19, to: 33 }]);
  });

  it("does not take a heading from the previous page, though it is within reach", () => {
    // p. 300 ends with a Capacidades heading; p. 301 opens 3 lines before its per-engine row.
    const lines = ["Capacidades", "linha a", "linha b", "linha c", "=== página 301 ===", "linha d", "linha e", "Quantidade de óleo do motor", "3,3 litros 4 litros 4,5 litros"];
    const lineToPage = [300, 300, 300, 300, 301, 301, 301, 301, 301];

    const spans = completeSpans(lines, [{ from: 7, to: 9 }], lineToPage);

    // Its own page's first line, not p. 300's heading (a reach of index − 24 alone would take line 0).
    expect(spans).toEqual([{ from: 4, to: 9 }]);
  });

  it("does not leave the window a narrowed web page showed the row in", () => {
    const filler = (n: number) => Array.from({ length: n }, (_unused, i) => `linha ${i + 1}`);
    // Heading at line 5, outside the shown window 10–40 but within 24 lines of the row at 20.
    const lines = [...filler(5), "Capacidades", ...filler(14), "Quantidade de óleo do motor", "3,3 litros 4 litros 4,5 litros", ...filler(18)];

    const spans = completeSpans(lines, [{ from: 20, to: 22 }], undefined, [{ from: 10, to: 40 }]);

    expect(spans).toEqual([{ from: 10, to: 22 }]);
  });
});

describe("what counts as one column per engine (review of #190)", () => {
  const withRow = (row: string[]) => ["Capacidades", "Potência do motor", "linha a", "linha b", "linha c", "linha d", ...row];

  it.each([
    ["one engine with and without the filter", ["Quantidade de óleo do motor", "3,3 litros (com filtro) 3,0 litros (sem filtro)"], [{ from: 6, to: 8 }]],
    ["an engine size beside the volume", ["Capacidade de óleo do motor 1.6L: 4,2 litros"], [{ from: 6, to: 7 }]],
  ])("adds no table for %s", (_name, row, spans) => {
    expect(completeSpans(withRow(row), spans)).toEqual(spans);
  });

  it("still adds the table for the Gol's row", () => {
    expect(completeSpans(withRow(GOL_CAPACITY_ROW), [{ from: 6, to: 8 }])).toEqual([{ from: 0, to: 8 }]);
  });

  it.each([
    ["3,3 litros 4 litros 4,5 litros", 3],
    ["3,3 litros (com filtro) 3,0 litros (sem filtro)", 0],
    ["3,0 l seco", 0],
    ["Capacidade de óleo do motor 1.6L: 4,2 litros", 1],
    ["motor 1,0 l: 3,5 l", 1],
  ])("counts %j as %i columns", (line, count) => {
    expect(litersFigures(line)).toBe(count);
  });
});
