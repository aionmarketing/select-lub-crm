/**
 * ============================================================================
 * TEST DESIGN STRATEGY: Motul Client Resilience
 * ============================================================================
 *
 * Setup:
 *   `getVehicleBrands("CAR")` executes an HTTP request to Motul in production.
 *   Tests intercept and replace `globalThis.fetch`. The `calls` counter tracks
 *   the total invocations of the mocked fetch.
 *
 * Techniques in THIS file: EP, BVA, branch/decision coverage of motulGet.
 * Other scenarios (outbox states, forms, E2E) will use other criteria; the
 * requirement is that the rationale for the scenario is explicit, not that
 * every header looks like this one.
 *
 * Spec Reference:
 *   - openspec/specs/quotes/motul-client-resilience/spec.md
 *   - client.ts (MAX_RETRIES = 2 -> maximum 3 fetch attempts)
 *
 * ----------------------------------------------------------------------------
 * 1. INPUT DOMAIN PARTITIONING & BOUNDARY VALUE ANALYSIS (BVA)
 * ----------------------------------------------------------------------------
 *
 * Axis 1 — Result of ONE fetch:
 *   Equivalence Partitions (EP):
 *     - TypeError                     -> Retry
 *     - AbortError (name match)       -> Retry
 *     - generic Error (no name match) -> Do not retry (not in the retryable set)
 *     - 200–299 (res.ok)              -> Return JSON
 *     - Not-OK & status < 500         -> Throw, do not retry (1xx, 3xx, 400–499)
 *     - 500–599                       -> Retry; throw if retry cap reached
 *
 *   BVA on Status Codes:
 *     -1   | Edge | +1   | Transition
 *     ─────┼──────┼──────┼────────────────────────
 *     199  | 200  | 201  | Enter `res.ok`
 *     299  | 300  | 301  | Leave `res.ok`
 *     499  | 500  | 501  | Enter 5xx retry partition
 *
 *   Sampled:     TypeError, AbortError, generic Error (not retryable), 200, 404, 502, 503
 *   Not Sampled: 199, 299, 300, 499, 500, 501
 *
 * Axis 2 — Invocation Sequence / Retry Cap:
 *   Equivalence Partitions (EP):
 *     - Success on attempt 1
 *     - Transient failure -> 2xx recovery
 *     - 5xx until retry budget exhausted
 *
 *   BVA on Fetch Call Count:
 *     -1   | Edge | +1   | Notes
 *     ─────┼──────┼──────┼────────────────────────────────────────
 *      2   |  3   |  4   | 3 = Max allowed attempts; 4 is a defect
 *
 *   Sampled:     1 (404, generic Error), 2 (Transient -> 200), 3 (502 x 3)
 *   Forbidden:   4 (must never execute)
 *
 * Axis 3 — Query String Parameters (EP Only):
 *   Valid:       `locale=pt-BR` AND `BU=Brazil` (hardcoded by client)
 *   Invalid:     Missing/wrong parameters (unreachable via public API)
 *   Sampled:     Dedicated 200 test verifies parameter injection
 *   Not Sampled: Asserting params on failure paths (TypeError / 404 / 502)
 *
 * ----------------------------------------------------------------------------
 * 2. EXPECTED OUTPUTS
 * ----------------------------------------------------------------------------
 *   [O1] Return vehicle brands JSON
 *   [O2] Throw `MotulError`, `calls === 1`
 *   [O3] Throw `MotulError`, `calls === 3`
 *   [O4] Throw the original Error, `calls === 1` (not retryable)
 *
 * ----------------------------------------------------------------------------
 * 3. TEST MATRIX — through branch / decision coverage (todos-arcos)
 * ----------------------------------------------------------------------------
 *
 * Structural target: every `if` in `motulGet` takes true AND false. EP/BVA
 * above chose the *values*; this table is why those rows exist as a set —
 * together they cover the decisions, not seven unrelated happy paths.
 *
 * Decisions in motulGet (client.ts). `—` = that decision is not reached for
 * this sequence (short-circuited or the branch above already returned/threw).
 *
 *   D1  if (res.ok)
 *   D2  if (res.status < 500)                     // only after D1 false
 *   D3  if (attempt < MAX_RETRIES)                // 5xx retry; only after D1 F, D2 F
 *   D4  if (err instanceof MotulError && status < 500)   // catch; 4xx rethrow
 *   D5  if (attempt < MAX_RETRIES && retryable)    // catch; only after D4 false
 *   D6  isRetryableNetworkError(err)                // only evaluated when err is
 *                                                    // neither MotulError nor TypeError
 *
 * | Sequence          | D1       | D2 | D3      | D4 | D5 | D6 | Calls | Out | `it`                                       | Fails if...                                   |
 * |:------------------|:--------:|:--:|:-------:|:--:|:--:|:--:|:-----:|:---:|:--------------------------------------------|:-----------------------------------------------|
 * | TypeError -> 200   | T (2nd)  | —  |   —     | F  | T  | —  |   2   | O1  | retries network error then succeeds        | `calls !== 2` or `brands[0]` is not FIAT      |
 * | generic Error      |    —     | —  |   —     | F  | F  | F  |   1   | O4  | does not retry a non-retryable Error       | `calls === 2` (retried) or not the same Error |
 * | 503 -> 200         | F then T | F  |   T     | —  | —  | —  |   2   | O1  | retries 5xx then succeeds                  | `calls === 1` (gave up early) or no FIAT      |
 * | AbortError -> 200  | T (2nd)  | —  |   —     | F  | T  | T  |   2   | O1  | retries AbortError (timeout) then succeeds | `calls === 1` (treated as 404) or no FIAT     |
 * | 404 forever        |    F     | T  |   —     | T  | —  | —  |   1   | O2  | does not retry 4xx                         | `calls === 2` (retried 4xx) or no `MotulError`|
 * | 502 x 3            |    F     | F  | T, T, F | F  | F  | —  |   3   | O3  | throws after retry budget exhausted on 5xx | `calls === 4` (cap ignored) or no `MotulError`|
 * | 200                |    T     | —  |   —     | —  | —  | —  |   1   | O1  | sets locale pt-BR and BU Brazil            | locale/BU/categoryId wrong or bad catalog     |
 *
 * Coverage check (every decision needs at least one T row and one F row):
 *
 *   Decision                              | T comes from                         | F comes from
 *   ---------------------------------------|---------------------------------------|-----------------------------------------------
 *   D1  res.ok                             | 200; TypeError->200; AbortError->200 | 404; 503->200; 502x3
 *   D2  status < 500 (only after D1 F)     | 404                                   | 503->200; 502x3
 *   D3  attempt < MAX_RETRIES (5xx path)   | 503->200; 502x3 (1st, 2nd attempt)    | 502x3 (3rd attempt, cap hit)
 *   D4  MotulError && status < 500 (catch) | 404                                   | TypeError->200; generic Error; AbortError->200; 502x3 (last attempt)
 *   D5  attempt < MAX_RETRIES && retryable | TypeError->200; AbortError->200       | generic Error; 502x3 (last attempt, not < MAX)
 *   D6  isRetryableNetworkError(err)        | AbortError->200                       | generic Error
 *
 * Same `it` may serve EP and a branch: 404 is the invalid 4xx partition AND
 * D2 true / D4 true. 502 x 3 is the retry-cap BVA edge AND D3/D5 false.
 * generic Error is the only sequence where D6 is reached AND false — without
 * it, `isRetryableNetworkError`'s false branch has zero coverage.
 *
 * ----------------------------------------------------------------------------
 * 3b. PER-ENDPOINT WIRING (added 2026-09-07)
 * ----------------------------------------------------------------------------
 * Everything above drives `motulGet` through `getVehicleBrands` alone. The
 * package's other three exported methods had ZERO references in any test file,
 * so the retry helper was well proven while their own wiring was not proven at
 * all. The second describe covers, per method, the path it requests, the query
 * parameters it sends, and which key it reads out of the response.
 *
 *   axis: method            getVehicleModels | getSubModels | getOilRecommendation
 *   axis: response key      .models | .types | .vehicle  (decoys for all four
 *                           keys are present in every fixture, so reading a
 *                           neighbour's key returns wrong data, not undefined)
 *   output O4               path + params sent
 *   output O5               rows extracted
 *
 *   getVehicleModels …  | O4 O5 | fails if path/params/key wrong
 *   getSubModels …      | O4 O5 | fails if path/params/key wrong
 *   getOilRecommendation| O4 O5 | fails if path/params/key wrong
 *   sends no parameter it was not given | O4 | fails if a neighbour's param leaks in
 *
 * Oracle: the JSDoc on each method (client.ts:107-114, :122-129, :133-140).
 * No OpenSpec scenario reaches this level — none of `vehicle-brands`,
 * `vehicle-models`, `vehicle-types` or `recommendations` appears anywhere under
 * openspec/specs/motul-* — so documented intent is the oracle and code and doc
 * were confirmed to agree first.
 *
 * ----------------------------------------------------------------------------
 * 4. OUT OF SCOPE (Not Covered in This File)
 * ----------------------------------------------------------------------------
 *   - Live Motul integration (`pnpm --filter @select-lub/core motul:demo`)
 *   - Strict status-code edges: 499 / 500 / 501 (BVA; interiors 404/502/503 used)
 *   - Timeout precision boundaries: 7999 / 8000 / 8001 ms
 *   - Query assertions on failure fetches (TypeError / 404 / 502 / generic Error)
 *   - `logRetry`'s `err instanceof Error` false (this file only throws Error
 *     values; a non-Error throw is not in the Motul client contract)
 *   - Post-loop `throw motulGet: unreachable` (infeasible if the for-loop
 *     always returns or throws inside)
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getOilRecommendation,
  getSubModels,
  getVehicleBrands,
  getVehicleModels,
  MotulError,
} from "./client.js";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("motulGet retry", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries network error then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(200, {
        brands: [{ id: "1", name: "FIAT", years: ["2020"] }],
      });
    };

    const brands = await getVehicleBrands("CAR");

    expect(calls).toBe(2);
    expect(brands[0]?.name).toBe("FIAT");
  });

  it("does not retry a non-retryable Error", async () => {
    let calls = 0;
    const original = new Error("boom");
    globalThis.fetch = async () => {
      calls++;
      throw original;
    };

    await expect(getVehicleBrands("CAR")).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it("retries 5xx then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return jsonResponse(503, { error: "unavailable" });
      return jsonResponse(200, {
        brands: [{ id: "1", name: "FIAT", years: ["2020"] }],
      });
    };

    const brands = await getVehicleBrands("CAR");

    expect(calls).toBe(2);
    expect(brands[0]?.name).toBe("FIAT");
  });

  it("retries AbortError (timeout) then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return jsonResponse(200, {
        brands: [{ id: "1", name: "FIAT", years: ["2020"] }],
      });
    };

    const brands = await getVehicleBrands("CAR");

    expect(calls).toBe(2);
    expect(brands[0]?.name).toBe("FIAT");
  });

  it("does not retry 4xx", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse(404, { error: "not found" });
    };

    await expect(getVehicleBrands("CAR")).rejects.toSatisfy((err: unknown) => {
      return err instanceof MotulError && err.status === 404;
    });
    expect(calls).toBe(1);
  });

  it("throws after retry budget exhausted on 5xx", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse(502, { error: "bad gateway" });
    };

    await expect(getVehicleBrands("CAR")).rejects.toSatisfy((err: unknown) => {
      return err instanceof MotulError && err.status === 502;
    });

    expect(calls).toBe(3);
  });

  it("sets locale pt-BR and BU Brazil on every request", async () => {
    let requested: URL | undefined;
    globalThis.fetch = async (input) => {
      requested = input instanceof URL ? input : new URL(String(input));
      return jsonResponse(200, {
        brands: [{ id: "1", name: "FIAT", years: ["2020"] }],
      });
    };

    await getVehicleBrands("CAR");

    expect(requested?.searchParams.get("locale")).toBe("pt-BR");
    expect(requested?.searchParams.get("BU")).toBe("Brazil");
    expect(requested?.searchParams.get("categoryId")).toBe("CAR");
  });
});

/**
 * The retry suite above proves `motulGet` thoroughly, but it only ever enters
 * it through `getVehicleBrands`. The other three exported methods had ZERO
 * references in any test file in the package, so their own wiring — path,
 * query parameters, and which key they read out of the response — was never
 * exercised. That is the shape a copy-paste error survives in: swapping
 * `.types` for `.models` in `getSubModels` breaks a real oil recommendation
 * and leaves every existing test green.
 *
 * Oracle: the JSDoc on each method (client.ts:107-114, :122-129, :133-140),
 * which names the endpoint ("Motul `vehicle-models`"), the parameters, and the
 * rows returned. No OpenSpec scenario reaches this level — `vehicle-brands`,
 * `vehicle-models`, `vehicle-types` and `recommendations` appear nowhere under
 * `openspec/specs/motul-*` — so documented intent is the oracle, and code and
 * doc were confirmed to agree before these were written.
 *
 * Each fixture answers with ALL FOUR sibling keys populated and only one of
 * them correct. That is what makes the response-key assertion bite: a method
 * reading its neighbour's key returns confidently wrong data rather than
 * undefined, so an assertion on the extracted value alone would not
 * necessarily fail.
 */
describe("each Motul endpoint sends its own path and reads its own response key", () => {
  // The retry suite's restore is scoped to its own describe, so this block
  // needs its own or it would leak a stubbed fetch into whatever runs next.
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const decoys = {
    brands: [{ id: "d1", name: "WRONG - brands key" }],
    models: [{ id: "d2", name: "WRONG - models key" }],
    types: [{ id: "d3", name: "WRONG - types key" }],
    vehicle: { model: "WRONG - vehicle key" },
  };

  const cases: {
    name: string;
    call: () => Promise<unknown>;
    path: string;
    params: Record<string, string>;
    body: Record<string, unknown>;
    expected: unknown;
  }[] = [
    {
      name: "getVehicleModels",
      call: () => getVehicleModels("brand-7", "2020"),
      path: "/oil-advisor/vehicle-models",
      params: { vehicleBrandId: "brand-7", year: "2020" },
      body: { ...decoys, models: [{ id: "m1", name: "PALIO" }] },
      expected: [{ id: "m1", name: "PALIO" }],
    },
    {
      name: "getSubModels",
      call: () => getSubModels("model-9"),
      path: "/oil-advisor/vehicle-types",
      params: { vehicleModelId: "model-9" },
      body: { ...decoys, types: [{ id: "t1", name: "1.0 8V FIRE" }] },
      expected: [{ id: "t1", name: "1.0 8V FIRE" }],
    },
    {
      name: "getOilRecommendation",
      call: () => getOilRecommendation("type-3"),
      path: "/oil-advisor/recommendations",
      params: { vehicleTypeId: "type-3" },
      body: { ...decoys, vehicle: { model: "PALIO", startYear: "2011" } },
      expected: { model: "PALIO", startYear: "2011" },
    },
  ];

  it.each(cases)(
    "$name requests $path with its own params and returns its own rows",
    async ({ call, path, params, body, expected }) => {
      let requested: URL | undefined;
      globalThis.fetch = async (input) => {
        requested = input instanceof URL ? input : new URL(String(input));
        return jsonResponse(200, body);
      };

      const result = await call();

      expect(requested?.pathname).toBe(path);
      for (const [key, value] of Object.entries(params)) {
        expect(requested?.searchParams.get(key)).toBe(value);
      }
      // Every method goes through the same helper, so the Brazil pair must
      // survive on all of them and not only on the one the retry suite drives.
      expect(requested?.searchParams.get("locale")).toBe("pt-BR");
      expect(requested?.searchParams.get("BU")).toBe("Brazil");
      expect(result).toEqual(expected);
    },
  );

  it("sends no parameter it was not given", async () => {
    // A method that copied its neighbour's parameter block would still pass
    // the table above, because that only checks the params it EXPECTS to find.
    // getSubModels takes one id; year and vehicleBrandId belong to its
    // neighbour and must not appear.
    let requested: URL | undefined;
    globalThis.fetch = async (input) => {
      requested = input instanceof URL ? input : new URL(String(input));
      return jsonResponse(200, { types: [] });
    };

    await getSubModels("model-9");

    expect([...(requested?.searchParams.keys() ?? [])].sort()).toEqual([
      "BU",
      "locale",
      "vehicleModelId",
    ]);
  });
});
