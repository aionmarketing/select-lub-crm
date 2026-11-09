/**
 * Test design (testing-strategy): a worker stop books the in-flight call's spend (review of #217)
 *
 * SUT: guardRun, with its real signal, `step`, release and meter, over a fake database handle,
 *   fake claim writes, and the real OpenAI call layer (streamModelCall, createOpenAISearch) driven
 *   through a fake Responses transport. No socket, no key, no database.
 *
 * Oracle: background-oil-research D19 (a stop releases the claim and the tick settles only after
 *   the release committed) and the `research-model-calls` spend rules: a call the server accepted
 *   that was aborted reports no usage and is charged `unknownCallUsd` (US$ 0.25), and the fees of
 *   the `web_search_call` items that arrived are charged (US$ 0.01 each). The spend of a run must
 *   reach `oil_research_run.cost_usd`, so the release row carries it.
 *
 * Cells
 *   model call   | stop while a call is streaming        | release written after the call settled; its progress carries US$ 0.25
 *   search call  | stop during a search with 1 action    | progress carries 0.25 + 0.01 fee, the search ends unavailable
 *   no call      | stop with nothing in flight           | released, nothing booked
 *   stuck call   | a call that ignores the abort         | the release is still written after settleMs, with a warning, never held
 *   ordering     | the call settles after the stop       | the release is not written before it settles
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/kernel/db.js";
import { createdEvent, fakeTransport, responsesStream, webSearchCallEvents } from "../src/modules/quotes/internal/model-calls/fake-openai.js";
import { createUsageMeter } from "../src/modules/quotes/internal/model-calls/meter.js";
import { streamModelCall } from "../src/modules/quotes/internal/model-calls/stream-call.js";
import { createOpenAISearch } from "../src/modules/quotes/internal/retrieval/openai-search.js";
import { SearchUnavailableError } from "../src/modules/quotes/internal/retrieval/search-fn.js";
import type { RunProgress } from "../src/modules/quotes/internal/research/run-progress.js";
import { guardRun, type ClaimWrites } from "../src/modules/quotes/run-oil-research/guarded-run.js";

const MODEL = "gpt-6.1-sol";
const MANUAL_PAGE = "https://www.honda.com.br/automoveis/hr-v/manual";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The release rows and the order things happened in, for a run over fake writes. */
function harness(settleMs?: number, meter = createUsageMeter()) {
  const events: string[] = [];
  const released: RunProgress[] = [];
  const db = { tx: async (_module: string, fn: (tx: never) => Promise<unknown>) => fn({} as never) } as unknown as Db;
  const writes: ClaimWrites = {
    renew: async () => true,
    release: async (_tx, _now, progress) => {
      events.push("release");
      released.push(progress);
      return true;
    },
  };
  const stop = new AbortController();
  const run = guardRun(db, writes, { stop: stop.signal, ceilingMs: 60_000, now: () => new Date(0), meter, ...(settleMs !== undefined ? { settleMs } : {}) });
  return { run, stop, released, events };
}

/** A transport whose stream says `created` and then goes silent: a call still reasoning. */
function silentTransport(beforeSilence: Record<string, unknown>[] = []) {
  return fakeTransport(() => responsesStream([{ event: createdEvent() }, ...beforeSilence.map((event) => ({ event }))]));
}

describe("a stop releases the claim with the aborted call's spend", () => {
  it("books the US$ 0.25 charge of a model call the stop aborted", async () => {
    const { run, stop, released, events } = harness();
    const transport = silentTransport();
    const stepped = run.step("extraction", async () => {
      const result = await streamModelCall({
        apiKey: "placeholder-not-a-key",
        model: MODEL,
        effort: "medium",
        system: "s",
        prompt: "p",
        label: "test",
        transport: transport.fetch,
        meter: run.meter,
        signal: run.signal,
      });
      events.push("call settled");
      return result;
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));

    stop.abort();
    const result = await stepped;
    const { released: written } = await run.settle();

    expect(result).toMatchObject({ failed: true, timeout: "budget" });
    expect(written).toBe(true);
    expect(released).toHaveLength(1);
    // The spend of the aborted call is in the row: US$ 0.25, an accepted call with no usage.
    expect(released[0]!.meter!.costUsd).toBeCloseTo(0.25, 10);
    expect(released[0]!.meter).toMatchObject({ modelCalls: 1, timedOutCalls: 1, usageKnown: false });
    // And it was booked first: the release came after the call settled.
    expect(events).toEqual(["call settled", "release"]);
  });

  it("books the search fee and the US$ 0.25 charge of a search the stop aborted", async () => {
    const { run, stop, released } = harness();
    // One web_search_call arrived, then the stream went silent.
    const transport = silentTransport(webSearchCallEvents("ws_0", { type: "search", sources: [MANUAL_PAGE] }, 0));
    const search = createOpenAISearch({
      apiKey: "placeholder-not-a-key",
      effort: "medium",
      httpFetch: transport.fetch,
      wait: async () => undefined,
      log: () => undefined,
      meter: run.meter,
    });
    const stepped = run.step("webSearch", () => search(MODEL, "Honda HR-V 2021", 60_000, undefined, run.signal));
    const outcome = stepped.then(
      () => "answered",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    // Let the stream deliver its web_search_call before the stop, so the fee is something to book.
    await new Promise((resolve) => setTimeout(resolve, 20));

    stop.abort();
    expect(await outcome).toBeInstanceOf(SearchUnavailableError);
    await run.settle();

    expect(released).toHaveLength(1);
    expect(released[0]!.meter).toMatchObject({ searchCalls: 1, timedOutCalls: 1 });
    expect(released[0]!.meter!.costUsd).toBeCloseTo(0.25 + 0.01, 10);
  });

  it("releases at once, with nothing booked, when no call is in flight", async () => {
    const { run, stop, released } = harness();

    stop.abort();
    const { released: written } = await run.settle();

    expect(written).toBe(true);
    expect(released).toHaveLength(1);
    expect(released[0]!.meter!.costUsd).toBe(0);
  });

  it("does not hold the release for a call that ignores the abort: it is written after settleMs, with a warning", async () => {
    const { run, stop, released } = harness(40);
    const stuck = new Promise<never>(() => undefined);
    let entered = false;
    void run
      .step("extraction", () => {
        entered = true;
        return stuck;
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(entered).toBe(true));

    stop.abort();
    const started = Date.now();
    const { released: written } = await run.settle();

    expect(written).toBe(true);
    expect(released).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(console.warn).toHaveBeenCalledWith("oil-research", expect.stringContaining("release_before_settle"));
  });

  it("waits for a call that settles late, within settleMs, and books what it reported", async () => {
    const { run, stop, released } = harness(2_000);
    let finish: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered = false;
    void run
      .step("extraction", async () => {
        entered = true;
        await late;
        run.meter.onCall({ model: MODEL, usage: null, timedOut: true, accepted: true, effort: "medium" });
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(entered).toBe(true));

    stop.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Still waiting: the call has not settled, so nothing is written yet.
    expect(released).toHaveLength(0);
    finish();
    await run.settle();

    expect(released).toHaveLength(1);
    expect(released[0]!.meter!.costUsd).toBeCloseTo(0.25, 10);
  });
});
