/**
 * Test design (testing-strategy)
 *
 * SUT: what a web search costs (internal/retrieval/search-cost.ts) — tokens and tool calls at
 * gpt-6.1-sol's list price and the tool fee, with reasoning billed as output. No socket, no model.
 *
 * Split by topic under the 300-line cap (adopt-modular-vertical-slices 2B.1): each test
 * file now sits beside the source file it exercises — web-search.test.ts (the adapter's
 * flow), web-search.budgets.test.ts (its budgets and harvested links), search-hits.test.ts,
 * openai-search.test.ts and search-cost.test.ts. The shared axes and decision map are in
 * web-search.test.ts's header.
 *
 * Oracle: specs/quotes/oil-spec-web-search/spec.md "The search log states what the search cost" —
 * the four token counts, the call count, and a figure derived from them at the model's price;
 * with no usage, the call fee alone and a flag saying the tokens are unknown.
 *
 * Axes
 *   P1 usage — reported / absent
 *   P2 reasoning tokens — zero / the bulk of the output
 *   P3 tool fee — default / overridden by env
 *   P4 calls — none / two
 *
 * Sampled cells (one row per `it`)
 *   defaults, real numbers   | P1,P4 | the figure to five decimals
 *   reasoning billed as out  | P2    | doubling reasoning moves the figure | THE case:
 *      reasoning is invisible in the reply, so ignoring it would understate every search
 *   cache writes             | P1    | priced at their own rate
 *   no usage                 | P1    | the call fee alone, and usageKnown false on the log
 *   fee override             | P3    | a different figure
 *   no calls, no usage       | P1,P4 | zero, not NaN
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchRetriever, type WebSearchLog } from "./web-search.js";
import { costUsdOf } from "./search-cost.js";
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

/** Collects the adapter's structured log. */
function collector() {
  const entries: WebSearchLog[] = [];
  return { entries, log: (e: WebSearchLog) => entries.push(e) };
}

describe("costUsdOf", () => {
  const usage = { input: 10_000, cachedInput: 20_000, reasoning: 4_000, output: 1_000 };

  afterEach(() => {
    delete process.env.WEB_SEARCH_PRICE_PER_CALL;
  });

  it("costs tokens and calls at gpt-6.1-sol's list", () => {
    // 10k in @2.00 + 20k cached @0.10 + 5k out+reasoning @10.00, per million, + 2 x $0.01
    expect(costUsdOf(usage, 2)).toBeCloseTo(0.02 + 0.002 + 0.05 + 0.02, 5);
  });

  it("bills reasoning as output", () => {
    const cheap = costUsdOf({ ...usage, reasoning: 0 }, 0);
    const dear = costUsdOf(usage, 0);

    expect(dear - cheap).toBeCloseTo((4_000 * 10) / 1e6, 6);
  });

  it("bills cache writes at their own rate", () => {
    expect(costUsdOf({ input: 0, cachedInput: 0, reasoning: 0, output: 0, cacheWrite: 2_000 }, 0)).toBeCloseTo(0.005, 6);
  });

  it("charges the call fee alone when the provider reported no usage", () => {
    expect(costUsdOf(undefined, 2)).toBeCloseTo(0.02, 5);
  });

  it("honours an overridden tool fee", () => {
    process.env.WEB_SEARCH_PRICE_PER_CALL = "0.0014";

    expect(costUsdOf(usage, 2)).toBeCloseTo(0.02 + 0.002 + 0.05 + 0.0028, 5);
  });

  it("is zero, not NaN, when nothing was spent", () => {
    expect(costUsdOf(undefined, 0)).toBe(0);
  });

  it("puts the figure and the flag on the log line", async () => {
    const search = vi
      .fn<(m: string, q: string, b: number, manual?: string) => Promise<SearchCandidate[]>>()
      .mockResolvedValue([]);
    const { entries, log } = collector();

    await createWebSearchRetriever({ search, transport: transportFor([]), log })(identity);

    // An injected fake bills nothing and reports no usage: the flag is what says so.
    expect(entries[0]?.costUsd).toBe(0);
    expect(entries[0]?.usageKnown).toBe(false);
  });
});
