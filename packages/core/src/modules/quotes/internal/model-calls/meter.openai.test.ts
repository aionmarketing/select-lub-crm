/**
 * Test design (testing-strategy): pricing gpt-6.1-sol (switch-oil-research-to-openai task 1.4)
 *
 * SUT: createUsageMeter, costOfUsage, priceFor, modelPrices, unknownCallUsd for `openai:gpt-6.1-sol`.
 *
 * Oracle: `research-model-calls` delta "Each research call reports what it spent, priced at its
 *   model's list price". Rates per million: 2.00 uncached input, 0.10 cached input, 2.50 cache-write
 *   input, 10.00 output with reasoning billed as output. Above 272,000 input tokens the whole request
 *   is priced at 4.00 / 0.20 / 15.00. A call accepted with no usage is charged the row's estimate,
 *   US$ 0.25 on the placeholder (design.md D5). A configured price overrides the list. The spec's
 *   scenario figures, US$ 0.029, 0.0033 and 0.005, are pinned as literals.
 *   `oil-spec-web-search` delta "Each search's cost is recorded at OpenAI's rates": page actions are
 *   charged until configured free.
 *
 * Cells
 *   list price       | 6,000 in, 1,500 reasoning, 200 out          | 0.029, not by fallback
 *   cached           | 4,000 in of which 3,000 cached, 100 out     | 0.0033
 *   cache write      | 2,000 in, all cache writes                  | 0.005
 *   long context     | 300,000 in, 1,000 out                       | 1.215 (4.00 and 15.00 rates)
 *   override         | input 1.00                                  | override used
 *   aborted          | accepted, no usage                          | 0.25, usage not known
 *   page action      | billed by default / free when configured    | fee counted or not
 */
import { afterEach, describe, expect, it } from "vitest";
import { costOfUsage, createUsageMeter, GPT_6_1_SOL_PRICE, modelPrices, priceFor, unknownCallUsd } from "./meter.js";

afterEach(() => {
  delete process.env.OIL_RESEARCH_MODEL_PRICES;
  delete process.env.WEB_SEARCH_BILL_PAGE_ACTIONS;
});

const call = (usage: Parameters<ReturnType<typeof createUsageMeter>["onCall"]>[0]["usage"]) => ({
  model: "gpt-6.1-sol",
  provider: "openai" as const,
  usage,
  timedOut: false,
  accepted: true,
  effort: "medium" as const,
});

describe("gpt-6.1-sol at its list price", () => {
  it("prices the spec's extraction at US$ 0.029, not by fallback", () => {
    const meter = createUsageMeter();
    meter.onCall(call({ input: 6_000, cachedInput: 0, reasoning: 1_500, output: 200 }));
    const snapshot = meter.snapshot();
    expect(snapshot.costUsd).toBeCloseTo(0.029, 10);
    expect(snapshot.models["openai:gpt-6.1-sol"]).toMatchObject({ pricedByFallback: false, calls: 1 });
    expect(snapshot.usageKnown).toBe(true);
  });

  it("prices cached input apart: US$ 0.0033", () => {
    // The meter's `input` is uncached: 4,000 reported of which 3,000 cached.
    expect(costOfUsage({ input: 1_000, cachedInput: 3_000, reasoning: 0, output: 100 }, GPT_6_1_SOL_PRICE)).toBeCloseTo(0.0033, 10);
  });

  it("prices a cache write at its own rate: US$ 0.005", () => {
    expect(costOfUsage({ input: 0, cachedInput: 0, cacheWrite: 2_000, reasoning: 0, output: 0 }, GPT_6_1_SOL_PRICE)).toBeCloseTo(0.005, 10);
  });

  it("prices a request over 272,000 input tokens whole at the long-context rates", () => {
    expect(costOfUsage({ input: 300_000, cachedInput: 0, reasoning: 0, output: 1_000 }, GPT_6_1_SOL_PRICE)).toBeCloseTo(1.2 + 0.015, 10);
    expect(costOfUsage({ input: 272_000, cachedInput: 0, reasoning: 0, output: 1_000 }, GPT_6_1_SOL_PRICE)).toBeCloseTo(0.544 + 0.01, 10);
  });

  it("lets the model-price setting override the list", () => {
    process.env.OIL_RESEARCH_MODEL_PRICES = JSON.stringify({ "openai:gpt-6.1-sol": { input: "1.00", cachedInput: "0.10", output: "10" } });
    expect(modelPrices()["openai:gpt-6.1-sol"]).toMatchObject({ input: 1 });
    expect(priceFor("openai", "gpt-6.1-sol")).toMatchObject({ byFallback: false, price: { input: 1 } });
  });

  it("charges an accepted call with no usage the US$ 0.25 placeholder estimate", () => {
    const meter = createUsageMeter();
    meter.onCall({ ...call(null), timedOut: true });
    expect(unknownCallUsd("gpt-6.1-sol")).toBe(0.25);
    expect(meter.snapshot()).toMatchObject({ costUsd: 0.25, usageKnown: false, timedOutCalls: 1 });
  });

  it("has no GLM entry any more: a glm:* key is priced by nothing", () => {
    expect(Object.keys(modelPrices())).toEqual(["openai:gpt-6.1-sol"]);
  });
});

describe("search tool calls", () => {
  it("charges a page action the fee by default, and counts it", () => {
    const meter = createUsageMeter();
    meter.onToolCall({ answered: true, kind: "search" });
    meter.onToolCall({ answered: true, kind: "search" });
    meter.onToolCall({ answered: true, kind: "page" });
    expect(meter.snapshot()).toMatchObject({ searchCalls: 3, pageActions: 1 });
    expect(meter.snapshot().costUsd).toBeCloseTo(0.03, 10);
  });

  it("charges nothing for a page action once configured free", () => {
    process.env.WEB_SEARCH_BILL_PAGE_ACTIONS = "false";
    const meter = createUsageMeter();
    meter.onToolCall({ answered: true, kind: "search" });
    meter.onToolCall({ answered: true, kind: "search" });
    meter.onToolCall({ answered: true, kind: "page" });
    expect(meter.snapshot()).toMatchObject({ searchCalls: 2, pageActions: 1 });
    expect(meter.snapshot().costUsd).toBeCloseTo(0.02, 10);
  });
});
