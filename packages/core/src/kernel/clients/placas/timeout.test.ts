/**
 * Test design (testing-strategy)
 *
 * Setup: fetchWithTimeout with injected fetch; createAgregadosPropriaAdapter
 * with a never-resolving fetch that honors AbortSignal, and a short timeoutMs.
 *
 * Oracle, strongest first:
 *   - openspec/specs/plate-lookup/plate-lookup/spec.md:148, "A lookup has a bounded wait" —
 *     each provider call abandoned after 8 seconds, a timeout treated as a
 *     provider failure, never recorded as a miss and nothing cached. The 8000
 *     constant is asserted against this sentence, not against the code: the spec
 *     names the number, so it is documented intent rather than an implementation
 *     value copied back into a test.
 *   - Module contract at timeout.ts:56 and :59 ("returning `undefined` when the
 *     response is not JSON" / "@returns Parsed value, or `undefined` on parse
 *     failure"), NOT an OpenSpec scenario — the weaker oracle, recorded
 *     deliberately, and used only for the readJsonBody rows. Checked against the
 *     code before use: the catch arm returns undefined for any parse failure,
 *     matching the doc. The spec is silent on how a malformed body maps to an
 *     outcome, which is a separate finding and is NOT pinned here.
 *
 * Axes
 * A1 fetch outcome — response / AbortError / other error
 * A2 timeoutMs — production 8000 vs injected short budget
 * A3 response body — JSON / HTML / empty
 *
 * Outputs: O-response; O-timeout; O-error; O-failed provider_error; O-undefined body
 *
 * Decision map (timeout.ts)
 * D1 aborted / AbortError    T: timeout it; F: TypeError it
 * D2 adapter timeout         T: never-resolving it; F: success fixture (agregados tests)
 * D3 readJsonBody parse      T: JSON it; F: HTML and empty its
 *
 * Out of scope: waiting a real 8s in CI — the constant is asserted, the
 * abort path uses a 30ms budget.
 */
import { describe, expect, it, vi } from "vitest";
import { createAgregadosPropriaAdapter } from "./agregados-propria.js";
import { fetchWithTimeout, PROVIDER_TIMEOUT_MS, readJsonBody } from "./timeout.js";

/**
 * A fetch stub that never resolves unless the abort signal fires, so the 8s
 * budget (or the injected short one) is what abandons the call.
 */
function neverResolvingFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    signal.addEventListener("abort", () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
}

describe("PROVIDER_TIMEOUT_MS", () => {
  it("matches the Motul client budget of 8 seconds", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(8_000);
  });
});

describe("fetchWithTimeout", () => {
  it("returns the response when fetch resolves", async () => {
    const response = new Response("{}", { status: 200 });
    const result = await fetchWithTimeout(
      async () => response,
      "https://example.test",
      {},
      50,
    );
    expect(result).toEqual({ kind: "response", response });
  });

  it("returns timeout when fetch never resolves", async () => {
    const result = await fetchWithTimeout(
      neverResolvingFetch,
      "https://example.test",
      {},
      30,
    );
    expect(result).toEqual({ kind: "timeout" });
  });

  it("returns error on a non-abort rejection", async () => {
    const result = await fetchWithTimeout(
      async () => {
        throw new TypeError("network");
      },
      "https://example.test",
      {},
      50,
    );
    expect(result).toEqual({ kind: "error" });
  });
});

describe("readJsonBody", () => {
  it("returns the parsed value for a JSON body", async () => {
    const parsed = await readJsonBody(
      new Response(JSON.stringify({ data: { marca: "VW" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(parsed).toEqual({ data: { marca: "VW" } });
  });

  // A gateway answering 200 with an HTML error page, or with nothing at all, is
  // the shape that reaches this. The catch arm had no reaching input before
  // these rows, so a change that let the parse error escape would have thrown
  // out of the adapter's lookup instead of being mapped to an outcome.
  it.each([
    { label: "an HTML error page", body: "<html><body>502 Bad Gateway</body></html>" },
    { label: "an empty body", body: "" },
    { label: "truncated JSON", body: '{"data":' },
  ])("returns undefined for $label rather than throwing", async ({ body }) => {
    const parsed = await readJsonBody(new Response(body, { status: 200 }));

    expect(parsed).toBeUndefined();
  });
});

describe("adapter timeout", () => {
  it("abandons a never-resolving fetch and reports provider_error", async () => {
    const fetchImpl = vi.fn(neverResolvingFetch);
    const adapter = createAgregadosPropriaAdapter({
      token: "test-token",
      fetch: fetchImpl,
      timeoutMs: 30,
    });

    const result = await adapter.lookup("ABC1234");

    expect(result).toMatchObject({
      status: "failed",
      reason: "provider_error",
      billed: false,
    });
    expect(result).not.toHaveProperty("fields");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
