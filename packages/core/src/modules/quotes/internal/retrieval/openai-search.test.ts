/**
 * Test design (testing-strategy): the OpenAI search step (switch-oil-research-to-openai tasks 1.6, 1.7, 1.8)
 *
 * SUT: createOpenAISearch, on its own and injected as the web search adapter's `search`, over a
 *   fake transport streaming Responses API events (search, then classification) and a fake page
 *   transport. No socket and no key.
 *
 * Oracle: `oil-spec-web-search` delta.
 *   - "The web search runs on OpenAI's hosted search tool, and only the system's own fetch reads
 *     a page", its seven scenarios.
 *   - "Each search's cost is recorded at OpenAI's rates", its three scenarios.
 *   - design.md D3, the request: `web_search`, `tool_choice: required`, `max_tool_calls` from
 *     `WEB_SEARCH_MAX_SEARCHES` (3), the sources include, `user_location` BR / São Paulo, the
 *     plain-domain blocklist as `blocked_domains`.
 *
 * Cells
 *   request        | default settings                   | the D3 body, cap 3, BR location, include, blocked plain domains only
 *   sources        | 8 consulted, 2 cited in the reply  | all 8 classified
 *   open_page      | a page opened, summarised          | URL is a candidate; the summary never reaches classification
 *   blocklist      | a wildcard-pattern forum           | not sent to classification; rejected by admission
 *   reply-only URL | a URL only in the reply text       | not a candidate
 *   tier in reply  | the classifier writes `tier: 1`    | ignored (derived from the class)
 *   PDF            | a manufacturer PDF in the sources  | manual candidate, not read (through the adapter)
 *   failed call    | web_search_call failed / 503 twice | SearchUnavailableError, never a miss
 *   one retry      | 429 then OK                        | retried once, honouring Retry-After
 *   cost           | 2 search + 1 page, 9,000 / 1,200   | 0.030 fees + 0.030 tokens = 0.060 on the log line
 *   free pages     | page actions configured free       | 0.020 fees
 *   over cap       | 4 items, cap 3                     | all 4 charged, overrun logged
 *   bad endings    | incomplete / truncated / SSE error | both search actions still charged, then unavailable (review of #215)
 *   no search      | completed, no web_search_call      | unavailable through the adapter, never a miss (review of #215)
 *   quota          | 429 insufficient_quota             | one request, no wait, unavailable (review of #215)
 *   output bound   | every call                         | max_output_tokens 25,000 (review of #215)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAISearch } from "./openai-search.js";
import { SearchUnavailableError } from "./search-fn.js";
import { createWebSearchRetriever } from "./web-search.js";
import type { FetchTransport } from "./page-fetcher.js";
import { fakeTransport, type CapturedRequest } from "../model-calls/fake-openai.js";
import {
  answerScript,
  createdEvent,
  errorResponse,
  incompleteEvent,
  responsesStream,
  searchScript,
  webSearchCallEvents,
  type FakeAction,
  type ResponsesStep,
} from "../model-calls/fake-openai.js";
import { createUsageMeter } from "../model-calls/meter.js";

const MODEL = "gpt-6.1-sol";
const QUERY = "Honda HR-V 2021 1.8 16V óleo do motor";
const MANUAL_PAGE = "https://www.honda.com.br/automoveis/hr-v/manual";
const PDF = "https://www.honda.com.br/manuais/manual-hr-v-2021.pdf";
const FORUM = "https://www.hrvclube.com.br/topico/oleo";

/** A classification reply giving `classification` to indices 1..n. */
function verdicts(n: number, classification = "manufacturer_manual", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ verdicts: Array.from({ length: n }, (_, i) => ({ index: i + 1, classification, reason: "página da montadora", ...extra })) });
}

/** A transport answering the search with `actions`, then the classification with `reply`. */
function twoCalls(actions: FakeAction[], reply: (request: CapturedRequest) => string, searchReply = "Encontrei o manual.") {
  return fakeTransport((request) =>
    request.body.tools ? responsesStream(searchScript(actions, searchReply)) : responsesStream(answerScript(reply(request), { input: 1_500, output: 600, reasoning: 300 })),
  );
}

/** Lines the adapter logs, parsed. */
function logLines() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (_line: string, detail: string) => lines.push(JSON.parse(detail) as Record<string, unknown>) };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ["WEB_SEARCH_MAX_SEARCHES", "WEB_SEARCH_BILL_PAGE_ACTIONS", "WEB_SEARCH_CONTEXT_SIZE"]) delete process.env[name];
});

const search = (transport: ReturnType<typeof fakeTransport>, extra: Partial<Parameters<typeof createOpenAISearch>[0]> = {}) =>
  createOpenAISearch({ apiKey: "placeholder-not-a-key", effort: "medium", httpFetch: transport.fetch, wait: async () => undefined, log: () => undefined, ...extra });

describe("the OpenAI search request", () => {
  it("carries the tool, the cap, the location, the include and only the blocklist's plain domains", async () => {
    const transport = twoCalls([{ type: "search", sources: [MANUAL_PAGE] }], () => verdicts(1));
    await search(transport)(MODEL, QUERY, 60_000, "Honda manual do proprietário HR-V 2021 pdf");
    const body = transport.requests[0]!.body;
    expect(transport.requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(body).toMatchObject({
      model: MODEL,
      stream: true,
      store: false,
      reasoning: { effort: "medium", summary: "auto" },
      tool_choice: "required",
      max_tool_calls: 3,
      include: ["web_search_call.action.sources"],
      // A spend bound on every production OpenAI call, the 25,000-token default (D5).
      max_output_tokens: 25_000,
    });
    expect(transport.requests[1]!.body).toMatchObject({ max_output_tokens: 25_000, text: { format: { type: "json_schema", strict: true } } });
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool).toMatchObject({
      type: "web_search",
      search_context_size: "medium",
      user_location: { type: "approximate", country: "BR", city: "São Paulo", timezone: "America/Sao_Paulo" },
    });
    const blocked = (tool.filters as { blocked_domains: string[] }).blocked_domains;
    expect(blocked).toContain("reddit.com");
    expect(blocked.some((domain) => domain.includes("*"))).toBe(false);
    expect(blocked.length).toBeLessThanOrEqual(100);
    expect(String(body.input)).toContain("Honda HR-V 2021");
  });
});

describe("candidates", () => {
  it("classifies every consulted source, not only the cited ones", async () => {
    const sources = Array.from({ length: 8 }, (_, i) => `https://www.honda.com.br/pagina-${i + 1}`);
    const transport = twoCalls([{ type: "search", sources }], () => verdicts(8));
    const found = await search(transport)(MODEL, QUERY, 60_000);
    expect(found.map((c) => c.url)).toEqual(sources);
    expect(String(transport.requests[1]!.body.input)).toContain("pagina-8");
  });

  it("takes a page the model opened as a candidate, and discards what the model said about it", async () => {
    const transport = twoCalls([{ type: "search", sources: [] }, { type: "open_page", url: MANUAL_PAGE }], () => verdicts(1), "O manual diz 0W-20 e 3,9 litros.");
    const found = await search(transport)(MODEL, QUERY, 60_000);
    expect(found.map((c) => c.url)).toEqual([MANUAL_PAGE]);
    const classification = JSON.stringify(transport.requests[1]!.body);
    expect(classification).not.toContain("3,9 litros");
  });

  it("never sends a blocklisted URL to classification, and returns it unclassified for admission to reject", async () => {
    const transport = twoCalls([{ type: "search", sources: [FORUM, MANUAL_PAGE] }], () => verdicts(1));
    const found = await search(transport)(MODEL, QUERY, 60_000);
    expect(JSON.stringify(transport.requests[1]!.body)).not.toContain("hrvclube");
    expect(found).toContainEqual({ url: FORUM });
    expect(found.find((c) => c.url === MANUAL_PAGE)).toMatchObject({ classification: "manufacturer_manual" });
  });

  it("drops a URL that only the reply text names", async () => {
    const transport = twoCalls([{ type: "search", sources: [MANUAL_PAGE] }], () => verdicts(1), "Veja https://inventado.example.com/manual");
    const found = await search(transport)(MODEL, QUERY, 60_000);
    expect(found.map((c) => c.url)).toEqual([MANUAL_PAGE]);
  });

  it("ignores a tier the classifier writes", async () => {
    const transport = twoCalls([{ type: "search", sources: [MANUAL_PAGE] }], () => verdicts(1, "aftermarket_catalog", { tier: 1 }));
    const result = await createWebSearchRetriever({
      search: search(transport),
      transport: htmlTransport(),
      log: () => undefined,
    })({ make: "Honda", year: 2021, model: "HR-V", version: "1.8 16V" });
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.sources[0]).toMatchObject({ authority: 5, classification: "aftermarket_catalog" });
  });

  it("records a manufacturer PDF among the sources as a manual candidate, and does not read it", async () => {
    const transport = twoCalls([{ type: "search", sources: [PDF] }], () => verdicts(1));
    const pages = htmlTransport();
    const result = await createWebSearchRetriever({ search: search(transport), transport: pages, log: () => undefined })({ make: "Honda", year: 2021, model: "HR-V", version: "1.8 16V" });
    expect(result).toMatchObject({ status: "none", manualCandidates: [{ url: PDF, tier: 1 }] });
    expect(vi.mocked(pages).mock.calls.some(([url, init]) => url === PDF && (init as { method: string }).method === "GET")).toBe(false);
  });
});

describe("failures are outages", () => {
  it("throws unavailable when a web_search_call failed", async () => {
    const transport = fakeTransport(() => responsesStream(searchScriptWithStatus("failed")));
    await expect(search(transport)(MODEL, QUERY, 60_000)).rejects.toBeInstanceOf(SearchUnavailableError);
  });

  it("throws unavailable after a 503 and its one retry", async () => {
    const transport = fakeTransport(() => errorResponse(503));
    await expect(search(transport)(MODEL, QUERY, 60_000)).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(transport.requests).toHaveLength(2);
  });

  it("retries a 429 once, waiting what Retry-After asks", async () => {
    let calls = 0;
    const transport = fakeTransport((request) => {
      calls += 1;
      if (calls === 1) return errorResponse(429, "2");
      return request.body.tools ? responsesStream(searchScript([{ type: "search", sources: [MANUAL_PAGE] }])) : responsesStream(answerScript(verdicts(1)));
    });
    const wait = vi.fn(async () => undefined);
    const found = await search(transport, { wait })(MODEL, QUERY, 60_000);
    expect(wait).toHaveBeenCalledWith(2_000);
    expect(found).toHaveLength(1);
  });

  it("throws unavailable when a completed response carries no web_search_call (tool_choice ignored)", async () => {
    const transport = fakeTransport(() => responsesStream(answerScript("Não precisei pesquisar.")));
    await expect(search(transport)(MODEL, QUERY, 60_000)).rejects.toThrow(/no web_search_call/);
    // Unavailable, never a miss: through the adapter the result is `unavailable`, so nothing is remembered.
    const result = await createWebSearchRetriever({ search: search(fakeTransport(() => responsesStream(answerScript("ok")))), transport: htmlTransport(), log: () => undefined })({
      make: "Honda",
      year: 2021,
      model: "HR-V",
      version: "1.8 16V",
    });
    expect(result.status).toBe("unavailable");
  });

  it("does not retry a 429 for a spent quota", async () => {
    const transport = fakeTransport(() => new Response(JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota", message: "quota" } }), { status: 429, headers: { "retry-after": "1" } }));
    const wait = vi.fn(async () => undefined);
    await expect(search(transport, { wait })(MODEL, QUERY, 60_000)).rejects.toThrow(/insufficient_quota/);
    expect(transport.requests).toHaveLength(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("throws unavailable when the classification parses to no verdict", async () => {
    const transport = twoCalls([{ type: "search", sources: [MANUAL_PAGE] }], () => "não sei");
    await expect(search(transport)(MODEL, QUERY, 60_000)).rejects.toBeInstanceOf(SearchUnavailableError);
  });
});

describe("cost", () => {
  it("charges two searches and an opened page: US$ 0.030 in fees and 0.030 in tokens", async () => {
    const transport = fakeTransport((request) =>
      request.body.tools
        ? responsesStream(searchScript([{ type: "search", sources: [MANUAL_PAGE] }, { type: "search", sources: [] }, { type: "open_page", url: MANUAL_PAGE }], "ok", { input: 9_000, output: 1_200 }))
        : responsesStream(answerScript(verdicts(1), { input: 0, output: 0 })),
    );
    const meter = createUsageMeter();
    const { lines, log } = logLines();
    await search(transport, { meter, log })(MODEL, QUERY, 60_000);
    const summary = lines.find((line) => "costUsd" in line)!;
    expect(summary).toMatchObject({ searchActions: 2, pageActions: 1 });
    expect(summary.feesUsd as number).toBeCloseTo(0.03, 10);
    expect(summary.tokenUsd as number).toBeCloseTo(0.03, 10);
    expect(summary.costUsd as number).toBeCloseTo(0.06, 10);
    expect(meter.snapshot().costUsd).toBeCloseTo(0.06, 10);
  });

  it("charges nothing for page actions once configured free", async () => {
    process.env.WEB_SEARCH_BILL_PAGE_ACTIONS = "false";
    const transport = twoCalls([{ type: "search", sources: [MANUAL_PAGE] }, { type: "search", sources: [] }, { type: "open_page", url: MANUAL_PAGE }], () => verdicts(1));
    const { lines, log } = logLines();
    await search(transport, { log })(MODEL, QUERY, 60_000);
    expect(lines.find((line) => "costUsd" in line)!.feesUsd as number).toBeCloseTo(0.02, 10);
  });

  it.each([
    ["an incomplete response", "incomplete"],
    ["a stream cut short, with no final event", "truncated"],
    ["an SSE error event", "error"],
  ] as const)("books the search fees of %s before reporting the outage", async (_label, ending) => {
    const transport = fakeTransport(() => responsesStream(endedBy(ending)));
    const meter = createUsageMeter();
    const { lines, log } = logLines();
    await expect(search(transport, { meter, log })(MODEL, QUERY, 60_000)).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(meter.snapshot()).toMatchObject({ searchCalls: 2, pageActions: 0 });
    expect(meter.snapshot().costUsd).toBeGreaterThanOrEqual(0.02);
    expect(lines.find((line) => "costUsd" in line)!.feesUsd as number).toBeCloseTo(0.02, 10);
  });

  it("charges every item beyond the cap, and logs the overrun", async () => {
    const actions: FakeAction[] = Array.from({ length: 4 }, () => ({ type: "search", sources: [MANUAL_PAGE] }));
    const transport = twoCalls(actions, () => verdicts(1));
    const meter = createUsageMeter();
    const { lines, log } = logLines();
    await search(transport, { meter, log })(MODEL, QUERY, 60_000);
    expect(meter.snapshot().searchCalls).toBe(4);
    expect(lines).toContainEqual(expect.objectContaining({ outcome: "over_cap", cap: 3, items: 4 }));
  });

  // Benchmark 2026-10-12: a request with max_tool_calls 1 came back with 2 web_search_call items and
  // one with 3 came back with 4. The cap is a soft hint, so the code trusts what happened.
  it("does not trust max_tool_calls: a cap of 1 that comes back with 2 searches charges 2 and keeps both sources", async () => {
    process.env.WEB_SEARCH_MAX_SEARCHES = "1";
    const second = "https://www.honda.com.br/automoveis/hr-v/especificacoes";
    const transport = twoCalls([{ type: "search", sources: [MANUAL_PAGE] }, { type: "search", sources: [second] }], () => verdicts(2));
    const meter = createUsageMeter();
    const { lines, log } = logLines();

    const found = await search(transport, { meter, log })(MODEL, QUERY, 60_000);

    expect(transport.requests[0]!.body).toMatchObject({ max_tool_calls: 1 });
    expect(meter.snapshot().searchCalls).toBe(2);
    expect(found.map((c) => c.url)).toEqual([MANUAL_PAGE, second]);
    expect(lines).toContainEqual(expect.objectContaining({ outcome: "over_cap", cap: 1, items: 2 }));
    expect(lines.find((line) => "costUsd" in line)!.feesUsd as number).toBeCloseTo(0.02, 10);
  });
});

/** A search that made two search actions and then ended badly: incomplete, cut short, or an error event. */
function endedBy(ending: "incomplete" | "truncated" | "error"): ResponsesStep[] {
  const steps: ResponsesStep[] = [
    { event: createdEvent() },
    ...webSearchCallEvents("ws_0", { type: "search", sources: [MANUAL_PAGE] }, 0).map((event) => ({ event })),
    ...webSearchCallEvents("ws_1", { type: "search", sources: [PDF] }, 1).map((event) => ({ event })),
  ];
  if (ending === "incomplete") steps.push({ event: incompleteEvent({ input: 9_000, output: 25_000, reasoning: 25_000 }) });
  if (ending === "error") steps.push({ event: { type: "error", code: "server_error", message: "fake" } });
  steps.push({ end: true });
  return steps;
}

/** A search whose one web_search_call ends with `status`. */
function searchScriptWithStatus(status: string) {
  const script = searchScript([{ type: "search", sources: [MANUAL_PAGE] }]);
  return script.map((step) =>
    "event" in step && step.event.type === "response.output_item.done" && (step.event.item as { type: string }).type === "web_search_call"
      ? { ...step, event: { ...step.event, item: { ...(step.event.item as object), status } } }
      : step,
  );
}

/** Pages: HTML for HTML URLs, a PDF answer for `.pdf`. */
function htmlTransport(): FetchTransport {
  return vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
    if (url.endsWith("/robots.txt")) return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
    const type = url.endsWith(".pdf") ? "application/pdf" : "text/html";
    if (init.method === "HEAD") return { status: 200, headers: { get: () => type }, text: async () => "" };
    return { status: 200, headers: { get: () => type }, text: async () => "<html><title>Manual HR-V</title><body><p>Óleo 0W-20 — 3,7 L com filtro</p></body></html>" };
  }) as unknown as FetchTransport;
}
