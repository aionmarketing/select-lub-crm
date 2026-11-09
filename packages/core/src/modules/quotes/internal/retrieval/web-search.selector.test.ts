/**
 * Test design (testing-strategy) — the link selector under the web search's budgets
 *
 * SUT: createWebSearchRetriever with an injected search, transport, clock, log and link
 *   selector; a gateway page linking more documents than the cap, so the selector is asked.
 *
 * Oracle: orchestrator review of #175 (2026-09-25) — the selector's time is bounded by what
 *   is left under WEB_SEARCH_TIMEOUT_MS, not a fixed 15 s, and its tokens are in the quote's
 *   `costUsd`, so a measurement or a spend guard reading that figure includes the selection.
 *
 * Cells
 *   50 s of 60 s spent while fetching | selector gets 10 s, not 15 | fails on a fixed timeout
 *   59.5 s spent                       | selector not asked; page order recorded
 *   selector reports tokens            | the log's usage and costUsd include them | fails if
 *      the selector's spend is dropped
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchCandidate } from "./admit.js";
import { DOCUMENT_LINK_CAP, type FetchTransport } from "./page-fetcher.js";
import { costUsdOf } from "./search-cost.js";
import { FALLBACK_SELECTION_REASON, type DocumentLinkSelector } from "./document-links.js";
import { createWebSearchRetriever, type WebSearchLog } from "./web-search.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = { make: "VW", year: 2021, model: "Polo", version: "1.0 TSI" };
const GATEWAY = "https://vw.com.br/pt/manuais.html";
const LINKS = DOCUMENT_LINK_CAP + 5;

afterEach(() => {
  delete process.env.WEB_SEARCH_TIMEOUT_MS;
});

/**
 * Serves the gateway with more labelled PDFs than the cap, and moves the clock to `spentMs`
 * while its body is read — the time a real fetch takes out of the quote's budget.
 */
function gateway(clock: { t: number }, spentMs: number): FetchTransport {
  const anchors = Array.from({ length: LINKS }, (_, i) => `<a href="https://vw.com.br/dam/m${i}.pdf">Manual Polo ${i}</a>`);
  return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
    if (url.endsWith("/robots.txt")) {
      return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
    }
    if (init.method === "HEAD") {
      return { status: 200, headers: { get: () => "text/html" }, text: async (): Promise<string> => "" };
    }
    clock.t = spentMs;
    return {
      status: 200,
      headers: { get: () => "text/html" },
      text: async (): Promise<string> => `<html><title>Manuais</title><body>${anchors.join("")}</body></html>`,
    };
  }) as unknown as FetchTransport;
}

async function run(spentMs: number, selectLinks: DocumentLinkSelector) {
  process.env.WEB_SEARCH_TIMEOUT_MS = "60000";
  const clock = { t: 0 };
  const entries: WebSearchLog[] = [];
  const search = vi
    .fn<(m: string, q: string, b: number) => Promise<SearchCandidate[]>>()
    .mockResolvedValue([{ url: GATEWAY, classification: "manufacturer_manual", reason: "r", title: "Manuais" }]);
  const result = await createWebSearchRetriever({
    search,
    transport: gateway(clock, spentMs),
    now: () => clock.t,
    log: (entry) => entries.push(entry),
    selectLinks,
  })(identity);
  return { result, entries };
}

describe("the link selector spends from the quote's budgets", () => {
  it("gets what is left of the quote's clock, not a fixed 15 s", async () => {
    const selector = vi.fn<DocumentLinkSelector>(async () => [{ index: 3, reason: "Polo 2021" }]);

    await run(50_000, selector);

    expect(selector).toHaveBeenCalledTimes(1);
    expect(selector.mock.calls[0]![3].timeoutMs).toBe(10_000);
  });

  it("is not asked when under a second is left, and the page order is recorded", async () => {
    const selector = vi.fn<DocumentLinkSelector>(async () => [{ index: 3, reason: "Polo 2021" }]);

    const { result } = await run(59_500, selector);

    expect(selector).not.toHaveBeenCalled();
    if (result.status !== "found") throw new Error(`expected found, got ${result.status}`);
    expect(result.manualCandidates?.[0]?.selectionReason).toBe(FALLBACK_SELECTION_REASON);
  });

  it("puts the selector's tokens in the quote's usage and costUsd", async () => {
    const spent = { input: 40_000, cachedInput: 0, reasoning: 30_000, output: 2_000 };
    const selector: DocumentLinkSelector = async (_links, _identity, _cap, budget) => {
      budget.onUsage?.(spent);
      return [{ index: 3, reason: "Polo 2021" }];
    };

    const { entries } = await run(1_000, selector);

    const entry = entries.at(-1)!;
    expect(entry.usageKnown).toBe(true);
    expect(entry.usage).toEqual(spent);
    // The injected search reports no usage and no tool call, so this is the selection alone.
    expect(entry.costUsd).toBe(costUsdOf(spent, 0));
    expect(entry.costUsd).toBeGreaterThan(0.01);
  });
});
