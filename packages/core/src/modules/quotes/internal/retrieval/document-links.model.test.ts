/**
 * Test design (testing-strategy) — the production link selector's budget
 *
 * SUT: createModelDocumentLinkSelector, through the real AI SDK over a fake streamed Responses
 *   transport (no socket, no key).
 *
 * Oracle: orchestrator review of #175 (2026-09-25) — the selector's reported tokens reach the
 *   budget's tally, which `costUsd` prices; background-oil-research D2 — it is streamed, bounded
 *   by the web search's signal and its model's own limits, not a fixed 15 s; D3 — an aborted call
 *   is still reported to the meter, as accepted with no usage and charged the model's unknown-call
 *   estimate (US$ 0.25).
 *
 * Cells: a reply with usage → the tally gets it, split, and the meter one call | the web
 *   search's signal aborts it mid-stream → `null`, the meter an unknown-usage call | no key → no
 *   call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageMeter } from "../model-calls/meter.js";
import { answerScript as answerSteps, createdEvent, fakeTransport, reasoningEvents, reasoningStep, responsesStream as sseResponse, type ResponsesStep } from "../model-calls/fake-openai.js";
import { createModelDocumentLinkSelector } from "./document-links.js";

const identity = { make: "VW", year: 2021, model: "Polo", version: "1.0 TSI" };
const links = [{ url: "https://vw.com.br/dam/m0.pdf", label: "Manual Polo 2021" }];

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createModelDocumentLinkSelector", () => {
  it("reports its tokens to the budget and its call to the meter", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-real";
    const transport = fakeTransport(() =>
      sseResponse(answerSteps('{"picks":[{"index":0,"reason":"Polo 2021"}]}', { input: 900, output: 500, reasoning: 460 })),
    );
    const meter = createUsageMeter();
    const onUsage = vi.fn();

    const picks = await createModelDocumentLinkSelector({ transport: transport.fetch, meter })(links, identity, 1, { timeoutMs: 4_000, onUsage });

    expect(picks).toEqual([{ index: 0, reason: "Polo 2021" }]);
    expect(onUsage).toHaveBeenCalledWith({ input: 900, cachedInput: 0, reasoning: 460, output: 40 });
    expect(meter.snapshot()).toMatchObject({ modelCalls: 1, usageKnown: true, timedOutCalls: 0 });
  });

  it("is aborted by the web search's signal, answers null, and is counted as a call with no usage", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.OPENAI_API_KEY = "test-key-not-real";
    const steady: ResponsesStep[] = [
      { event: createdEvent() },
      ...reasoningEvents().slice(0, 2).map((event) => ({ event })),
      ...Array.from({ length: 40 }, () => reasoningStep(5_000)),
    ];
    const transport = fakeTransport(() => sseResponse(steady));
    const meter = createUsageMeter();
    const budget = new AbortController();
    setTimeout(() => budget.abort(), 8_000);

    const pending = createModelDocumentLinkSelector({ transport: transport.fetch, meter })(links, identity, 1, {
      timeoutMs: 8_000,
      signal: budget.signal,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBeNull();
    const snapshot = meter.snapshot();
    expect(snapshot).toMatchObject({ modelCalls: 1, timedOutCalls: 1, usageKnown: false });
    expect(snapshot.models["openai:gpt-6.1-sol"]).toMatchObject({ calls: 1, unknownCalls: 1 });
    expect(snapshot.costUsd).toBeCloseTo(0.25, 10);
  });

  it("makes no call without a key", async () => {
    const transport = fakeTransport(() => sseResponse([]));

    const picks = await createModelDocumentLinkSelector({ transport: transport.fetch })(links, identity, 1, { timeoutMs: 4_000 });

    expect(picks).toBeNull();
    expect(transport.requests).toHaveLength(0);
  });
});
