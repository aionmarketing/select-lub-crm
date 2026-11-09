/**
 * Test design (testing-strategy) — the streaming call helper's limits (task 1.3)
 *
 * SUT: streamModelCall and limitsFor / reportUnmeasuredOpenAILimits, through the real AI SDK over a
 *   fake transport that streams Responses API events on fake timers. No socket, no key.
 *
 * Oracle: design.md D6 and the `research-model-calls` requirement "A research call is limited by a
 *   measured ceiling and its budget, not a fixed short timeout": a call is aborted only by its
 *   ceiling (`ceiling`), the outer signal (`budget`), or — when the model's row carries one — its
 *   idle time (`idle`); steady reasoning is never cut; a silent call is not cut either, because
 *   the row has no idle time; an incomplete reply with no answer is a failure; usage comes from
 *   the final event, cache writes and reasoning apart.
 *
 * Cells
 *   limits      | gpt-6.1-sol at medium, other efforts, unset   | the row, pinned as literals
 *   env         | OIL_RESEARCH_CALL_TIMEOUT_MS / WEB_SEARCH_TIMEOUT_MS | the override wins
 *   placeholder | another model; a model with no effort          | the placeholder row, logged once per pair
 *   stream      | reasoning every 5 s for 90 s, then answer      | used, no timeout
 *   stream      | 2 min of silence mid-reasoning, then answer    | used (no idle timer)
 *   stream      | reasoning every 5 s past 240 s                 | ceiling
 *   stream      | a row with an idle time, 31 s of silence       | idle
 *   stream      | outer signal aborted mid-stream                | budget
 *   stream      | final event carries usage                      | usage split, reasoning apart
 *   stream      | incomplete, max_output_tokens, no content      | failed
 *   .env.example| the documented defaults                        | match the code
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEffortReportsForTests } from "./effort.js";
import {
  answerScript,
  completedEvent,
  createdEvent,
  fakeTransport,
  incompleteEvent,
  messageEvents,
  reasoningEvents,
  reasoningStep,
  responsesStream,
  type ResponsesStep,
} from "./fake-openai.js";
import { limitsFor, OPENAI_LIMITS, PLACEHOLDER_LIMITS, reportUnmeasuredOpenAILimits } from "./limits.js";
import { OIL_RESEARCH_DEFAULT_MAX_OUTPUT_TOKENS } from "./research-model.js";
import { streamModelCall } from "./stream-call.js";

const request = { apiKey: "placeholder-not-a-key", model: "gpt-6.1-sol", effort: "medium" as const, system: "s", prompt: "p", label: "test" };

/** The events that open a reasoning item, then a summary delta every `everyMs` for `forMs`, then (optionally) an answer. */
function steady(everyMs: number, forMs: number, answer?: string): ResponsesStep[] {
  const steps: ResponsesStep[] = [{ event: createdEvent() }, ...reasoningEvents().slice(0, 2).map((event) => ({ event }))];
  for (let at = everyMs; at <= forMs; at += everyMs) steps.push(reasoningStep(everyMs));
  if (answer !== undefined) steps.push(...messageEvents(answer).map((event) => ({ event })), { event: completedEvent({ input: 10, output: 5 }) }, { end: true });
  return steps;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetEffortReportsForTests();
  for (const name of ["OIL_RESEARCH_REASONING_EFFORT", "OIL_RESEARCH_CALL_TIMEOUT_MS", "WEB_SEARCH_TIMEOUT_MS", "OIL_RESEARCH_MODEL"]) {
    delete process.env[name];
  }
  delete OPENAI_LIMITS["gpt-6.1-sol"]!.low;
});

describe("limitsFor", () => {
  it("runs gpt-6.1-sol at medium on its measured row", () => {
    expect(limitsFor("gpt-6.1-sol")).toEqual({ idleMs: Number.POSITIVE_INFINITY, callMs: 240_000, webMs: 300_000, runMs: 45 * 60_000, unknownCallUsd: 0.25 });
    expect(OPENAI_LIMITS["gpt-6.1-sol"]!.medium).toEqual(limitsFor("gpt-6.1-sol"));
  });

  it("lets the environment override the row", () => {
    process.env.OIL_RESEARCH_CALL_TIMEOUT_MS = "600000";
    process.env.WEB_SEARCH_TIMEOUT_MS = "90000";

    expect(limitsFor("gpt-6.1-sol")).toMatchObject({ callMs: 600_000, webMs: 90_000 });
  });

  it("ignores a timeout override that is not a positive integer", () => {
    process.env.OIL_RESEARCH_CALL_TIMEOUT_MS = "soon";

    expect(limitsFor("gpt-6.1-sol").callMs).toBe(240_000);
  });
});

describe("the placeholder row", () => {
  it("runs another effort on the placeholder, and logs that pair once at start-up", () => {
    const log = vi.fn();

    expect(limitsFor("gpt-6.1-sol", "high")).toEqual(PLACEHOLDER_LIMITS);
    const pairs = reportUnmeasuredOpenAILimits(
      [
        { setting: "OIL_RESEARCH_MODEL", model: "gpt-6.1-sol", effort: "high" },
        { setting: "ESCALATION_MODEL", model: "gpt-6.1-sol", effort: "high" },
      ],
      log,
    );

    expect(pairs).toEqual([{ model: "gpt-6.1-sol", effort: "high", settings: ["OIL_RESEARCH_MODEL", "ESCALATION_MODEL"] }]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("does so for a model sent no effort", () => {
    const log = vi.fn();

    expect(limitsFor("gpt-9-unlisted", null)).toEqual(PLACEHOLDER_LIMITS);
    expect(reportUnmeasuredOpenAILimits([{ setting: "OIL_RESEARCH_MODEL", model: "gpt-9-unlisted", effort: null }], log)).toEqual([
      { model: "gpt-9-unlisted", effort: "none", settings: ["OIL_RESEARCH_MODEL"] },
    ]);
  });

  it("reports nothing when every configured model is measured", () => {
    expect(reportUnmeasuredOpenAILimits([{ setting: "OIL_RESEARCH_MODEL", model: "gpt-6.1-sol", effort: "medium" }], vi.fn())).toEqual([]);
  });
});

describe(".env.example documents the defaults (task 1.9)", () => {
  const documented = (name: string) => {
    const text = readFileSync(resolve(import.meta.dirname, "../../../../../../../.env.example"), "utf8");
    const match = new RegExp(`^# ${name}=(.*)$`, "m").exec(text);
    return match?.[1]?.trim();
  };
  const row = limitsFor("gpt-6.1-sol");

  it.each([
    ["OIL_RESEARCH_MODEL", "gpt-6.1-sol"],
    ["OIL_RESEARCH_REASONING_EFFORT", "medium"],
    ["OIL_RESEARCH_CALL_TIMEOUT_MS", String(row.callMs)],
    ["WEB_SEARCH_TIMEOUT_MS", String(row.webMs)],
    ["OIL_RESEARCH_UNKNOWN_CALL_USD", String(row.unknownCallUsd)],
    ["OIL_RESEARCH_MAX_OUTPUT_TOKENS", String(OIL_RESEARCH_DEFAULT_MAX_OUTPUT_TOKENS)],
    ["OIL_SELECTOR_MAX_RANGES", "4"],
  ])("%s is documented as %s", (name, value) => {
    expect(documented(name)).toBe(value);
  });
});

describe("streamModelCall", () => {
  it("does not abort steady reasoning past 20 s, nor at 90 s under the ceiling", async () => {
    const transport = fakeTransport(() => responsesStream(steady(5_000, 90_000, '{"ok":true}')));

    const pending = streamModelCall({ ...request, transport: transport.fetch });
    await vi.advanceTimersByTimeAsync(95_000);
    const result = await pending;

    expect(result).toMatchObject({ text: '{"ok":true}', timeout: null, failed: false });
  });

  // OpenAI documents no keep-alive while a model reasons, so the row has no idle time: a call
  // that is silent for minutes and then answers is used.
  it("does not abort a silent stream: the row has no idle time", async () => {
    const transport = fakeTransport(() =>
      responsesStream([
        { event: createdEvent() },
        ...messageEvents("{}").map((event, i) => ({ afterMs: i === 0 ? 120_000 : 0, event })),
        { event: completedEvent({ input: 10, output: 5 }) },
        { end: true },
      ]),
    );

    const pending = streamModelCall({ ...request, transport: transport.fetch });
    await vi.advanceTimersByTimeAsync(125_000);
    const result = await pending;

    expect(result).toMatchObject({ text: "{}", timeout: null, failed: false });
  });

  it("aborts a gap longer than the idle time with idle, when the row has one", async () => {
    OPENAI_LIMITS["gpt-6.1-sol"]!.low = { ...PLACEHOLDER_LIMITS, idleMs: 30_000 };
    const transport = fakeTransport(() => responsesStream([{ event: createdEvent() }, ...messageEvents("late").map((event, i) => ({ afterMs: i === 0 ? 31_000 : 0, event }))]));

    const pending = streamModelCall({ ...request, effort: "low", transport: transport.fetch });
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;

    expect(result).toMatchObject({ timeout: "idle", failed: true, usage: null });
  });

  it("aborts a stream past the ceiling with ceiling", async () => {
    const transport = fakeTransport(() => responsesStream(steady(5_000, 300_000)));

    const pending = streamModelCall({ ...request, transport: transport.fetch });
    await vi.advanceTimersByTimeAsync(250_000);
    const result = await pending;

    expect(result).toMatchObject({ timeout: "ceiling", failed: true });
  });

  it("aborts with budget when the outer signal aborts", async () => {
    const transport = fakeTransport(() => responsesStream(steady(5_000, 200_000)));
    const outer = new AbortController();
    setTimeout(() => outer.abort(), 12_000);

    const pending = streamModelCall({ ...request, transport: transport.fetch, signal: outer.signal });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    expect(result).toMatchObject({ timeout: "budget", failed: true });
  });

  it("reads the usage from the final event, cache writes and reasoning apart", async () => {
    const transport = fakeTransport(() => responsesStream(answerScript("{}", { input: 6_000, cached: 1_000, cacheWrite: 500, output: 700, reasoning: 600 })));

    const pending = streamModelCall({ ...request, transport: transport.fetch });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.usage).toEqual({ input: 4_500, cachedInput: 1_000, cacheWrite: 500, reasoning: 600, output: 100 });
  });

  it("treats an incomplete reply at max_output_tokens with no content as a failure", async () => {
    const transport = fakeTransport(() =>
      responsesStream([{ event: createdEvent() }, ...reasoningEvents().map((event) => ({ event })), { event: incompleteEvent({ input: 100, output: 25_000, reasoning: 25_000 }) }, { end: true }]),
    );

    const pending = streamModelCall({ ...request, transport: transport.fetch });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result).toMatchObject({ failed: true, timeout: null, text: "" });
  });
});
