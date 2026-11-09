/**
 * Test design (testing-strategy): the OpenAI search step under time and failure limits (review of
 * #217; they replace the coverage of the Zhipu search provider's tests, deleted with it)
 *
 * SUT: createOpenAISearch, over a fake Responses transport, fake timers where a clock matters, and
 *   a real usage meter. No socket and no key.
 *
 * Oracle: `oil-spec-web-search` delta ("a failed request, an incomplete response or the budget is
 *   an outage, never a miss"; "Each search's cost is recorded at OpenAI's rates") and design.md D3
 *   and D5: one bounded retry that honours `Retry-After` only when the clock can afford the wait;
 *   a request this code got wrong (400, 404) is not repeated; an aborted call the server accepted
 *   is charged `unknownCallUsd` (US$ 0.25) and the `web_search_call` fees that arrived are
 *   booked (US$ 0.01 each).
 *
 * Cells
 *   no time         | 429, Retry-After 30 in a 5 s budget  | no wait, one request, unavailable, nothing charged
 *   no time         | 429, Retry-After 2 in a 2.5 s budget | same: the wait must leave a second to spare
 *   control         | 429, Retry-After 2 in a 3.5 s budget | retried after 2000 ms
 *   not retried     | 400, 404                             | one request, no wait, unavailable, nothing charged
 *   aborted         | outer signal aborts mid-search       | 1 fee + US$ 0.25 booked, unavailable, no classification call
 *   aborted         | the call ceiling fires mid-search    | same
 *   adapter         | the web clock runs out mid-search    | `unavailable` through the adapter, never a miss
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAISearch } from "./openai-search.js";
import { SearchUnavailableError } from "./search-fn.js";
import { createWebSearchRetriever } from "./web-search.js";
import type { FetchTransport } from "./page-fetcher.js";
import { answerScript, createdEvent, errorResponse, fakeTransport, responsesStream, searchScript, webSearchCallEvents } from "../model-calls/fake-openai.js";
import { createUsageMeter } from "../model-calls/meter.js";

const MODEL = "gpt-6.1-sol";
const QUERY = "Honda HR-V 2021 1.8 16V óleo do motor";
const MANUAL_PAGE = "https://www.honda.com.br/automoveis/hr-v/manual";
const VERDICT = JSON.stringify({ verdicts: [{ index: 1, classification: "manufacturer_manual", reason: "página da montadora" }] });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ["OIL_RESEARCH_CALL_TIMEOUT_MS", "WEB_SEARCH_TIMEOUT_MS"]) delete process.env[name];
});

/** Lines the adapter logs, parsed. */
function logLines() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (_line: string, detail: string) => lines.push(JSON.parse(detail) as Record<string, unknown>) };
}

const search = (transport: ReturnType<typeof fakeTransport>, extra: Partial<Parameters<typeof createOpenAISearch>[0]> = {}) =>
  createOpenAISearch({ apiKey: "placeholder-not-a-key", effort: "medium", httpFetch: transport.fetch, wait: async () => undefined, log: () => undefined, ...extra });

describe("the one retry is skipped when the clock cannot afford it", () => {
  it.each([
    ["a Retry-After the budget cannot afford", "30", 5_000],
    ["a wait that leaves less than a second", "2", 2_500],
  ])("skips the retry on a 429 with %s, and is unavailable", async (_label, retryAfter, budgetMs) => {
    const transport = fakeTransport(() => errorResponse(429, retryAfter));
    const wait = vi.fn(async () => undefined);
    const meter = createUsageMeter();
    await expect(search(transport, { wait, meter })(MODEL, QUERY, budgetMs)).rejects.toThrow(/no time to retry/);
    // No wait means no retry: counting requests alone would not say which branch ran.
    expect(wait).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    expect(meter.snapshot()).toMatchObject({ costUsd: 0, searchCalls: 0 });
  });

  it("retries when the same 429 fits in the budget (the control for the skip above)", async () => {
    let calls = 0;
    const transport = fakeTransport((request) => {
      calls += 1;
      if (calls === 1) return errorResponse(429, "2");
      return request.body.tools ? responsesStream(searchScript([{ type: "search", sources: [MANUAL_PAGE] }])) : responsesStream(answerScript(VERDICT));
    });
    const wait = vi.fn(async () => undefined);
    await search(transport, { wait })(MODEL, QUERY, 3_500);
    expect(wait).toHaveBeenCalledWith(2_000);
  });

  it.each([400, 404])("does not retry a %i: the same request would be told the same thing", async (status) => {
    const transport = fakeTransport(() => errorResponse(status));
    const wait = vi.fn(async () => undefined);
    const meter = createUsageMeter();
    await expect(search(transport, { wait, meter })(MODEL, QUERY, 60_000)).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(transport.requests).toHaveLength(1);
    expect(wait).not.toHaveBeenCalled();
    expect(meter.snapshot().costUsd).toBe(0);
  });
});

describe("a search aborted mid-flight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A search whose stream delivers one web_search_call and then goes silent. */
  const silentAfterOneAction = () =>
    fakeTransport(() => responsesStream([{ event: createdEvent() }, ...webSearchCallEvents("ws_0", { type: "search", sources: [MANUAL_PAGE] }, 0).map((event) => ({ event }))]));

  it.each([
    ["the outer signal (the run is stopped)", "outer"],
    ["the call ceiling", "ceiling"],
  ] as const)("is aborted by %s: the fee that arrived and the unknown-usage charge are booked, and it is unavailable", async (_label, how) => {
    if (how === "ceiling") process.env.OIL_RESEARCH_CALL_TIMEOUT_MS = "2000";
    const transport = silentAfterOneAction();
    const meter = createUsageMeter();
    const { lines, log } = logLines();
    const outer = new AbortController();
    const outcome = search(transport, { meter, log })(MODEL, QUERY, 60_000, undefined, outer.signal).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(500);
    if (how === "outer") outer.abort();
    else await vi.advanceTimersByTimeAsync(2_000);
    const error = await outcome;

    expect(error).toBeInstanceOf(SearchUnavailableError);
    expect((error as Error).message).toMatch(/aborted: (budget|ceiling)/);
    // No classification call was made on an aborted search.
    expect(transport.requests).toHaveLength(1);
    // The one web_search_call that arrived is charged (US$ 0.01), and so is the call the server
    // accepted and never reported usage for (US$ 0.25).
    expect(meter.snapshot()).toMatchObject({ searchCalls: 1, modelCalls: 1, timedOutCalls: 1, usageKnown: false });
    expect(meter.snapshot().costUsd).toBeCloseTo(0.01 + 0.25, 10);
    expect(lines.find((line) => "costUsd" in line)!.feesUsd as number).toBeCloseTo(0.01, 10);
  });

  it("is unavailable, never a miss, through the web search adapter when its clock runs out", async () => {
    process.env.WEB_SEARCH_TIMEOUT_MS = "1000";
    const transport = silentAfterOneAction();
    const pending = createWebSearchRetriever({ search: search(transport), transport: pageTransport(), log: () => undefined })({
      make: "Honda",
      year: 2021,
      model: "HR-V",
      version: "1.8 16V",
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect((await pending).status).toBe("unavailable");
  });
});

/** Pages: a minimal HTML answer (never reached when the search is unavailable). */
function pageTransport(): FetchTransport {
  return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
    if (url.endsWith("/robots.txt")) return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
    if (init.method === "HEAD") return { status: 200, headers: { get: () => "text/html" }, text: async () => "" };
    return { status: 200, headers: { get: () => "text/html" }, text: async () => "<html><body><p>Óleo 0W-20</p></body></html>" };
  }) as unknown as FetchTransport;
}
