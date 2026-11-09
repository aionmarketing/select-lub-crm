/**
 * Test design (testing-strategy) — the Motul client's host and circuit breaker
 *
 * Split out of `client.test.ts` (wave 5.1a) when `packages/motul` moved into
 * `packages/core`, whose files are capped at 300 lines; cases and assertions
 * unchanged. The retry and per-endpoint cases, and the file's full test-design
 * header (oracle, partitions, out of scope), stay in `client.test.ts`; each
 * block below keeps its own decision map above it.
 *
 * No test reaches Motul: `globalThis.fetch` is replaced in every case and
 * restored after it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getVehicleBrands,
  MOTUL_DEFAULT_BASE_URL,
  MotulError,
  resetMotulBreaker,
} from "./client.js";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Added by oil-quote-retrieval-hardening: the client's host is redirectable.
 *
 * SUT: `baseUrl()` through `getVehicleBrands`, observed as the URL fetch is handed.
 *
 * Oracle: specs/quotes/motul-client-resilience/spec.md "The client host is configurable" — unset
 * means Motul's own gateway, set means exactly that host, and no setting may produce a
 * request to a host nobody configured.
 *
 * Why this exists at all: Motul's API is free and takes no key, so blanking a credential
 * cannot keep a test run off it. Before this seam the only thing keeping the tour suite off
 * `gateway-apim.motul.com` was a fixture whose identity was too incomplete to reach the
 * client — an accident that any alignment work would have removed silently.
 *
 * Axes
 *   E1 MOTUL_BASE_URL — unset / a host / a host with a trailing slash / whitespace only
 *   E2 when it is read — before the module was imported / after
 *
 * Output: O1 the origin+path fetch is called with
 *
 * Sampled cells (one row per `it`)
 *   unset                 | E1 | O1 Motul's own gateway — production is untouched by default
 *   set to a loopback     | E1,E2 | O1 the loopback; THE case, and E2 is why `baseUrl` is a
 *      function: the variable is set long after `client.js` was imported
 *   trailing slash        | E1 | O1 no doubled slash — a config typo must not change the path
 *   whitespace only       | E1 | O1 the default; an empty override is not a host
 *
 * Decision map of `baseUrl`
 *   raw ? … : default     both: the loopback test vs the unset and whitespace tests
 */
describe("the Motul host is configurable", () => {
  const originalBase = process.env.MOTUL_BASE_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) {
      delete process.env.MOTUL_BASE_URL;
    } else {
      process.env.MOTUL_BASE_URL = originalBase;
    }
  });

  /** Runs one request and reports the URL the client tried to reach. */
  async function requestedUrl(): Promise<URL> {
    let seen: URL | undefined;
    globalThis.fetch = async (input) => {
      seen = input instanceof URL ? input : new URL(String(input));
      return jsonResponse(200, { brands: [] });
    };
    await getVehicleBrands("CAR");
    return seen!;
  }

  it("goes to Motul's own gateway when nothing is set", async () => {
    delete process.env.MOTUL_BASE_URL;

    const url = await requestedUrl();

    expect(`${url.origin}${url.pathname}`).toBe(`${MOTUL_DEFAULT_BASE_URL}/vehicle-brands`);
  });

  it("goes where it is pointed, even though the module was imported first", async () => {
    // The import at the top of this file already ran. If the host were captured then, this
    // assignment would be too late — which is exactly the shape that makes a test config
    // look applied while every request still leaves for production.
    process.env.MOTUL_BASE_URL = "http://127.0.0.1:9";

    const url = await requestedUrl();

    expect(url.origin).toBe("http://127.0.0.1:9");
    expect(url.pathname).toBe("/vehicle-brands");
  });

  it("does not double the slash when the override ends in one", async () => {
    process.env.MOTUL_BASE_URL = "http://127.0.0.1:9/oil-advisor/";

    const url = await requestedUrl();

    expect(url.pathname).toBe("/oil-advisor/vehicle-brands");
  });

  it("falls back to the default when the override is only whitespace", async () => {
    process.env.MOTUL_BASE_URL = "   ";

    const url = await requestedUrl();

    expect(url.origin).toBe(new URL(MOTUL_DEFAULT_BASE_URL).origin);
  });
});

/**
 * Added by oil-quote-retrieval-hardening task 2.3.
 *
 * SUT: the circuit breaker around `motulGet`. `globalThis.fetch` is swapped, as in the retry
 * suite above; `resetMotulBreaker()` clears the module state so one case cannot open a
 * breaker that decides the next.
 *
 * Oracle: specs/quotes/motul-client-resilience/spec.md "A gateway that keeps failing is skipped for
 * a cool-down" — N consecutive exhausted-retry failures open it, an open call fails without
 * a request under the same failure contract, the post-cool-down call is a probe, and a 4xx
 * never advances the count.
 *
 * Axes
 *   F1 what failed — 5xx through the whole budget / a 4xx / a network error
 *   F2 failures so far vs the limit — under / at / over
 *   F3 cool-down — still inside / elapsed
 *   F4 the probe — succeeds / fails again
 *
 * Outputs: O1 whether a request was sent; O2 what was thrown; O3 the breaker's later state
 *
 * Sampled cells (one row per `it`)
 *   three exhausted cycles     | F1,F2 | O1 the fourth call sends NOTHING | THE case: the
 *      gateway answered 500 for weeks and every cold quote paid three requests to learn it
 *   open call's error          | F2    | O2 a MotulError, so resolveOil still says
 *      `unavailable` and the dialog can still offer the previous row
 *   4xx repeated               | F1    | O1 still sends — a 4xx is this client asking wrong,
 *      not the gateway being down, and no number of them should stop us trying
 *   cool-down elapsed          | F3,F4 | O1 a probe IS sent, and a 2xx closes the breaker
 *   probe fails                | F4    | O1 the call after it sends nothing again
 *   success resets the count   | F2    | O3 two failures then a success then two failures
 *      does not open it
 */
describe("motulGet circuit breaker", () => {
  const ORIGINAL_COOLDOWN = process.env.MOTUL_BREAKER_COOLDOWN_MS;

  beforeEach(() => {
    resetMotulBreaker();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetMotulBreaker();
    if (ORIGINAL_COOLDOWN === undefined) delete process.env.MOTUL_BREAKER_COOLDOWN_MS;
    else process.env.MOTUL_BREAKER_COOLDOWN_MS = ORIGINAL_COOLDOWN;
  });

  /** Counts requests while every one answers `status`. */
  function alwaysStatus(status: number) {
    const state = { calls: 0 };
    globalThis.fetch = async () => {
      state.calls += 1;
      return jsonResponse(status, { error: "boom" });
    };
    return state;
  }

  /** Runs `n` calls that are each expected to fail, swallowing the errors. */
  async function failTimes(n: number) {
    for (let i = 0; i < n; i += 1) {
      await expect(getVehicleBrands("CAR")).rejects.toThrow();
    }
  }

  it("stops sending requests after three exhausted retry cycles", async () => {
    const state = alwaysStatus(500);

    await failTimes(3);
    const afterThree = state.calls;
    await expect(getVehicleBrands("CAR")).rejects.toThrow();

    // Three cycles of three attempts each; the fourth call adds none.
    expect(afterThree).toBe(9);
    expect(state.calls).toBe(9);
  });

  it("throws a MotulError while open, so the resolver still reports unavailable", async () => {
    alwaysStatus(503);
    await failTimes(3);

    await expect(getVehicleBrands("CAR")).rejects.toBeInstanceOf(MotulError);
  });

  it("never opens on 4xx, which is this client asking wrong", async () => {
    const state = alwaysStatus(404);

    await failTimes(4);

    // One request per call, and no breaker: a 404 is not the gateway being down.
    expect(state.calls).toBe(4);
  });

  it("sends a probe once the cool-down has elapsed, and a good answer closes it", async () => {
    process.env.MOTUL_BREAKER_COOLDOWN_MS = "0";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls <= 9) return jsonResponse(500, { error: "boom" });
      return jsonResponse(200, { brands: [{ id: "1", name: "FIAT", years: ["2020"] }] });
    };

    await failTimes(3);
    const brands = await getVehicleBrands("CAR");

    expect(brands[0]?.name).toBe("FIAT");
  });

  it("stays shut when a probe fails again", async () => {
    process.env.MOTUL_BREAKER_COOLDOWN_MS = "0";
    const state = alwaysStatus(500);
    await failTimes(3);

    // Cool-down is zero, so this one probes: three more attempts.
    await expect(getVehicleBrands("CAR")).rejects.toThrow();
    const afterProbe = state.calls;

    process.env.MOTUL_BREAKER_COOLDOWN_MS = "600000";
    await expect(getVehicleBrands("CAR")).rejects.toThrow();

    expect(state.calls).toBe(afterProbe);
  });

  it("forgets earlier failures after one good answer", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      // Two failing cycles (6 attempts), one success, then two more failing cycles.
      if (calls === 7) return jsonResponse(200, { brands: [{ id: "1", name: "FIAT", years: ["2020"] }] });
      return jsonResponse(500, { error: "boom" });
    };

    await failTimes(2);
    await getVehicleBrands("CAR");
    await failTimes(2);

    // Still shut: the success reset the count, so two more failures are not three.
    const before = calls;
    await expect(getVehicleBrands("CAR")).rejects.toThrow();
    expect(calls).toBeGreaterThan(before);
  });
});
