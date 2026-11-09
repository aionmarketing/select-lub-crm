/**
 * Test design (testing-strategy)
 *
 * SUT: how search hits become candidates (internal/retrieval/search-hits.ts) — the classifier
 * answers by index into the tool's own results and can never supply a URL; two queries' hits
 * are merged once per page. No socket, no model.
 *
 * Split by topic under the 300-line cap (adopt-modular-vertical-slices 2B.1): each test
 * file now sits beside the source file it exercises — web-search.test.ts (the adapter's
 * flow), web-search.budgets.test.ts (its budgets and harvested links), search-hits.test.ts,
 * openai-search.test.ts and search-cost.test.ts. The shared axes and decision map are in
 * web-search.test.ts's header.
 * Each section below keeps the design block it had in the original file.
 */
import { describe, expect, it, vi } from "vitest";
import { createWebSearchRetriever } from "./web-search.js";
import {
  buildManualQuery,
  formatHits,
  mergeHits,
  parseVerdicts,
  type SearchHit,
} from "./search-hits.js";
import type { SearchCandidate } from "./admit.js";
import type { FetchTransport } from "./page-fetcher.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = {
  make: "Honda",
  year: 2021,
  model: "HR-V",
  version: "1.8 16V",
};

/** A transport that serves HTML for anything except the PDF, which it reports as a document. */
function transportFor(htmlUrls: string[]): FetchTransport {
  return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
    if (url.endsWith("/robots.txt")) {
      return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
    }
    const isPdf = url.includes(".pdf");
    const type = isPdf ? "application/pdf" : "text/html";
    if (init.method === "HEAD") {
      return { status: 200, headers: { get: () => type }, text: async () => "" };
    }
    if (!htmlUrls.includes(url)) {
      return { status: 404, headers: { get: () => type }, text: async () => "" };
    }
    return {
      status: 200,
      headers: { get: () => type },
      text: async () => "<html><title>T</title><body><p>0W-20 — 3,7 L</p></body></html>",
    };
  }) as unknown as FetchTransport;
}

/**
 * Added with the results-driven search step (owner decision 2026-09-14).
 *
 * Oracle: the search MUST NOT accept a source from the model's memory. The model classifies
 * the tool's results BY INDEX; every URL in the output is copied from the tool's list. On
 * 2026-09-14, asked to write URLs instead, it produced 0 of 7-10 the tool had found.
 *
 * Axes
 *   H1 verdict index — in range / 0 / past the end / non-integer / repeated
 *   H2 verdict shape — classification string / classification missing / reason missing
 *   H3 reply — fenced JSON / bare JSON / prose / JSON without `verdicts`
 *
 * Outputs: O1 the candidates, each URL and title from the hit at that index; O2 the list text
 *
 * Sampled cells (one row per `it`)
 *   in range, fenced          | H1,H3 | O1 url + title copied from the hit | fails if the
 *      model could name a URL of its own
 *   past the end / zero       | H1    | O1 skipped, no throw
 *   repeated index            | H1    | O1 first wins
 *   classification missing    | H2    | O1 skipped; reason missing → empty string
 *   prose / no verdicts key   | H3    | O1 empty
 *   formatHits                | O2    | numbered, link on its own line, content capped
 *
 * Decision map of parseVerdicts: no JSON / JSON.parse throws / verdicts not array / entry not
 * object / index out of range / classification not string / seen — each false path is the
 * happy cell, each true path its own row above.
 */
describe("parseVerdicts", () => {
  const hits: SearchHit[] = [
    { link: "https://www.vw.com.br/pt/manuais.html", title: "Manuais VW", content: "…" },
    { link: "https://carrorac.com/polo.html", title: "CarroRac Polo", content: "…" },
  ];

  it("maps an in-range verdict back to the hit's own URL and title", () => {
    const out = parseVerdicts(
      '```json\n{"verdicts":[{"index":2,"classification":"aftermarket_catalog","reason":"catálogo"}]}\n```',
      hits,
    );

    expect(out).toEqual([
      { url: "https://carrorac.com/polo.html", classification: "aftermarket_catalog", reason: "catálogo", title: "CarroRac Polo" },
    ]);
  });

  it("skips an index outside the list without throwing", () => {
    const out = parseVerdicts('{"verdicts":[{"index":0,"classification":"other"},{"index":3,"classification":"other"}]}', hits);

    expect(out).toEqual([]);
  });

  it("lets the first verdict for an index win", () => {
    const out = parseVerdicts(
      '{"verdicts":[{"index":1,"classification":"manufacturer_manual"},{"index":1,"classification":"other"}]}',
      hits,
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.classification).toBe("manufacturer_manual");
  });

  it("skips a verdict with no classification and tolerates a missing reason", () => {
    const out = parseVerdicts('{"verdicts":[{"index":1},{"index":2,"classification":"other"}]}', hits);

    expect(out).toEqual([{ url: hits[1]!.link, classification: "other", reason: "", title: "CarroRac Polo" }]);
  });

  it("returns nothing for prose, malformed JSON, or JSON without verdicts", () => {
    expect(parseVerdicts("não classifiquei nada", hits)).toEqual([]);
    expect(parseVerdicts("{not json", hits)).toEqual([]);
    expect(parseVerdicts('{"candidates":[]}', hits)).toEqual([]);
  });
});

describe("formatHits", () => {
  it("numbers the hits from 1 and caps each content snippet", () => {
    const text = formatHits([{ link: "https://x.test/a", title: "A", content: "z".repeat(2_000) }]);

    expect(text.startsWith("1. A\n   https://x.test/a\n   ")).toBe(true);
    expect(text.length).toBeLessThan(700);
  });
});

/**
 * Added with the second, manufacturer-manual tool call (owner decision 2026-09-14).
 *
 * Oracle: design D2 (revised) — the vehicle query finds application pages, the manual query
 * finds the manufacturer's own pages, and the classifier sees each page once.
 *
 * Axes
 *   M1 the port receives the manual query — yes (always, from the identity)
 *   M2 overlap between the two hit lists — none / same page / same page, different query string
 *
 * Sampled cells (one row per `it`)
 *   manual query text     | M1 | names make, model, year, "manual do proprietário", "site oficial"
 *   port receives it      | M1 | the fourth argument | fails if the second tool call never
 *      gets the query that finds tier-1 pages
 *   merge keeps order     | M2 | vehicle hits first, manual hits after, each page once
 *   merge dedupes by page | M2 | a tracking query string does not make a page appear twice
 */
describe("two queries", () => {
  it("builds a manufacturer-manual query from the identity", () => {
    expect(buildManualQuery(identity)).toBe("Honda manual do proprietário HR-V 2021 pdf site oficial");
  });

  it("hands the search port the manual query as well", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number, manual?: string) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([]);

    await createWebSearchRetriever({ search, transport: transportFor([]), log: () => {} })(identity);

    expect(search.mock.calls[0]![3]).toBe(buildManualQuery(identity));
  });

  it("merges hit lists in order, keeping each page once", () => {
    const a: SearchHit[] = [{ link: "https://x.test/a", title: "A", content: "" }];
    const b: SearchHit[] = [
      { link: "https://x.test/a?utm_source=y", title: "A again", content: "" },
      { link: "https://x.test/b", title: "B", content: "" },
    ];

    const out = mergeHits(a, b);

    expect(out.map((h) => h.title)).toEqual(["A", "B"]);
  });
});
