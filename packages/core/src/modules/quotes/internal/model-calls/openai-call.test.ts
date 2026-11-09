/**
 * Test design (testing-strategy): an OpenAI research read through the streaming helper (switch-oil-research-to-openai tasks 1.2, 1.5)
 *
 * SUT: streamModelCall, through the real AI SDK
 *   and the real watchdog, over a fake transport that streams Responses API events on fake
 *   timers; and the extractor, passage selector and link selector factories given an OpenAI
 *   `target`. No socket and no key.
 *
 * Oracle: `research-model-calls` delta.
 *   - "Every research call carries the configured reasoning effort": `reasoning.effort` in the
 *     body.
 *   - "A research call is limited by a measured ceiling and its budget": streamed; no idle timer
 *     until one is measured, so a call that reasons silently is not cut; the ceiling bounds it; an
 *     incomplete reply with no text is a failure; no output token limit on a read.
 *   - "Each research call reports what it spent": usage, cache writes included, with the effort.
 *   design.md D3: Responses API, `reasoning.summary: "auto"`, `store: false`.
 *
 * Cells
 *   body      | a read with effort medium        | /responses, reasoning {effort, summary}, store false, no max_output_tokens, no temperature
 *   silence   | 2 min with no event, then answer | answer used, no timeout
 *   ceiling   | events past 240 s                | ceiling, failed
 *   incomplete| max_output_tokens, no text       | failed
 *   refusal   | HTTP 503                         | failed, reported not accepted
 *   usage     | cached + cache-write + reasoning | split, effort recorded on the meter
 *   unmeasured| gpt-6.1-sol at high              | placeholder row reported once
 *   ports     | extractor / selector / links with a target | sent to OpenAI naming the target model
 *   default   | no target, with / without OPENAI_API_KEY   | the configured model is called / no call is made
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEffortReportsForTests } from "./effort.js";
import { answerScript, completedEvent, createdEvent, errorResponse, fakeTransport, incompleteEvent, messageEvents, reasoningEvents, responsesStream, type ResponsesStep } from "./fake-openai.js";
import { PLACEHOLDER_LIMITS, reportUnmeasuredOpenAILimits } from "./limits.js";
import { createUsageMeter } from "./meter.js";
import { openaiReadOptions, type ModelTarget } from "./research-model.js";
import { streamModelCall } from "./stream-call.js";
import { createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";
import { createModelPassageSelector } from "../pipeline/passage-selector.js";
import { createModelDocumentLinkSelector } from "../retrieval/document-links.js";
import type { RetrievedSource } from "../pipeline/oil-spec.js";

const TARGET: ModelTarget = { provider: "openai", apiKey: "placeholder-not-a-key", model: "gpt-6.1-sol", effort: "medium" };
const request = {
  apiKey: TARGET.apiKey,
  model: "gpt-6.1-sol",
  effort: "medium" as const,
  providerOptions: openaiReadOptions("medium"),
  system: "s",
  prompt: "p",
  label: "test",
};
const identity = { make: "Volkswagen", model: "Gol", year: 2021, version: "1.0 FLEX 12V 4P" };
const EXTRACTION = '{"viscosityGrades":["5W-40"],"classification":"VW 502 00","fillLiters":3.3,"fillCondition":"with_filter","engineCoverage":"one","enginesNamed":["1.0"]}';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetEffortReportsForTests();
  for (const name of ["OPENAI_API_KEY", "OIL_RESEARCH_MODEL", "OIL_RESEARCH_CALL_TIMEOUT_MS", "OIL_RESEARCH_MAX_OUTPUT_TOKENS"]) delete process.env[name];
});

/** Runs a call to completion on the fake timers. */
async function run(steps: ResponsesStep[] | (() => Response), meter = createUsageMeter()) {
  const transport = fakeTransport(() => (typeof steps === "function" ? steps() : responsesStream(steps)));
  const pending = streamModelCall({ ...request, transport: transport.fetch, meter });
  await vi.runAllTimersAsync();
  return { result: await pending, requests: transport.requests, meter };
}

describe("an OpenAI research read", () => {
  it("goes to the Responses API with the effort, summaries on, nothing stored and no output cap", async () => {
    const { result, requests } = await run(answerScript("ok"));
    expect(result).toMatchObject({ text: "ok", failed: false, timeout: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol", stream: true, store: false, reasoning: { effort: "medium", summary: "auto" } });
    expect(requests[0]!.body).not.toHaveProperty("max_output_tokens");
    expect(requests[0]!.body).not.toHaveProperty("temperature");
  });

  it("is not cut off when it reasons silently for two minutes and then answers", async () => {
    const steps: ResponsesStep[] = [
      { event: createdEvent() },
      ...messageEvents("depois de pensar").map((event, i) => ({ afterMs: i === 0 ? 120_000 : 0, event })),
      { event: completedEvent({ input: 100, output: 50 }) },
      { end: true },
    ];
    const { result } = await run(steps);
    expect(result).toMatchObject({ text: "depois de pensar", failed: false, timeout: null });
  });

  it("is aborted at the placeholder ceiling when it never ends", async () => {
    const steps: ResponsesStep[] = [{ event: createdEvent() }];
    for (let at = 0; at < 300_000; at += 10_000) steps.push({ afterMs: 10_000, event: reasoningEvents()[2]! });
    const { result } = await run(steps);
    expect(PLACEHOLDER_LIMITS.callMs).toBe(240_000);
    expect(result).toMatchObject({ failed: true, timeout: "ceiling" });
  });

  it("fails when the reply ends incomplete with no answer", async () => {
    const { result } = await run([{ event: createdEvent() }, ...reasoningEvents().map((event) => ({ event })), { event: incompleteEvent({ input: 100, output: 25_000, reasoning: 25_000 }) }, { end: true }]);
    expect(result.failed).toBe(true);
    expect(result.text).toBe("");
  });

  it("reports a refused request as not accepted, and fails", async () => {
    const { result, meter } = await run(() => errorResponse(400));
    expect(result.failed).toBe(true);
    expect(meter.snapshot()).toMatchObject({ costUsd: 0, usageKnown: true });
  });

  it("never retries a 429 for a spent quota", async () => {
    const transport = fakeTransport(() => new Response(JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota", message: "quota" } }), { status: 429 }));
    const pending = streamModelCall({ ...request, transport: transport.fetch });
    await vi.runAllTimersAsync();
    expect((await pending).failed).toBe(true);
    expect(transport.requests).toHaveLength(1);
  });

  it("retries a rate-limit 429 once, after what Retry-After asks", async () => {
    let calls = 0;
    const transport = fakeTransport(() => (calls++ === 0 ? errorResponse(429, "3") : responsesStream(answerScript("ok"))));
    const retryWait = vi.fn(async () => undefined);
    const pending = streamModelCall({ ...request, transport: transport.fetch, retryWait });
    await vi.runAllTimersAsync();
    expect((await pending).text).toBe("ok");
    expect(retryWait).toHaveBeenCalledWith(3_000);
    expect(transport.requests).toHaveLength(2);
  });

  it("retries a 5xx at most once", async () => {
    const transport = fakeTransport(() => errorResponse(503));
    const pending = streamModelCall({ ...request, transport: transport.fetch, retryWait: async () => undefined });
    await vi.runAllTimersAsync();
    expect((await pending).failed).toBe(true);
    expect(transport.requests).toHaveLength(2);
  });

  it("splits cached input, cache writes and reasoning, and records the effort", async () => {
    const { result, meter } = await run(answerScript("ok", { input: 6_000, cached: 1_000, cacheWrite: 2_000, output: 700, reasoning: 500 }));
    expect(result.usage).toEqual({ input: 3_000, cachedInput: 1_000, cacheWrite: 2_000, reasoning: 500, output: 200 });
    expect(meter.snapshot().efforts).toEqual([{ model: "gpt-6.1-sol", effort: "medium" }]);
    // 3,000 × 2 + 1,000 × 0.10 + 2,000 × 2.50 + 700 × 10, per million.
    expect(meter.snapshot().costUsd).toBeCloseTo((3_000 * 2 + 1_000 * 0.1 + 2_000 * 2.5 + 700 * 10) / 1e6, 10);
  });
});

describe("reportUnmeasuredOpenAILimits", () => {
  it("reports a pair with no measured row once, naming the settings", () => {
    const lines: string[] = [];
    const pairs = reportUnmeasuredOpenAILimits(
      [
        { setting: "OIL_RESEARCH_MODEL", model: "gpt-6.1-sol", effort: "high" },
        { setting: "ESCALATION_MODEL", model: "gpt-6.1-sol", effort: "high" },
      ],
      (_message, detail) => lines.push(detail),
    );
    expect(pairs).toEqual([{ model: "gpt-6.1-sol", effort: "high", settings: ["OIL_RESEARCH_MODEL", "ESCALATION_MODEL"] }]);
    expect(lines).toHaveLength(1);
  });
});

describe("port factories with an OpenAI target", () => {
  const source: RetrievedSource = {
    publisher: "vw.com.br",
    document: "Manual Gol 2021",
    page: "p. 301",
    authority: 1,
    content: { kind: "text", text: "Quantidade de óleo do motor 1.0: 3,3 litros\nSAE 5W-40" },
  };

  it("send the extraction to OpenAI", async () => {
    const transport = fakeTransport(() => responsesStream(answerScript(EXTRACTION)));
    const pending = createModelOilSpecExtractor({ target: TARGET, transport: transport.fetch })(source, identity);
    await vi.runAllTimersAsync();
    const extracted = await pending;
    expect(extracted).toMatchObject({ viscosityGrades: ["5W-40"], fillLiters: 3.3, fillCondition: "with_filter" });
    expect(transport.requests.every((r) => r.url.startsWith("https://api.openai.com/"))).toBe(true);
    // Every production OpenAI read carries the configurable spend bound, 25,000 by default (review of #215).
    expect(transport.requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "medium" }, max_output_tokens: 25_000 });
  });

  it("send the output bound OIL_RESEARCH_MAX_OUTPUT_TOKENS names", async () => {
    process.env.OIL_RESEARCH_MAX_OUTPUT_TOKENS = "8000";
    const transport = fakeTransport(() => responsesStream(answerScript(EXTRACTION)));
    const pending = createModelOilSpecExtractor({ target: TARGET, transport: transport.fetch })(source, identity);
    await vi.runAllTimersAsync();
    await pending;
    expect(transport.requests[0]!.body).toMatchObject({ max_output_tokens: 8_000 });
  });

  it("send a long page's passage selection to OpenAI", async () => {
    const long = { ...source, content: { kind: "text" as const, text: Array.from({ length: 400 }, (_, i) => `linha ${i} óleo do motor 5W-40`).join("\n") } };
    const transport = fakeTransport(() => responsesStream(answerScript('{"ranges":[{"from":1,"to":3}]}')));
    const pending = createModelPassageSelector({ target: TARGET, transport: transport.fetch })(long, identity);
    await vi.runAllTimersAsync();
    await pending;
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.url).toBe("https://api.openai.com/v1/responses");
  });

  it("send the link selection to OpenAI", async () => {
    const transport = fakeTransport(() => responsesStream(answerScript('{"picks":[{"index":1,"reason":"manual do Gol"}]}')));
    const links = [{ url: "https://vw.com.br/gol.pdf", label: "Manual Gol 2021" }];
    const pending = createModelDocumentLinkSelector({ target: TARGET, transport: transport.fetch })(links, identity, 1, { timeoutMs: 60_000 });
    await vi.runAllTimersAsync();
    await pending;
    expect(transport.requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol" });
  });

  it("without a target, call the configured research model with OPENAI_API_KEY", async () => {
    process.env.OPENAI_API_KEY = "placeholder-not-a-key";
    process.env.OIL_RESEARCH_MODEL = "gpt-6.1-sol";
    const transport = fakeTransport(() => responsesStream(answerScript(EXTRACTION)));
    const pending = createModelOilSpecExtractor({ transport: transport.fetch })(source, identity);
    await vi.runAllTimersAsync();
    await pending;
    expect(transport.requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(transport.requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "medium" } });
    expect(transport.requests[0]!.body).not.toHaveProperty("temperature");
  });

  it("without a target and without a key, make no call at all", async () => {
    const transport = fakeTransport(() => responsesStream(answerScript(EXTRACTION)));
    const pending = createModelOilSpecExtractor({ transport: transport.fetch })(source, identity);
    await vi.runAllTimersAsync();
    await pending;
    expect(transport.requests).toHaveLength(0);
  });
});
