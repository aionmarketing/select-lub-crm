/**
 * Test design (testing-strategy)
 *
 * SUT: `apiRead` in http.ts — the shared request path every CRM read goes
 *   through. Fetch is stubbed; no network, no MSW handler needed.
 *
 * Oracle: conversas "A read that never answers is a visible error, not an
 *   empty inbox". A `fetch` with no timeout never rejects, so today a lost
 *   read stays pending forever and every recovery downstream of a rejection —
 *   including React Query's `retry: 1` — is unreachable.
 *
 * Axes
 *   A1 server answers — yes / never
 *   A2 elapsed vs bound — under / over
 *   A3 caller passes its own init — no / yes
 *
 * Outputs
 *   O1 resolves with the Response / rejects
 *   O2 an AbortSignal is attached at all
 *   O3 auth headers still sent
 *
 * Sampled-cell
 *   answers fast        | A1 yes, A2 under | O1 | rejecting a good response
 *   never answers       | A1 no,  A2 over  | O1 | hanging forever (the defect)
 *   no init given       | A3 no            | O2 | an unbounded request
 *   init given          | A3 yes           | O2,O3 | caller init dropping the bound
 *
 * Out of scope: the visible error state (App.test), and mutations, which
 *   raise an at-most-once question this change does not answer.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryUnlessRefused } from "../AppProviders.js";
import { fetchConversations } from "./conversations.js";
import {
  apiRead,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  resolveRequestTimeout,
  SIGNAL_IS_ATTACHABLE,
} from "./http.js";

describe("the configured bound cannot disable the bound", () => {
  // The dangerous direction is a bad value that parses to something a timer
  // accepts. NaN and 0 both fire at once, turning every read into an instant
  // failure that blames a timeout rather than the configuration.
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["a unit suffix", "20s"],
    ["a thousands separator", "15,000"],
    ["zero", "0"],
    ["negative", "-500"],
    ["not a number at all", "fifteen"],
  ])("falls back to the default when the value is %s", (_label, raw) => {
    expect(resolveRequestTimeout(raw)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("honours a valid value, so the fallback is not simply always taken", () => {
    // The positive control. Without it every case above would pass against a
    // function that ignored its argument.
    expect(resolveRequestTimeout("20000")).toBe(20_000);
    expect(resolveRequestTimeout(" 7500 ")).toBe(7_500);
  });
});

describe("the shared request path is bounded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects a read the server never answers", async () => {
    // The defect, stated as a test: without a bound this promise never settles
    // in either direction, so nothing downstream of a rejection can run.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const pending = apiRead("/api/conversations");
    const settled = vi.fn();
    void pending.then(settled, settled);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);

    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it("does not reject a read that answers within the bound", async () => {
    // Guards the other direction: the deployed API's first request after idle
    // takes about 6s, and turning that cold start into an error would be a
    // worse defect than the one being fixed.
    const answer = new Response("{}", { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => answer));

    const pending = apiRead("/api/conversations");
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toBe(answer);
  });

  it("bounds a read whose caller passed no init at all", async () => {
    // The GUARANTEE, not the mechanism. An earlier version of this test
    // asserted that a signal was attached, which is a detail the runtime can
    // legitimately refuse — under jsdom it does. What must hold everywhere is
    // that a read nobody configured still fails instead of hanging, so that a
    // read added later inherits the bound without its author acting.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const pending = apiRead("/api/tags");
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);

    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it("attaches the abort signal exactly when the transport accepts one", async () => {
    // Pins the WIRING rather than the outcome: whichever way the probe
    // answers in this environment, `apiRead` must follow it. A signal attached
    // when the transport rejects it would fail every request; one skipped when
    // it is accepted would leak the socket of every lost read.
    // The SIGNATURE is declared, not the parameters: `vi.fn(async () => ...)`
    // types its call tuple as `[]`, so reading `calls[0][1]` is a type error
    // even though the call really carries two arguments. Declaring the type
    // fixes that without introducing parameters the body never uses.
    const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);

    await apiRead("/api/tags");

    expect("signal" in (spy.mock.calls[0]?.[1] ?? {})).toBe(SIGNAL_IS_ATTACHABLE);
  });

  it("keeps the caller's init and still sends auth headers", async () => {
    const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);

    await apiRead("/api/media", { headers: { accept: "image/png" } });

    const init = spy.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ accept: "image/png" });
    expect(init?.headers).toHaveProperty("Authorization");
  });
});

describe("the inbox error state becomes reachable", () => {
  // The inbox ALREADY renders "Não foi possível carregar as conversas" with a
  // "Tentar de novo" button on `query.isError`, in both UI variants. That code
  // was never the missing piece — it was unreachable. React Query sets
  // `isError` only when the query function REJECTS, and a `fetch` with no
  // bound never rejects, so a lost read left the query pending forever and the
  // list rendered `data ?? []`: an empty inbox, indistinguishable from a unit
  // with no conversations. These two pin the seam the UI hangs off.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fetchConversations rejects when the server never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const pending = fetchConversations();
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);

    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it("an empty list still resolves, so empty never means failed", async () => {
    // The other half of the contract: an empty inbox must keep meaning "this
    // unit has no conversations". If this ever rejected, the fix would have
    // replaced a silent wrong state with a loud wrong one.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(fetchConversations()).resolves.toEqual([]);
  });
});

describe("the retry that could never fire", () => {
  // The defect in one sentence: the app already asks for one retry, and it
  // could never happen. React Query retries on REJECTION, and an unbounded
  // `fetch` does not reject — so `retry` was configured, tested in isolation,
  // and dead in exactly the case it existed for. This asserts the attempt
  // COUNT against the app's own retry policy rather than a policy invented
  // here, because a test-local `retry: 1` would prove nothing about the app.
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("attempts a hung read twice under the app's own retry policy", async () => {
    vi.useFakeTimers();
    const spy = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", spy);

    const client = new QueryClient({ defaultOptions: { queries: { retry: retryUnlessRefused } } });
    const pending = client.fetchQuery({ queryKey: ["conversations"], queryFn: () => fetchConversations() });
    void pending.catch(() => {});

    // First attempt expires, React Query backs off, second attempt expires.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);

    await expect(pending).rejects.toThrow(/timed out/i);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a refused session, which no second token would fix", () => {
    // Guards the other side: making failures retryable must not turn a 401
    // into a request storm. This is the app's policy, asserted directly.
    expect(retryUnlessRefused(0, new Error("http 401"))).toBe(false);
    expect(retryUnlessRefused(0, new Error("request timed out after 15000ms: /api/conversations"))).toBe(true);
  });
});
