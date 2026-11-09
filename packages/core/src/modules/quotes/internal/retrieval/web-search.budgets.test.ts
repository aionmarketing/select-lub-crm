/**
 * Test design (testing-strategy)
 *
 * SUT: createWebSearchRetriever's budgets and harvested links (internal/retrieval/web-search.ts)
 * — which admitted pages a quote can afford to read, in what order, and what a gateway page's
 * links become. The search step, the transport, the clock and the log are injected fakes.
 *
 * Split by topic under the 300-line cap (adopt-modular-vertical-slices 2B.1): each test
 * file now sits beside the source file it exercises — web-search.test.ts (the adapter's
 * flow), web-search.budgets.test.ts (its budgets and harvested links), search-hits.test.ts,
 * openai-search.test.ts and search-cost.test.ts. The shared axes and decision map are in
 * web-search.test.ts's header.
 * Each section below keeps the design block it had in the original file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { byTier, createWebSearchRetriever, type WebSearchLog } from "./web-search.js";
import type { SearchCandidate } from "./admit.js";
import type { FetchTransport } from "./page-fetcher.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = {
  make: "Honda",
  year: 2021,
  model: "HR-V",
  version: "1.8 16V",
};

function candidate(url: string, classification: string): SearchCandidate {
  return { url, classification, reason: `classificado como ${classification}`, title: `Página ${url}` };
}

/** Collects the adapter's structured log. */
function collector() {
  const entries: WebSearchLog[] = [];
  return { entries, log: (e: WebSearchLog) => entries.push(e) };
}

afterEach(() => {
  delete process.env.WEB_SEARCH_ENABLED;
  delete process.env.WEB_SEARCH_MAX_FETCHES;
  delete process.env.WEB_SEARCH_MAX_ATTEMPTS;
  delete process.env.WEB_SEARCH_TIMEOUT_MS;
});

/**
 * Test design (testing-strategy)
 *
 * SUT: the adapter's gateway-link harvesting and its enforcement of the wall clock
 * (apps/api/src/oil-quote/web-search.ts). Search, transport and clock are injected fakes.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md — a document the adapter finds is recorded as a
 * manual candidate rather than fetched, and the per-quote budget bounds the whole run.
 *
 * Both cases exist because a live run disproved the code. The 2026-09-10 showcase spent 573
 * seconds inside one search against a 60 s budget, because the clock was only ever read
 * BEFORE starting work; and vw.com.br's manuals page reduced to 19k characters that never
 * mention oil while its 264 PDF links — including the exact Polo MY2021 manual — were thrown
 * away by the reducer.
 *
 * Axes
 *   H1 links on an accepted page — none / same-origin document / one already recorded
 *   H2 the linking page's class — manufacturer_manual / aftermarket_catalog
 *   B1 budget passed to the search — first pass / second pass after time has passed
 *
 * Outputs
 *   O1 manualCandidates, with `discoveredVia`
 *   O2 the budget argument each search call receives
 *
 * Sampled cells (one row per `it`)
 *   accepted page links a PDF   | H1,H2 | O1 candidate inherits the page's class and tier
 *      and names the page in `discoveredVia` | fails if a harvested document arrives
 *      indistinguishable from one the model itself classified
 *   catalog page links a PDF    | H2    | O1 tier 5, not 1 | fails if harvested documents
 *      are assumed to be manuals
 *   link duplicates a candidate | H1    | O1 recorded once
 *   two passes                  | B1    | O2 the budget shrinks and never exceeds the limit
 *      | fails if the search is handed the full budget again on the second pass
 *
 * Out of scope: which links are harvested and how they are ordered (page-fetcher.test.ts);
 * whether the real provider honours an abort (a script, not a test — D9 forbids sockets).
 */
describe("gateway links become manual candidates", () => {
  const GATEWAY = "https://vw.com.br/pt/manuais.html";
  const LINKED_PDF = "https://vw.com.br/dam/hr-v-2021.pdf";

  /** Serves the gateway as HTML whose body links one same-origin PDF. */
  function gatewayTransport(): FetchTransport {
    return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
      if (url.endsWith("/robots.txt")) {
        return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
      }
      const isPdf = url.includes(".pdf");
      const type = isPdf ? "application/pdf" : "text/html";
      if (init.method === "HEAD") {
        return { status: 200, headers: { get: () => type }, text: async (): Promise<string> => "" };
      }
      return {
        status: 200,
        headers: { get: () => type },
        text: async (): Promise<string> =>
          `<html><title>Manuais</title><body><a href="${LINKED_PDF}">Manual HR-V 2021</a></body></html>`,
      };
    }) as unknown as FetchTransport;
  }

  it("records a PDF the accepted page links, naming the page it came from", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([candidate(GATEWAY, "manufacturer_manual")]);

    const result = await createWebSearchRetriever({
      search,
      transport: gatewayTransport(),
      log: () => {},
    })(identity);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.manualCandidates).toEqual([
      {
        url: LINKED_PDF,
        publisher: "vw.com.br",
        classification: "manufacturer_manual",
        tier: 1,
        discoveredVia: GATEWAY,
        // The anchor's text is the label; one link is under the cap, so nothing was chosen.
        label: "Manual HR-V 2021",
        selectionReason: null,
      },
    ]);
  });

  it("gives a harvested document the linking page's tier, not tier 1 by assumption", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([candidate(GATEWAY, "aftermarket_catalog")]);

    const result = await createWebSearchRetriever({
      search,
      transport: gatewayTransport(),
      log: () => {},
    })(identity);

    if (result.status !== "found") throw new Error("expected found");
    expect(result.manualCandidates?.[0]).toMatchObject({ tier: 5, classification: "aftermarket_catalog" });
  });

  it("records a linked document once when the search also named it", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([
        candidate(LINKED_PDF, "manufacturer_manual"),
        candidate(GATEWAY, "manufacturer_manual"),
      ]);

    const result = await createWebSearchRetriever({
      search,
      transport: gatewayTransport(),
      log: () => {},
    })(identity);

    if (result.status !== "found") throw new Error("expected found");
    expect(result.manualCandidates?.filter((m) => m.url === LINKED_PDF)).toHaveLength(1);
  });
});

/**
 * Added by oil-quote-retrieval-hardening task 2.1.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md "The search is budgeted and time-boxed per
 * quote" as modified by this change — reads and attempts are separate caps, a failure before
 * the body is read spends only an attempt, and admitted candidates are tried highest tier
 * first, then in the order the search ranked them.
 *
 * Axes
 *   B1 outcome of each attempt — HTML read / 404 / document refusal
 *   B2 read cap — under / reached
 *   B3 attempt cap — under / reached with everything dead
 *   B4 tier order vs search order — agree / disagree
 *
 * Outputs: O1 which pages were read; O2 the log outcome naming the cap; O3 the order of
 *          fetch calls; O4 manual candidates
 *
 * Sampled cells (one row per `it`)
 *   three 404s then HTML   | B1,B2 | O1 the HTML page IS read | THE case: with one cap the
 *      three corpses ate the budget and the real page was never tried (measured on the Polo)
 *   everything dead        | B3    | O2 stops at the attempt cap rather than trying all
 *   tier 1 behind tier 5   | B4,B2 | O3 the tier-1 URL is fetched first, O4 recorded as a
 *      manual candidate; the tier-5 shop is what goes unfetched (the HR-V case)
 *   stable within a tier   | B4    | O3 two tier-5 pages keep the search's order
 *   read cap reached       | B2    | O2 outcome says "read cap reached", not "out of time"
 */
describe("read and attempt budgets", () => {
  /** A transport where only `htmlUrls` answer with HTML; everything else 404s. */
  function transportWith(htmlUrls: string[], pdfUrls: string[] = []): FetchTransport {
    return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
      if (url.endsWith("/robots.txt")) {
        return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
      }
      const isPdf = pdfUrls.includes(url);
      const type = isPdf ? "application/pdf" : "text/html";
      if (init.method === "HEAD") {
        return {
          status: isPdf || htmlUrls.includes(url) ? 200 : 404,
          headers: { get: () => type },
          text: async (): Promise<string> => "",
        };
      }
      if (!htmlUrls.includes(url)) {
        return { status: 404, headers: { get: () => type }, text: async (): Promise<string> => "" };
      }
      return {
        status: 200,
        headers: { get: () => type },
        text: async (): Promise<string> => "<html><title>T</title><body><p>0W-20 — 3,7 L</p></body></html>",
      };
    }) as unknown as FetchTransport;
  }

  const dead = ["https://a.test/1", "https://b.test/2", "https://c.test/3"];
  const alive = "https://d.test/4";

  it("reads the live page after three dead URLs, because failures spend only attempts", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number, manual?: string) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([...dead, alive].map((u) => candidate(u, "aftermarket_catalog")));
    const { entries, log } = collector();

    const result = await createWebSearchRetriever({
      search,
      transport: transportWith([alive]),
      log,
    })(identity);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.url).toBe(alive);
    expect(entries[0]?.fetched).toBe(1);
  });

  it("stops at the attempt cap when every URL is dead", async () => {
    process.env.WEB_SEARCH_MAX_ATTEMPTS = "2";
    const search = vi
      .fn<(m: string, q: string, b: number, manual?: string) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([...dead, alive].map((u) => candidate(u, "aftermarket_catalog")));
    const { entries, log } = collector();

    const result = await createWebSearchRetriever({ search, transport: transportWith([]), log })(identity);

    expect(result.status).toBe("none");
    const outcomes = entries[0]!.passes[0]!.candidates.map((c) => c.outcome);
    expect(outcomes.filter((o) => o.includes("attempt cap reached")).length).toBeGreaterThan(0);
  });

  it("attempts a tier-1 document before a tier-5 shop the search ranked first", async () => {
    // The HR-V case: the vehicle query's shops arrived first and the manufacturer PDF the
    // manual query found was never attempted.
    process.env.WEB_SEARCH_MAX_FETCHES = "1";
    const shop = "https://shop.test/oleo";
    const manual = "https://honda.com.br/manual-hr-v.pdf";
    const search = vi
      .fn<(m: string, q: string, b: number, manual?: string) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([candidate(shop, "aftermarket_catalog"), candidate(manual, "manufacturer_manual")]);

    const result = await createWebSearchRetriever({
      search,
      transport: transportWith([shop], [manual]),
      log: () => {},
    })(identity);

    if (result.status !== "none" && result.status !== "found") throw new Error("unexpected");
    expect(result.manualCandidates?.map((m) => m.url)).toEqual([manual]);
  });

  it("keeps the search's order within one tier", () => {
    const admitted = [
      { admitted: true as const, url: "https://a.test/", tier: 5 as const, classification: "aftermarket_catalog" as const, reason: "", title: null },
      { admitted: true as const, url: "https://b.test/", tier: 1 as const, classification: "manufacturer_manual" as const, reason: "", title: null },
      { admitted: true as const, url: "https://c.test/", tier: 5 as const, classification: "aftermarket_catalog" as const, reason: "", title: null },
    ];

    expect(byTier(admitted).map((a) => a.url)).toEqual([
      "https://b.test/",
      "https://a.test/",
      "https://c.test/",
    ]);
  });

  it("names the read cap, not the clock, when reads are what ran out", async () => {
    process.env.WEB_SEARCH_MAX_FETCHES = "1";
    const second = "https://e.test/5";
    const search = vi
      .fn<(m: string, q: string, b: number, manual?: string) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([alive, second].map((u) => candidate(u, "aftermarket_catalog")));
    const { entries, log } = collector();

    await createWebSearchRetriever({ search, transport: transportWith([alive, second]), log })(identity);

    const outcomes = entries[0]!.passes[0]!.candidates.map((c) => c.outcome);
    expect(outcomes.some((o) => o.includes("read cap reached"))).toBe(true);
  });
});
