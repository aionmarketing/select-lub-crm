/**
 * Test design (testing-strategy)
 *
 * SUT: `chooseDocumentLinks`, and the selector's reply parsing. Pure: the selector is an
 *   injected function, so no model and no network is reached.
 *
 * Oracle: oil-quote-retrieval-hardening task 5.2 and D8; oil-source-candidates "Harvested
 *   documents are selected by their labels, and recorded as leads":
 *   - under the cap, every document is recorded and the selector is not asked;
 *   - over it, the selector's ranking is recorded with its reasons;
 *   - a selector failure falls back to labelled-first, then the page order;
 *   - an unlabelled document never displaces a labelled one;
 *   - the selector picks by index, so a pick outside the list is ignored.
 */
import { describe, expect, it, vi } from "vitest";
import type { VehicleIdentity } from "../store/store.js";
import {
  chooseDocumentLinks,
  FALLBACK_SELECTION_REASON,
  parseLinkPicks,
  tokenUsageOf,
  type DocumentLinkSelector,
} from "./document-links.js";
import type { DocumentLink } from "./page-fetcher.js";

const identity: VehicleIdentity = { make: "VW", year: 2021, model: "Polo", version: "1.0 TSI" };

function links(count: number, label: (index: number) => string | null = (index) => `Manual ${index}`): DocumentLink[] {
  return Array.from({ length: count }, (_unused, index) => ({ url: `https://www.vw.com.br/d/${index}.pdf`, label: label(index) }));
}

describe("chooseDocumentLinks", () => {
  it("records every document under the cap without asking the selector", async () => {
    const selector = vi.fn<DocumentLinkSelector>();

    const chosen = await chooseDocumentLinks(links(3), identity, selector, 5);

    expect(selector).not.toHaveBeenCalled();
    expect(chosen.map((link) => [link.url, link.selectionReason])).toEqual([
      ["https://www.vw.com.br/d/0.pdf", null],
      ["https://www.vw.com.br/d/1.pdf", null],
      ["https://www.vw.com.br/d/2.pdf", null],
    ]);
  });

  it("records the selector's ranking over the cap, with its reasons", async () => {
    const selector = vi.fn<DocumentLinkSelector>(async () => [
      { index: 7, reason: "rótulo nomeia o Polo 2021" },
      { index: 2, reason: "Polo, outro ano" },
    ]);

    const chosen = await chooseDocumentLinks(links(10), identity, selector, 5);

    // With no web budget given, nothing but the call's own limits bounds it (D2).
    expect(selector).toHaveBeenCalledWith(links(10), identity, 5, { timeoutMs: Number.POSITIVE_INFINITY });
    expect(chosen).toEqual([
      { url: "https://www.vw.com.br/d/7.pdf", label: "Manual 7", selectionReason: "rótulo nomeia o Polo 2021" },
      { url: "https://www.vw.com.br/d/2.pdf", label: "Manual 2", selectionReason: "Polo, outro ano" },
    ]);
  });

  it("falls back to the page order, labelled first, when the selector fails or answers nothing usable", async () => {
    const failing = vi.fn<DocumentLinkSelector>(async () => {
      throw new Error("timeout");
    });
    const empty = vi.fn<DocumentLinkSelector>(async () => null);
    const outOfRange = vi.fn<DocumentLinkSelector>(async () => [{ index: 99, reason: "invented" }]);

    for (const selector of [failing, empty, outOfRange, undefined]) {
      const chosen = await chooseDocumentLinks(links(6), identity, selector, 3);
      expect(chosen.map((link) => link.url)).toEqual([
        "https://www.vw.com.br/d/0.pdf",
        "https://www.vw.com.br/d/1.pdf",
        "https://www.vw.com.br/d/2.pdf",
      ]);
      expect(chosen.every((link) => link.selectionReason === FALLBACK_SELECTION_REASON)).toBe(true);
    }
  });

  it("never lets an unlabelled document displace a labelled one", async () => {
    // Indexes 0-2 unlabelled, 3-5 labelled. The selector ranks two unlabelled first.
    const mixed = links(6, (index) => (index < 3 ? null : `Manual ${index}`));
    const selector = vi.fn<DocumentLinkSelector>(async () => [
      { index: 0, reason: "a" },
      { index: 1, reason: "b" },
      { index: 4, reason: "c" },
    ]);

    const chosen = await chooseDocumentLinks(mixed, identity, selector, 2);

    // The labelled pick is kept; only one unlabelled pick fits after it.
    expect(chosen.map((link) => link.url)).toEqual(["https://www.vw.com.br/d/4.pdf", "https://www.vw.com.br/d/0.pdf"]);
  });

  it("records each pick once", async () => {
    const selector = vi.fn<DocumentLinkSelector>(async () => [
      { index: 1, reason: "first" },
      { index: 1, reason: "again" },
    ]);

    const chosen = await chooseDocumentLinks(links(6), identity, selector, 3);

    expect(chosen.map((link) => [link.url, link.selectionReason])).toEqual([["https://www.vw.com.br/d/1.pdf", "first"]]);
  });
});

describe("parseLinkPicks", () => {
  it("reads the picks, and refuses prose", () => {
    expect(parseLinkPicks('```json\n{"picks":[{"index":3,"reason":"Polo 2021"}]}\n```')).toEqual([
      { index: 3, reason: "Polo 2021" },
    ]);
    expect(parseLinkPicks('{"picks":[{"index":"3"},{"index":4}]}')).toEqual([{ index: 4, reason: "" }]);
    expect(parseLinkPicks("não sei")).toBeNull();
    expect(parseLinkPicks('{"other":[]}')).toBeNull();
  });
});

// Orchestrator review of #175: the selector is bounded by the web search's clock, and its tokens
// are counted in the same split `costUsdOf` prices. background-oil-research D2 removed the
// fixed 15 s: the clock's signal is its outer bound, and its own limits are its model's.
describe("the selector's budget", () => {
  it("hands the selector the web search's time left and its signal, not a fixed 15 s", async () => {
    const selector = vi.fn<DocumentLinkSelector>(async () => null);
    const signal = new AbortController().signal;

    await chooseDocumentLinks(links(6), identity, selector, 3, { timeoutMs: 60_000, signal });

    expect(selector.mock.calls[0]![3]).toEqual({ timeoutMs: 60_000, signal });
  });

  it("does not ask with under a second left, and records the page order", async () => {
    const selector = vi.fn<DocumentLinkSelector>(async () => [{ index: 5, reason: "r" }]);

    const chosen = await chooseDocumentLinks(links(6), identity, selector, 3, { timeoutMs: 999 });

    expect(selector).not.toHaveBeenCalled();
    expect(chosen.map((link) => link.selectionReason)).toEqual(Array(3).fill(FALLBACK_SELECTION_REASON));
  });

  it("splits the SDK's usage into cached input, and reasoning apart from output", () => {
    expect(
      tokenUsageOf({
        inputTokens: 1_000,
        inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: undefined },
        outputTokens: 700,
        outputTokenDetails: { textTokens: 100, reasoningTokens: 600 },
        totalTokens: 1_700,
      }),
    ).toEqual({ input: 800, cachedInput: 200, reasoning: 600, output: 100 });
  });
});
