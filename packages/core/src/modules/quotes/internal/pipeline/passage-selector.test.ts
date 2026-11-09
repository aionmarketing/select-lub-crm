/**
 * Test design (testing-strategy)
 *
 * SUT: the passage selector's pure helpers and the deterministic guards of the production
 * selector (apps/api/src/oil-quote/pipeline/passage-selector.ts). No socket: the model call
 * is reached only past guards this file drives to every other outcome, and the one cell that
 * would call it is out of scope here (D9) and exercised by the showcase script.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md "the passage handed to the extractor SHALL be the
 * part of the page about the resolved vehicle, not the whole page", and the excerpt
 * requirement (the stored passage is verbatim page text).
 *
 * Axes
 *   R1 proposed range vs page — inside / start below 1 / end past the last line / end before
 *      start / non-integer
 *   R2 margin — zero / default, near the edges
 *   P1 reply shape — {none:true} / a range / prose / an object with neither
 *   G1 source kind — text / motul_flatten
 *   G2 text length — empty / ≤ short-page threshold / above it
 *   G3 OPENAI_API_KEY — set / unset
 *
 * Outputs
 *   O1 the sliced passage or null      O2 the parsed selection or null
 *   O3 the PassageSelection status      O4 the narrowed source's text and excerpt
 *
 * Sampled cells (one row per `it`)
 *   numbered lines                | —     | 1-based prefix on every line
 *   range inside, default margin  | R1,R2 | O1 includes the margin lines
 *   range at the edges, margin    | R2    | O1 clamps, never throws
 *   start below 1                 | R1    | O1 null
 *   end past the page             | R1    | O1 null | THE guard: a model that names line
 *      500 of a 40-line page must fall back, not slice garbage
 *   end before start              | R1    | O1 null
 *   non-integer                   | R1    | O1 null
 *   reply none                    | P1    | O2 {none:true}
 *   reply range                   | P1    | O2 the range
 *   reply prose                   | P1    | O2 null
 *   reply neither                 | P1    | O2 null
 *   narrow                        | —     | O4 text and excerpt are the same string
 *   motul source                  | G1    | O3 selected, untouched — nothing to narrow
 *   empty text                    | G2    | O3 none
 *   short page                    | G2    | O3 selected whole, no key needed | fails if a
 *      page the extractor could read in one go costs a model call
 *   long page, no key             | G2,G3 | O3 unavailable — never a throw
 *
 * Decision map of createModelPassageSelector
 *   kind !== "text"              both: motul test vs the rest
 *   text.trim() === ""           both: empty test vs the rest
 *   length <= SHORT_PAGE_CHARS   both: short-page test vs long-page test
 *   !OPENAI_API_KEY                 true: long-page test; false: out of scope (socket)
 *   reply null / none / range / bad range / throw   out of scope here (needs the model);
 *      the pure pieces each path uses are the helper tests above
 *
 * Out of scope: the real model reply (showcase script), how resolveOilSpec consumes a
 * selection (oil-spec.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createModelPassageSelector,
  narrow,
  numberLines,
  PASSAGE_SHORT_PAGE_CHARS,
  parseSelection,
  selectedSpan,
  sliceRange,
} from "../pipeline/passage-selector.js";
import type { RetrievedSource } from "../pipeline/oil-spec.js";

const identity = { make: "Volkswagen", year: 2021, model: "Polo", version: "1.0 TSI" };

function textSource(text: string): RetrievedSource {
  return {
    publisher: "vw.com.br",
    document: "Capacidades",
    page: "Capacidades",
    content: { kind: "text", text },
  };
}

const page = Array.from({ length: 40 }, (_unused, i) => `linha ${i + 1}`).join("\n");

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

describe("numberLines", () => {
  it("prefixes every line with its 1-based number", () => {
    expect(numberLines("a\nb")).toBe("1: a\n2: b");
  });
});

describe("sliceRange", () => {
  it("keeps the range plus the margin on both sides", () => {
    const out = sliceRange(page, { startLine: 10, endLine: 12 });

    expect(out?.split("\n")[0]).toBe("linha 7");
    expect(out?.split("\n").at(-1)).toBe("linha 15");
  });

  it("clamps the margin at the edges of the page", () => {
    const out = sliceRange(page, { startLine: 1, endLine: 40 });

    expect(out?.split("\n")).toHaveLength(40);
  });

  it("rejects a start below the first line", () => {
    expect(sliceRange(page, { startLine: 0, endLine: 3 })).toBeNull();
  });

  it("rejects an end past the last line", () => {
    // The guard that matters: a model naming line 500 of a 40-line page must fall back.
    expect(sliceRange(page, { startLine: 3, endLine: 500 })).toBeNull();
  });

  it("rejects an end before the start", () => {
    expect(sliceRange(page, { startLine: 12, endLine: 10 })).toBeNull();
  });

  it("rejects a non-integer line", () => {
    expect(sliceRange(page, { startLine: 1.5, endLine: 3 })).toBeNull();
  });
});

describe("parseSelection", () => {
  it("reads none", () => {
    expect(parseSelection('{"none": true}')).toEqual({ none: true });
  });

  it("reads the old single-range reply, fenced, as one range", () => {
    expect(parseSelection('```json\n{"startLine": 4, "endLine": 9}\n```')).toEqual({ ranges: [{ startLine: 4, endLine: 9 }] });
  });

  it("reads several ranges, and keeps only the first OIL_SELECTOR_MAX_RANGES", () => {
    const reply = JSON.stringify({ ranges: [1, 2, 3, 4, 5].map((n) => ({ startLine: n, endLine: n })) });

    expect(parseSelection(reply)).toEqual({ ranges: [1, 2, 3, 4].map((n) => ({ startLine: n, endLine: n })) });
    expect(parseSelection(reply, 2)).toEqual({ ranges: [{ startLine: 1, endLine: 1 }, { startLine: 2, endLine: 2 }] });
  });

  it("drops a ranges entry that is not a pair of numbers", () => {
    expect(parseSelection('{"ranges": [{"startLine": "3"}, {"startLine": 5, "endLine": 6}]}')).toEqual({
      ranges: [{ startLine: 5, endLine: 6 }],
    });
  });

  it("returns null for prose", () => {
    expect(parseSelection("o trecho fica no meio da página")).toBeNull();
  });

  it("returns null for an object that is neither", () => {
    expect(parseSelection('{"lines": [1, 2]}')).toBeNull();
  });
});

describe("narrow", () => {
  it("makes the extractor's text and the stored excerpt the same passage", () => {
    const out = narrow(textSource(page), "linha 9\nlinha 10");

    expect(out.content).toEqual({ kind: "text", text: "linha 9\nlinha 10" });
    expect(out.excerpt).toBe("linha 9\nlinha 10");
    expect(out.publisher).toBe("vw.com.br");
  });
});

describe("createModelPassageSelector guards", () => {
  it("passes a Motul payload through untouched", async () => {
    const source: RetrievedSource = {
      publisher: "Motul",
      document: "Oil Advisor",
      page: "Polo",
      content: { kind: "motul_flatten", recommendation: { vehicle: "x", parts: {} } },
    };

    const out = await createModelPassageSelector()(source, identity);

    expect(out).toEqual({ status: "selected", source });
  });

  it("says none for an empty page", async () => {
    expect(await createModelPassageSelector()(textSource("  \n "), identity)).toEqual({ status: "none" });
  });

  it("hands a short page over whole without a model call or a key", async () => {
    const source = textSource("x".repeat(PASSAGE_SHORT_PAGE_CHARS));

    const out = await createModelPassageSelector()(source, identity);

    // The whole page, one line: the span says so, for a caller that maps lines to pages.
    expect(out).toEqual({ status: "selected", source, lines: [{ from: 0, to: 1 }] });
  });

  it("reports unavailable, not a throw, for a long page with no key", async () => {
    const source = textSource("x".repeat(PASSAGE_SHORT_PAGE_CHARS + 1));

    const out = await createModelPassageSelector()(source, identity);

    expect(out).toEqual({ status: "unavailable" });
  });
});

/**
 * Review of #184: a manual range's margin stays on the pages of its own ends (3a), and a
 * narrowed web page's range must end on lines the model was shown, its margin inside the
 * windows it saw (3b).
 */
describe("selectedSpan", () => {
  const manual = ["a", "b", "c", "=== página 301 ===", "Capacidades", "x"];
  const lineToPage = [300, 300, 300, 301, 301, 301];

  it("keeps the margin of a range at the top of a page on that page", () => {
    expect(selectedSpan(manual.join("\n"), { startLine: 4, endLine: 5 }, lineToPage)).toEqual({ from: 3, to: 6 });
  });

  it("keeps the margin of a range at the bottom of a page on that page", () => {
    expect(selectedSpan(manual.join("\n"), { startLine: 2, endLine: 3 }, lineToPage)).toEqual({ from: 0, to: 3 });
  });

  it("widens a range across a page break to both of its pages, and no further", () => {
    expect(selectedSpan(manual.join("\n"), { startLine: 3, endLine: 4 }, lineToPage)).toEqual({ from: 0, to: 6 });
  });

  const shown = [{ from: 10, to: 20 }];

  it("clips a web range's margin to the window the model saw", () => {
    expect(selectedSpan(page, { startLine: 12, endLine: 13 }, undefined, shown)).toEqual({ from: 10, to: 16 });
  });

  it.each([
    [{ startLine: 30, endLine: 31 }],
    [{ startLine: 11, endLine: 25 }],
    [{ startLine: 5, endLine: 12 }],
  ])("rejects a web range %j that ends on a line the model was not shown", (range) => {
    expect(selectedSpan(page, range, undefined, shown)).toBeNull();
  });
});
