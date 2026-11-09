/**
 * ============================================================================
 * TEST DESIGN STRATEGY: Tecfil Client Resilience
 * ============================================================================
 *
 * Setup:
 *   `tecfilGet(path, params)` executes an HTTP request to Tecfil in
 *   production. Tests intercept and replace `globalThis.fetch`. The `calls`
 *   counter tracks the total invocations of the mocked fetch. Response
 *   bodies are plain JSON starting with `{` so `decodeTecfilBody` passes
 *   them straight through without needing a real obfuscated envelope —
 *   the decode path itself is covered by `decode.test.ts`.
 *
 * Techniques in THIS file: EP, BVA, branch/decision coverage of `tecfilGet`,
 * mirroring `../motul/client.test.ts` (same retry shape, ported to
 * Tecfil's tenant-key/idm query and its own error type).
 *
 * Spec Reference:
 *   - openspec/changes/tecfil-filter-pricing/specs/tecfil-fitment/spec.md
 *     — "Bounded resilience and call budget", "Requests are Portuguese and
 *     tenant-scoped"
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
 *     - 200–299 (res.ok)              -> Decode and return
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
 *   Valid:       `chavePerfil=<tenant key>` AND `idm=pt` (hardcoded by client)
 *   Invalid:     Missing/wrong parameters (unreachable via public API)
 *   Sampled:     Dedicated 200 test verifies parameter injection
 *   Not Sampled: Asserting params on failure paths (TypeError / 404 / 502)
 *
 * ----------------------------------------------------------------------------
 * 2. EXPECTED OUTPUTS
 * ----------------------------------------------------------------------------
 *   [O1] Return decoded JSON body
 *   [O2] Throw `TecfilError`, `calls === 1`
 *   [O3] Throw `TecfilError`, `calls === 3`
 *   [O4] Throw the original Error, `calls === 1` (not retryable)
 *
 * ----------------------------------------------------------------------------
 * 3. TEST MATRIX — through branch / decision coverage (todos-arcos)
 * ----------------------------------------------------------------------------
 *
 * Structural target: every `if` in `tecfilGet` takes true AND false. EP/BVA
 * above chose the *values*; this table is why those rows exist as a set —
 * together they cover the decisions, not seven unrelated happy paths.
 *
 * Decisions in tecfilGet (client.ts). `—` = that decision is not reached for
 * this sequence (short-circuited or the branch above already returned/threw).
 *
 *   D1  if (res.ok)
 *   D2  if (res.status < 500)                     // only after D1 false
 *   D3  if (attempt < MAX_RETRIES)                // 5xx retry; only after D1 F, D2 F
 *   D4  if (err instanceof TecfilError && status < 500)   // catch; 4xx rethrow
 *   D5  if (attempt < MAX_RETRIES && retryable)    // catch; only after D4 false
 *   D6  isRetryableNetworkError(err)                // only evaluated when err is
 *                                                    // neither TecfilError nor TypeError
 *
 * | Sequence          | D1       | D2 | D3      | D4 | D5 | D6 | Calls | Out | `it`                                       | Fails if...                                   |
 * |:------------------|:--------:|:--:|:-------:|:--:|:--:|:--:|:-----:|:---:|:--------------------------------------------|:-----------------------------------------------|
 * | TypeError -> 200   | T (2nd)  | —  |   —     | F  | T  | —  |   2   | O1  | retries network error then succeeds        | `calls !== 2` or body not returned            |
 * | generic Error      |    —     | —  |   —     | F  | F  | F  |   1   | O4  | does not retry a non-retryable Error       | `calls === 2` (retried) or not the same Error |
 * | 503 -> 200         | F then T | F  |   T     | —  | —  | —  |   2   | O1  | retries 5xx then succeeds                  | `calls === 1` (gave up early) or wrong body   |
 * | AbortError -> 200  | T (2nd)  | —  |   —     | F  | T  | T  |   2   | O1  | retries AbortError (timeout) then succeeds | `calls === 1` (treated as 404) or wrong body  |
 * | 404 forever        |    F     | T  |   —     | T  | —  | —  |   1   | O2  | does not retry 4xx                         | `calls === 2` (retried 4xx) or no `TecfilError`|
 * | 502 x 3            |    F     | F  | T, T, F | F  | F  | —  |   3   | O3  | throws after retry budget exhausted on 5xx | `calls === 4` (cap ignored) or no `TecfilError`|
 * | 200                |    T     | —  |   —     | —  | —  | —  |   1   | O1  | sets chavePerfil and idm=pt                | tenant key/idm wrong or bad body              |
 *
 * Coverage check (every decision needs at least one T row and one F row):
 *
 *   Decision                              | T comes from                         | F comes from
 *   ---------------------------------------|---------------------------------------|-----------------------------------------------
 *   D1  res.ok                             | 200; TypeError->200; AbortError->200 | 404; 503->200; 502x3
 *   D2  status < 500 (only after D1 F)     | 404                                   | 503->200; 502x3
 *   D3  attempt < MAX_RETRIES (5xx path)   | 503->200; 502x3 (1st, 2nd attempt)    | 502x3 (3rd attempt, cap hit)
 *   D4  TecfilError && status < 500 (catch)| 404                                   | TypeError->200; generic Error; AbortError->200; 502x3 (last attempt)
 *   D5  attempt < MAX_RETRIES && retryable | TypeError->200; AbortError->200       | generic Error; 502x3 (last attempt, not < MAX)
 *   D6  isRetryableNetworkError(err)        | AbortError->200                       | generic Error
 *
 * Same `it` may serve EP and a branch: 404 is the invalid 4xx partition AND
 * D2 true / D4 true. 502 x 3 is the retry-cap BVA edge AND D3/D5 false.
 * generic Error is the only sequence where D6 is reached AND false — without
 * it, `isRetryableNetworkError`'s false branch has zero coverage.
 *
 * ----------------------------------------------------------------------------
 * 4. OUT OF SCOPE (Not Covered in This File)
 * ----------------------------------------------------------------------------
 *   - Live Tecfil integration (`pnpm --filter @select-lub/core tecfil:demo`)
 *   - Decoding the real obfuscated envelope (`decode.test.ts` covers it;
 *     here every mocked body is plain JSON so decode is a passthrough)
 *   - Strict status-code edges: 499 / 500 / 501 (BVA; interiors 404/502/503 used)
 *   - Timeout precision boundaries: 7999 / 8000 / 8001 ms
 *   - Query assertions on failure fetches (TypeError / 404 / 502 / generic Error)
 *   - `logRetry`'s `err instanceof Error` false (this file only throws Error
 *     values; a non-Error throw is not in the Tecfil client contract)
 *   - Post-loop `throw tecfilGet: unreachable` (infeasible if the for-loop
 *     always returns or throws inside)
 */
import { afterEach, describe, expect, it } from "vitest";
import { TECFIL_DEFAULT_BASE_URL, tecfilGet, TecfilError } from "./client.js";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

describe("tecfilGet retry", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries network error then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(200, { data: [{ Descricao: "PEUGEOT" }] });
    };

    const body = await tecfilGet<{ data: { Descricao: string }[] }>(
      "consulta",
      { idConsulta: "FABRICANTEAPLICACAO" },
    );

    expect(calls).toBe(2);
    expect(body.data[0]?.Descricao).toBe("PEUGEOT");
  });

  it("does not retry a non-retryable Error", async () => {
    let calls = 0;
    const original = new Error("boom");
    globalThis.fetch = async () => {
      calls++;
      throw original;
    };

    await expect(
      tecfilGet("consulta", { idConsulta: "FABRICANTEAPLICACAO" }),
    ).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it("retries 5xx then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return jsonResponse(503, { error: "unavailable" });
      return jsonResponse(200, { data: [{ Descricao: "PEUGEOT" }] });
    };

    const body = await tecfilGet<{ data: { Descricao: string }[] }>(
      "consulta",
      { idConsulta: "FABRICANTEAPLICACAO" },
    );

    expect(calls).toBe(2);
    expect(body.data[0]?.Descricao).toBe("PEUGEOT");
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
      return jsonResponse(200, { data: [{ Descricao: "PEUGEOT" }] });
    };

    const body = await tecfilGet<{ data: { Descricao: string }[] }>(
      "consulta",
      { idConsulta: "FABRICANTEAPLICACAO" },
    );

    expect(calls).toBe(2);
    expect(body.data[0]?.Descricao).toBe("PEUGEOT");
  });

  it("does not retry 4xx", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse(400, {
        message: "Token reCAPTCHA não fornecido",
        error: "Bad Request",
        statusCode: 400,
      });
    };

    await expect(
      tecfilGet("consulta", { idConsulta: "FABRICANTEAPLICACAO" }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof TecfilError && err.status === 400;
    });
    expect(calls).toBe(1);
  });

  it("throws after retry budget exhausted on 5xx", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse(502, { message: "Resposta inválida do ASP" });
    };

    await expect(
      tecfilGet("consulta", { idConsulta: "FABRICANTEAPLICACAO" }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof TecfilError && err.status === 502;
    });

    expect(calls).toBe(3);
  });

  it("sets chavePerfil and idm=pt on every request", async () => {
    let requested: URL | undefined;
    globalThis.fetch = async (input) => {
      requested = input instanceof URL ? input : new URL(String(input));
      return jsonResponse(200, { data: [] });
    };

    await tecfilGet("consulta", { idConsulta: "FABRICANTEAPLICACAO" });

    expect(requested?.searchParams.get("chavePerfil")).toBeTruthy();
    expect(requested?.searchParams.get("idm")).toBe("pt");
    expect(requested?.searchParams.get("idConsulta")).toBe(
      "FABRICANTEAPLICACAO",
    );
  });
});


/**
 * Added by oil-quote-retrieval-hardening: the client's host is redirectable.
 *
 * SUT: `baseUrl()` through `tecfilGet`, observed as the URL fetch is handed.
 *
 * Oracle: specs/tecfil-filter-pricing/spec.md "The client host is configurable" — unset
 * means Tecfil's own catalogue, set means exactly that host.
 *
 * Same seam and same reason as the Motul case: the API is free and its tenant key is
 * public, so there is no credential to blank and redirecting the host is the only way to
 * keep a test run off the production catalogue.
 *
 * Axes
 *   E1 TECFIL_BASE_URL — unset / a host / a host with a trailing slash / whitespace only
 *   E2 when it is read — before the module was imported / after
 *
 * Output: O1 the origin+path fetch is called with
 *
 * Sampled cells (one row per `it`)
 *   unset              | E1 | O1 Tecfil's own catalogue — production untouched by default
 *   set to a loopback  | E1,E2 | O1 the loopback, set after import; THE case
 *   trailing slash     | E1 | O1 no doubled slash
 *   whitespace only    | E1 | O1 the default; an empty override is not a host
 *
 * Decision map of `baseUrl`
 *   raw ? … : default  both: the loopback test vs the unset and whitespace tests
 */
describe("the Tecfil host is configurable", () => {
  const originalBase = process.env.TECFIL_BASE_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) {
      delete process.env.TECFIL_BASE_URL;
    } else {
      process.env.TECFIL_BASE_URL = originalBase;
    }
  });

  /** Runs one request and reports the URL the client tried to reach. */
  async function requestedUrl(): Promise<URL> {
    let seen: URL | undefined;
    globalThis.fetch = async (input) => {
      seen = input instanceof URL ? input : new URL(String(input));
      return jsonResponse(200, { data: [] });
    };
    await tecfilGet("montadoras", {});
    return seen!;
  }

  it("goes to Tecfil's own catalogue when nothing is set", async () => {
    delete process.env.TECFIL_BASE_URL;

    const url = await requestedUrl();

    expect(`${url.origin}${url.pathname}`).toBe(`${TECFIL_DEFAULT_BASE_URL}/montadoras`);
  });

  it("goes where it is pointed, even though the module was imported first", async () => {
    process.env.TECFIL_BASE_URL = "http://127.0.0.1:9";

    const url = await requestedUrl();

    expect(url.origin).toBe("http://127.0.0.1:9");
    expect(url.pathname).toBe("/montadoras");
  });

  it("does not double the slash when the override ends in one", async () => {
    process.env.TECFIL_BASE_URL = "http://127.0.0.1:9/api/v2/";

    const url = await requestedUrl();

    expect(url.pathname).toBe("/api/v2/montadoras");
  });

  it("falls back to the default when the override is only whitespace", async () => {
    process.env.TECFIL_BASE_URL = "   ";

    const url = await requestedUrl();

    expect(url.origin).toBe(new URL(TECFIL_DEFAULT_BASE_URL).origin);
  });
});
