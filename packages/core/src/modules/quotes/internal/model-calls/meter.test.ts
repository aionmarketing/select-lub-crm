/**
 * Test design (testing-strategy) — the per-run usage meter (task 1.6, D3)
 *
 * SUT: createUsageMeter and its pricing, fed by the production extractor and escalation over a
 *   fake transport, and directly. No socket, no key.
 *
 * Oracle: design.md D3 and the `research-model-calls` requirement "Each research call reports what
 *   it spent, priced at its model's list price": spend is per run, so two concurrent runs never
 *   mix; every request is reported, an aborted one as accepted with no usage and charged
 *   OIL_RESEARCH_UNKNOWN_CALL_USD, whose default is the model's row (US$ 0.25); a refusal before
 *   any body books nothing; a model is priced by its own `provider:model` entry, reasoning billed
 *   as output; money settings parse strictly. gpt-6.1-sol's own list (cache writes, long context,
 *   page actions) is in meter.openai.test.ts.
 *
 * (The aborted classification is metered in openai-search.test.ts and the aborted link selector in
 * document-links.model.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEscalationExtractor, createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";
import { answerScript as answerSteps, createdEvent, fakeTransport, responsesStream as sseResponse } from "./fake-openai.js";
import { createUsageMeter, unknownCallUsd } from "./meter.js";
import { moneySetting, resetMoneyReportsForTests } from "./money.js";

const identity = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0" };
const source = { publisher: "vw.com.br", document: "Manual", page: "p. 1", content: { kind: "text" as const, text: "Óleo SAE 5W-40" } };
const EXTRACTION = '{"viscosityGrades":["5W-40"],"classification":"","fillLiters":3.3,"fillKind":"em_servico"}';

const ENV = [
  "OPENAI_API_KEY",
  "ESCALATION_MODEL",
  "OIL_RESEARCH_UNKNOWN_CALL_USD",
  "OIL_RESEARCH_MODEL_PRICES",
  "OIL_RESEARCH_DAILY_BUDGET_USD",
  "OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_INPUT",
  "OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_OUTPUT",
];

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key-not-real";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  resetMoneyReportsForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a meter per run", () => {
  it("counts only its own calls when two runs overlap", async () => {
    const small = fakeTransport(() => sseResponse(answerSteps(EXTRACTION, { input: 100, output: 10, reasoning: 5 })));
    const large = fakeTransport(() => sseResponse(answerSteps(EXTRACTION, { input: 9_000, output: 900, reasoning: 800 })));
    const reading = createUsageMeter();
    const research = createUsageMeter();

    await Promise.all([
      createModelOilSpecExtractor({ transport: small.fetch, meter: reading })(source, identity),
      createModelOilSpecExtractor({ transport: large.fetch, meter: research })(source, identity),
      createModelOilSpecExtractor({ transport: large.fetch, meter: research })(source, identity),
    ]);

    expect(reading.snapshot().models["openai:gpt-6.1-sol"]).toMatchObject({ calls: 1, input: 100, reasoning: 5, output: 5 });
    expect(research.snapshot().models["openai:gpt-6.1-sol"]).toMatchObject({ calls: 2, input: 18_000, reasoning: 1_600, output: 200 });
    expect(research.snapshot().efforts).toEqual([{ model: "gpt-6.1-sol", effort: "medium" }]);
  });

  it("counts an aborted call as unknown, at the estimate", async () => {
    vi.useFakeTimers();
    const silent = fakeTransport(() => sseResponse([{ afterMs: 1_000, event: createdEvent() }]));
    const meter = createUsageMeter();

    const pending = createModelOilSpecExtractor({ transport: silent.fetch, meter })(source, identity);
    await vi.advanceTimersByTimeAsync(250_000);
    await pending;

    expect(meter.snapshot()).toMatchObject({ modelCalls: 1, timedOutCalls: 1, usageKnown: false });
    expect(meter.snapshot().costUsd).toBeCloseTo(0.25, 10);
  });

  it("charges nothing for a call aborted before it was sent (review of #184)", async () => {
    const transport = fakeTransport(() => sseResponse(answerSteps(EXTRACTION)));
    const meter = createUsageMeter();
    const spent = new AbortController();
    spent.abort();

    await createModelOilSpecExtractor({ transport: transport.fetch, meter, signal: spent.signal })(source, identity);

    expect(transport.requests).toHaveLength(0);
    expect(meter.snapshot()).toMatchObject({ modelCalls: 0, costUsd: 0, usageKnown: true });
  });

  it("books nothing for a 401 before any body", async () => {
    const refused = fakeTransport(() => new Response('{"error":{"code":"invalid_api_key","message":"unauthorized"}}', { status: 401 }));
    const meter = createUsageMeter();

    await createModelOilSpecExtractor({ transport: refused.fetch, meter })(source, identity);

    expect(meter.snapshot()).toMatchObject({ costUsd: 0, usageKnown: true, timedOutCalls: 0 });
    expect(meter.snapshot().modelCalls).toBeGreaterThan(0);
  });
});

describe("the unknown-call charge", () => {
  it("is the model's row: US$ 0.25 for gpt-6.1-sol", () => {
    expect(unknownCallUsd("gpt-6.1-sol")).toBe(0.25);
  });

  it("lets OIL_RESEARCH_UNKNOWN_CALL_USD override the row", () => {
    process.env.OIL_RESEARCH_UNKNOWN_CALL_USD = "0.05";

    expect(unknownCallUsd("gpt-6.1-sol")).toBe(0.05);
  });
});

describe("prices", () => {
  it("costs a call at the list prices, reasoning billed as output", () => {
    const meter = createUsageMeter();

    meter.onCall({ model: "gpt-6.1-sol", usage: { input: 10_000, cachedInput: 20_000, reasoning: 4_000, output: 1_000 }, timedOut: false, accepted: true });
    meter.onToolCall({ answered: true });
    meter.onToolCall({ answered: false });

    // 10k × 2.00 + 20k × 0.10 + (4k + 1k) × 10.00, per million, + one answered tool call × 0.01
    expect(meter.snapshot().costUsd).toBeCloseTo(0.02 + 0.002 + 0.05 + 0.01, 10);
    expect(meter.snapshot().searchCalls).toBe(1);
  });

  it("prices an escalation override at its own model's entry", async () => {
    process.env.OIL_RESEARCH_MODEL_PRICES = JSON.stringify({ "openai:gpt-5.4-mini": { input: 1, cachedInput: 0.1, output: 4 } });
    process.env.ESCALATION_MODEL = "gpt-5.4-mini";
    const transport = fakeTransport(() => sseResponse(answerSteps(EXTRACTION, { input: 1_000, output: 500, reasoning: 400 })));
    const meter = createUsageMeter();

    await createEscalationExtractor({ transport: transport.fetch, meter })({ identity, conflicts: [], sources: [source] });

    expect(transport.requests[0]!.body).toMatchObject({ model: "gpt-5.4-mini" });
    const priced = meter.snapshot().models["openai:gpt-5.4-mini"];
    // 1 000 × 1 + 500 × 4, per million.
    expect(priced?.costUsd).toBeCloseTo(0.001 + 0.002, 10);
    expect(priced?.pricedByFallback).toBe(false);
  });

  // Owner ruling on #184: a model with no price entry is charged conservatively, "at the highest price".
  it("charges an unpriced model at the conservative default, marked priced by fallback", () => {
    const meter = createUsageMeter();
    const usage = { input: 1_000, cachedInput: 2_000, reasoning: 500, output: 500 };

    meter.onCall({ model: "gpt-9", provider: "openai", usage, timedOut: false, accepted: true });

    // 1 000 × 5 + 2 000 cached × 5 + (500 + 500) × 15, per million.
    expect(meter.snapshot().costUsd).toBeCloseTo(0.005 + 0.01 + 0.015, 10);
    expect(meter.snapshot().models["openai:gpt-9"]).toMatchObject({ pricedByFallback: true });
    expect(meter.snapshot().usageKnown).toBe(false);
  });

  it("prices an unpriced escalation conservatively, through the factory, with no price settings", async () => {
    process.env.ESCALATION_MODEL = "gpt-5.4-mini";
    const transport = fakeTransport(() => sseResponse(answerSteps(EXTRACTION, { input: 1_000, output: 500, reasoning: 400 })));
    const meter = createUsageMeter();

    await createEscalationExtractor({ transport: transport.fetch, meter })({ identity, conflicts: [], sources: [source] });

    expect(meter.snapshot().models["openai:gpt-5.4-mini"]).toMatchObject({ pricedByFallback: true });
    expect(meter.snapshot().costUsd).toBeCloseTo(0.005 + 0.0075, 10);
  });

  it("lets OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_* set the conservative price", () => {
    process.env.OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_INPUT = "2";
    process.env.OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_OUTPUT = "8";
    const meter = createUsageMeter();

    meter.onCall({ model: "gpt-9", provider: "openai", usage: { input: 1_000_000, cachedInput: 0, reasoning: 0, output: 1_000_000 }, timedOut: false, accepted: true });

    expect(meter.snapshot().costUsd).toBeCloseTo(10, 10);
  });

  it("charges an aborted unpriced call by D3's rule at the conservative price", () => {
    // 240 s × 160 tokens/s × 15 + 7 000 × 5, per million = 0.576 + 0.035, rounded up to a cent.
    expect(unknownCallUsd("gpt-9")).toBe(0.62);
  });

  it("meters the picker apart, outside the capped spend", () => {
    const meter = createUsageMeter();

    meter.onCall({ model: "gpt-5.6-luna", provider: "openai", usage: { input: 500, cachedInput: 0, reasoning: 0, output: 50 }, timedOut: false, accepted: true, picker: true });

    expect(meter.snapshot()).toMatchObject({ costUsd: 0, modelCalls: 0, picker: { calls: 1, usage: { input: 500, output: 50 } } });
  });
});

describe("money settings parse strictly", () => {
  it.each(["1,00", "", "abc", "-1", " ", "1e3", "NaN"])("%j is logged and gives the default", (raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.OIL_RESEARCH_DAILY_BUDGET_USD = raw;

    expect(moneySetting("OIL_RESEARCH_DAILY_BUDGET_USD", 2)).toBe(2);
    expect(warn).toHaveBeenCalledWith("money-setting", expect.stringContaining("OIL_RESEARCH_DAILY_BUDGET_USD"));
  });

  it("accepts a deliberate 0 and a dotted figure", () => {
    process.env.OIL_RESEARCH_DAILY_BUDGET_USD = "0";
    expect(moneySetting("OIL_RESEARCH_DAILY_BUDGET_USD", 2)).toBe(0);
    process.env.OIL_RESEARCH_DAILY_BUDGET_USD = "2.50";
    expect(moneySetting("OIL_RESEARCH_DAILY_BUDGET_USD", 2)).toBe(2.5);
  });

  it("never lets a bad price make the day's sum NaN", () => {
    const meter = createUsageMeter();
    for (const raw of ["1,00", "", "abc", "-1"]) {
      process.env.OIL_RESEARCH_UNPRICED_MODEL_USD_PER_MTOK_OUTPUT = raw;
      process.env.OIL_RESEARCH_UNKNOWN_CALL_USD = raw;
      meter.onCall({ model: "gpt-9", usage: { input: 1, cachedInput: 0, reasoning: 1, output: 1 }, timedOut: false, accepted: true });
      meter.onCall({ model: "gpt-6.1-sol", usage: null, timedOut: true, accepted: true });
    }

    expect(Number.isFinite(meter.snapshot().costUsd)).toBe(true);
  });
});
