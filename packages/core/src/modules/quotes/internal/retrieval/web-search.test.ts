/**
 * Test design (testing-strategy)
 *
 * SUT: createWebSearchRetriever (internal/retrieval/web-search.ts). The search step, the
 * transport, the clock and the log are all injected fakes — no socket, no model, per D9.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md — the classification requirement, the budget
 * requirement, the documents requirement, and design D10's log.
 *
 * Owner decision 2026-09-10 replaced the two-model search with a single GLM-5.3-Flash pass,
 * matching prompt.md's routing of "tool use and extraction" onto one model. The escalation
 * pass was removed on evidence, not taste: across every working showcase run it accepted
 * zero sources. The cells that sampled it are gone rather than skipped.
 *
 * Axes
 *   S1 search result — tier 1-3 page / only tier 4-5 / nothing / all rejected
 *   S2 budget — fetches under cap / at cap / clock past timeout
 *   S3 fetch outcome — html / document / network refusal
 *   S4 kill switch — on / off
 *   S5 links on an accepted page — none / same-origin document / already recorded
 *
 * Outputs
 *   O1 the RetrieveResult (status, sources with tier+classification)
 *   O2 manualCandidates, and how each was discovered
 *   O3 the log entry
 *   O4 the budget handed to the search
 *
 * Sampled cells (one row per `it`)
 *   manual accepted             | S1    | O1 tier 1 from the class map, never from the model
 *   nothing usable              | S1    | O1 none, every rejection reason in the log
 *   fetch cap reached           | S2    | later admitted pages logged, not fetched
 *   clock past timeout          | S2    | O1 none, nothing fetched
 *   budget reaches the call     | S2,O4 | bounded by the configured timeout | fails if the
 *      clock is only read BEFORE the call, which is how one search ran 573 s
 *   PDF                         | S3    | O2 manual candidate, O1 none (it is the only find)
 *   kill switch off             | S4    | O1 none, search never called
 *   log contents                | O3    | one pass, model named, class + reason + tier
 *   gateway links               | S5    | O2 inherit the linking page's class and tier, with
 *      discoveredVia | fails if a harvested document is indistinguishable from a classified one
 *   duplicate page              | S1    | one fetch for two URLs differing only by query
 *
 * Decision map of the adapter
 *   kill switch off             both: kill-switch test vs every other
 *   outOfTime() before search   both: clock test vs every other
 *   admitted / rejected         both: manual-accepted vs nothing-usable
 *   seenPages.has(key)          both: duplicate-page test vs every other
 *   fetched >= maxFetches       both: fetch-cap test vs every other
 *   refusal document / other    both: PDF test vs nothing-usable (network)
 *   documentLinks loop          both: gateway tests vs every other (fakes serve no links)
 *   candidate already recorded  both: "records a linked document once" vs the others
 *
 * Out of scope: admission rules (admit.test.ts), fetching mechanics and link harvesting
 * (page-fetcher.test.ts), the pipeline gate that decides whether this adapter runs at all
 * (sources.test.ts), extraction (oil-spec.test.ts).
 *
 * Split by topic under the 300-line cap (adopt-modular-vertical-slices 2B.1): each test
 * file now sits beside the source file it exercises — web-search.test.ts (the adapter's
 * flow), web-search.budgets.test.ts (its budgets and harvested links), search-hits.test.ts,
 * openai-search.test.ts and search-cost.test.ts. The shared axes and decision map are in
 * web-search.test.ts's header.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchRetriever, type WebSearchLog } from "./web-search.js";
import { pageKey } from "./search-hits.js";
import type { SearchCandidate } from "./admit.js";
import type { FetchTransport } from "./page-fetcher.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = {
  make: "Honda",
  year: 2021,
  model: "HR-V",
  version: "1.8 16V",
};

const MANUAL = "https://honda.com.br/manual-hrv";
const CATALOG = "https://carrorac.com/oleo-motor/honda/hr-v.html";
// Names the model ("HR-V") as a whole word: a document is recorded as a lead only then (D3).
const PDF = "https://honda.com.br/manual-hr-v.pdf";
const FORUM = "https://reddit.com/r/carros/hrv";

function candidate(url: string, classification: string): SearchCandidate {
  return { url, classification, reason: `classificado como ${classification}`, title: `Página ${url}` };
}

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

describe("web search adapter", () => {
  it("accepts a manufacturer manual and reports it at tier 1", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValueOnce([candidate(MANUAL, "manufacturer_manual")]);
    const { entries, log } = collector();

    const result = await createWebSearchRetriever({
      search,
      transport: transportFor([MANUAL]),
      log,
    })(identity);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      authority: 1,
      classification: "manufacturer_manual",
      url: MANUAL,
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(entries[0]?.passes).toHaveLength(1);
  });

  it("returns none when the search finds nothing usable", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([candidate(FORUM, "manufacturer_manual")]);
    const { entries, log } = collector();

    const result = await createWebSearchRetriever({
      search,
      transport: transportFor([]),
      log,
    })(identity);

    expect(result.status).toBe("none");
    const outcomes = entries[0]!.passes.flatMap((p) => p.candidates.map((c) => c.outcome));
    expect(outcomes.every((o) => o.startsWith("rejected"))).toBe(true);
    expect(outcomes[0]).toContain("forum");
  });

  it("records a PDF as a manual candidate and never reads its body", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([candidate(PDF, "manufacturer_manual")]);
    const { entries, log } = collector();

    const result = await createWebSearchRetriever({
      search,
      transport: transportFor([]),
      log,
    })(identity);

    expect(result.status).toBe("none");
    if (result.status !== "none") throw new Error("expected none");
    expect(result.manualCandidates).toHaveLength(1);
    expect(result.manualCandidates?.[0]).toMatchObject({
      url: PDF,
      tier: 1,
      classification: "manufacturer_manual",
    });
    expect(entries[0]?.manualCandidates).toBe(1);
  });

  it("honours the fetch cap, logging later pages as unfetched", async () => {
    process.env.WEB_SEARCH_MAX_FETCHES = "1";
    const second = "https://honda.com.br/segunda";
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([
        candidate(MANUAL, "manufacturer_manual"),
        candidate(second, "manufacturer_manual"),
      ]);
    const { entries, log } = collector();

    const result = await createWebSearchRetriever({
      search,
      transport: transportFor([MANUAL, second]),
      log,
    })(identity);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.sources).toHaveLength(1);
    expect(entries[0]?.fetched).toBe(1);
    const outcomes = entries[0]!.passes[0]!.candidates.map((c) => c.outcome);
    expect(outcomes[1]).toContain("budget spent");
  });

  it("stops when the clock is already past the timeout", async () => {
    const search = vi.fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>();
    let t = 0;
    // First call sets the start; every later reading is far past the budget.
    const now = () => (t === 0 ? ((t = 1), 0) : 999_999);

    const result = await createWebSearchRetriever({
      search,
      transport: transportFor([]),
      log: () => {},
      now,
    })(identity);

    expect(result.status).toBe("none");
    expect(search).not.toHaveBeenCalled();
  });

  it("does nothing at all when the kill switch is off", async () => {
    process.env.WEB_SEARCH_ENABLED = "false";
    const search = vi.fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>();

    const result = await createWebSearchRetriever({ search, log: () => {} })(identity);

    // Not searched, which is not "searched and found nothing": never remembered as a miss.
    expect(result).toEqual({ status: "none", notSearched: true });
    expect(search).not.toHaveBeenCalled();
  });

  it("logs the pass with every classification, reason and derived tier", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([candidate(CATALOG, "aftermarket_catalog")]);
    const { entries, log } = collector();

    await createWebSearchRetriever({
      search,
      transport: transportFor([CATALOG]),
      log,
    })(identity);

    const entry = entries[0]!;
    expect(entry.identity).toContain("HR-V");
    expect(entry.passes).toHaveLength(1);
    expect(entry.passes[0]!.model).toBe("gpt-6.1-sol");
    expect(entry.passes[0]!.candidates[0]).toMatchObject({
      classification: "aftermarket_catalog",
      tier: 5,
      outcome: "accepted",
    });
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(entry.bytes).toBeGreaterThan(0);
  });
});

describe("de-duplication", () => {
  it("fetches one page when two candidates differ only by query string", async () => {
    // Measured on the 2026-09-10 showcase: the Fiat manual finder was returned twice, with
    // and without `?offerId=`, and cost two of the three fetches for one page.
    const plain = "https://servicos.fiat.com.br/manuais.html";
    const withQuery = `${plain}?offerId=237`;
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([
        candidate(plain, "manufacturer_manual"),
        candidate(withQuery, "manufacturer_manual"),
      ]);
    const { entries, log } = collector();

    const result = await createWebSearchRetriever({
      search,
      transport: transportFor([plain, withQuery]),
      log,
    })(identity);

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected found");
    expect(result.sources).toHaveLength(1);
    expect(entries[0]?.fetched).toBe(1);
    // By URL, not by index: admissions are logged during the admit pass and fetch outcomes
    // after it, so position no longer tracks the order things happened in.
    const duplicate = entries[0]!.passes[0]!.candidates.find((c) => c.url === withQuery);
    expect(duplicate?.outcome).toContain("already seen");
  });

  it("keeps a trailing slash from making the same page look new", () => {
    expect(pageKey("https://x.test/a/")).toBe(pageKey("https://x.test/a"));
    expect(pageKey("https://x.test/a")).not.toBe(pageKey("https://x.test/b"));
  });
});



describe("the wall clock reaches the search itself", () => {
  it("hands the search what is left of the budget, not an unbounded call", async () => {
    // The showcase ran 573 s inside one call against a 60 s budget: the clock was read
    // before starting work and never again. A budget the search cannot see is not a budget.
    process.env.WEB_SEARCH_TIMEOUT_MS = "10000";
    let clock = 0;
    const now = () => (clock += 1_000);
    const search = vi
      .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([]);

    await createWebSearchRetriever({
      search,
      transport: transportFor([]),
      log: () => {},
      now,
    })(identity);

    expect(search).toHaveBeenCalledTimes(1);
    const budget = search.mock.calls[0]![2];
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(10_000);
  });
});
