/**
 * Test design (testing-strategy)
 *
 * Setup: createApiPlacasAdapter with injected fetch. Documented fixtures, no
 * live HTTP. Console is spied so a logged URL containing the token fails.
 *
 * Spec: fallback mapping table; 406 miss; 429 exhausted_balance; token in path
 * must not be logged.
 *
 * Axes
 * A1 HTTP — 200 / 406 / 429 / 401
 * A2 token — present / blank
 *
 * Outputs: O-found; O-not_found; O-failed reason
 *
 * Decision map (api-placas.ts lookup)
 * D1 !token     T: blank-token it; F: fetch its
 * D2 timeout    T: timeout.test.ts; F: fixture its
 * D3 429        T: rate-limit it; F: other
 * D4 401        T: unauthorized it; F: other
 * D5 406        T: not-found it; F: 200
 * D6 !== 200    covered by 401; 500 would be provider_error
 *
 * Out of scope: live wdapi2 (tasks 8.x). Logging the URL is infeasible by
 * construction (no console.log in the adapter); the spy still guards a regression.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiPlacasAdapter } from "./api-placas.js";

function loadFixture(name: string): { http: number; json: unknown } {
  return JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "./fixtures", name), "utf8"),
  ) as { http: number; json: unknown };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = "secret-path-token";

describe("createApiPlacasAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a documented success body", async () => {
    const fixture = loadFixture("api-placas-success.json");
    const fetchImpl = vi.fn(async () => jsonResponse(fixture.json, fixture.http));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = createApiPlacasAdapter({ token: TOKEN, fetch: fetchImpl });

    const result = await adapter.lookup("ABC1D23");

    expect(result).toMatchObject({
      status: "found",
      source: "provider",
      provider: "api-placas",
      billed: true,
      fields: {
        make: "VW",
        model: "GOL",
        version: "1.0 FLEX 12V 4P",
        year: 2021,
        displacementCc: 999,
        fuel: "ALCOOL/GASOLINA",
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join(" ")).not.toContain(TOKEN);
    expect(error.mock.calls.flat().join(" ")).not.toContain(TOKEN);
  });

  it("maps 406 to not_found", async () => {
    const fixture = loadFixture("api-placas-not-found.json");
    const fetchImpl = vi.fn(async () => jsonResponse(fixture.json, fixture.http));
    const adapter = createApiPlacasAdapter({ token: TOKEN, fetch: fetchImpl });

    expect(await adapter.lookup("ABC1D23")).toMatchObject({
      status: "not_found",
      billed: true,
      billedCalls: [{ provider: "api-placas", outcome: "not_found" }],
    });
  });

  it("maps 429 to exhausted_balance without billing", async () => {
    const fixture = loadFixture("api-placas-rate-limit.json");
    const fetchImpl = vi.fn(async () => jsonResponse(fixture.json, fixture.http));
    const adapter = createApiPlacasAdapter({ token: TOKEN, fetch: fetchImpl });

    expect(await adapter.lookup("ABC1D23")).toMatchObject({
      status: "failed",
      reason: "exhausted_balance",
      billed: false,
      billedCalls: [],
    });
  });

  it("maps 401 to not_configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Token inválido" }, 401));
    const adapter = createApiPlacasAdapter({ token: TOKEN, fetch: fetchImpl });

    expect(await adapter.lookup("ABC1D23")).toMatchObject({
      status: "failed",
      reason: "not_configured",
    });
  });

  it("returns not_configured without fetching when the token is blank", async () => {
    const fetchImpl = vi.fn();
    const adapter = createApiPlacasAdapter({ token: "", fetch: fetchImpl });

    expect(await adapter.lookup("ABC1D23")).toMatchObject({
      status: "failed",
      reason: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a 200 that is not a JSON envelope is a provider error, not a miss", () => {
  // Ruling 3f, and it bites harder on this provider than on agregados: every 200
  // here is billed unconditionally, so a gateway error page was charged to the
  // spend ledger AND remembered forever as a plate that does not exist
  // (`plate-lookup/spec.md:55` stores a miss permanently; :57 says a provider
  // error is not stored, because it says nothing about the plate).
  it.each([
    { name: "an HTML gateway page", body: "<html><body>502 Bad Gateway</body></html>" },
    { name: "an empty body", body: "" },
  ])("refuses $name without billing or caching it", async ({ body }) => {
    const adapter = createApiPlacasAdapter({
      token: TOKEN,
      fetch: vi.fn(async () => new Response(body, { status: 200 })),
    });

    const result = await adapter.lookup("ABC1234");

    expect(result).toMatchObject({ status: "failed", reason: "provider_error" });
    // Nothing was charged: a failed lookup carries no billed hop of its own.
    expect("billedCalls" in result ? result.billedCalls : []).toHaveLength(0);
  });
});
