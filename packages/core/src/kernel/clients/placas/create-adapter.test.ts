/**
 * Test design (testing-strategy)
 *
 * Setup: createPlacasProvider(env) with injected fetch. HTTP path is not
 * exercised for inactive/mock — credentials must not call fetch when unset.
 *
 * Oracle: openspec/specs/plate-lookup/plate-lookup/spec.md:254, "Provider selection resolves
 * credentials, then mock, then unavailable" — credentials take precedence and an
 * opt-in MUST NOT override them; the opt-in is honoured only when no credentials
 * are configured; a missing credential MUST NOT by itself be treated as a mock
 * opt-in; API_PLACAS_TOKEN is not a credential; mock results must be
 * distinguishable from real ones. A spec scenario outranks the module docstring
 * wherever both speak, so the "trims to \"1\"" contract at create-adapter.ts:31
 * is used only to fix what the spec calls an "explicit" opt-in in this codebase.
 * Checked before use: doc and code agree that the comparison is an exact match
 * after trimming.
 *
 * Axes
 * A1 tokens — unset / APIBRASIL_BEARER_TOKEN / API_PLACAS_TOKEN only / both
 * A2 PLACAS_MOCK — unset / "1" / " 1 " (trimmed) / set-but-not-"1"
 *
 * Outputs: O-null inactive; O-mock source; O-agregados HTTP
 *
 * Decision: APIBrasil credentials first, then mock opt-in, else inactive.
 * API_PLACAS_TOKEN is not a credential in the MVP.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createPlacasProvider, resolvePlacasAccess } from "./create-adapter.js";

function loadSuccess() {
  return JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "./fixtures/agregados-propria-success.json"),
      "utf8",
    ),
  ) as { http: number; json: unknown };
}

describe("createPlacasProvider", () => {
  it("returns null when neither token nor mock opt-in is set", async () => {
    const fetchImpl = vi.fn();
    const provider = createPlacasProvider({}, { fetch: fetchImpl });

    expect(provider).toBeNull();
    expect(resolvePlacasAccess({})).toBe("inactive");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves to inactive when the token is blank rather than mock", () => {
    expect(resolvePlacasAccess({ APIBRASIL_BEARER_TOKEN: "   " })).toBe("inactive");
    expect(createPlacasProvider({ APIBRASIL_BEARER_TOKEN: "   " })).toBeNull();
  });

  it("serves canned data tagged mock when PLACAS_MOCK=1 and no token", async () => {
    const fetchImpl = vi.fn();
    const provider = createPlacasProvider({ PLACAS_MOCK: "1" }, { fetch: fetchImpl });

    expect(provider).not.toBeNull();
    const result = await provider!.lookup("ABC1D23");
    expect(result).toMatchObject({
      status: "found",
      source: "mock",
      billed: false,
      fields: { make: "VW", model: "GOL" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolvePlacasAccess({ PLACAS_MOCK: "1" })).toBe("mock");
  });

  it("uses the real provider when credentials and the mock flag are both set", async () => {
    const fixture = loadSuccess();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(fixture.json), {
          status: fixture.http,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = createPlacasProvider(
      { APIBRASIL_BEARER_TOKEN: "live-token", PLACAS_MOCK: "1" },
      { fetch: fetchImpl },
    );

    expect(resolvePlacasAccess({
      APIBRASIL_BEARER_TOKEN: "live-token",
      PLACAS_MOCK: "1",
    })).toBe("credentials");
    const result = await provider!.lookup("ABC1234");
    expect(result).toMatchObject({
      status: "found",
      source: "provider",
      fields: { model: "GOL" },
    });
    expect(result.status === "found" && result.source).not.toBe("mock");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  // The opt-in is an exact match on "1", not a truthiness check. Without these
  // rows the false side of `env.PLACAS_MOCK?.trim() === "1"` is reached only by
  // `?.` short-circuiting on undefined, so the comparison itself never runs
  // against a value that is set. Rewritten as `Boolean(env.PLACAS_MOCK?.trim())`
  // the rest of this file still passes, while PLACAS_MOCK=0 — what someone sets
  // to mean off — would become an opt-in and serve fabricated vehicles in place
  // of a provider answer.
  it.each([
    { placasMock: "0" }, // explicit off, but a truthy string
    { placasMock: "true" }, // truthy word
    { placasMock: "2" }, // set, but not the opt-in value
    { placasMock: "  " }, // whitespace only, trims to empty
  ])("stays inactive when PLACAS_MOCK is '$placasMock' rather than 1", ({ placasMock }) => {
    const fetchImpl = vi.fn();
    const env = { PLACAS_MOCK: placasMock };

    expect(resolvePlacasAccess(env)).toBe("inactive");
    expect(createPlacasProvider(env, { fetch: fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honours an opt-in padded with whitespace, because the value is trimmed", () => {
    expect(resolvePlacasAccess({ PLACAS_MOCK: " 1 " })).toBe("mock");
  });

  it("stays inactive when only API_PLACAS_TOKEN is set", () => {
    const fetchImpl = vi.fn();
    const env = { API_PLACAS_TOKEN: "path-token" };

    expect(resolvePlacasAccess(env)).toBe("inactive");
    expect(createPlacasProvider(env, { fetch: fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not call API Placas when the primary misses, even with API_PLACAS_TOKEN set", async () => {
    const miss = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "./fixtures/agregados-propria-empty-data.json"),
        "utf8",
      ),
    ) as { http: number; json: unknown };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        expect(url).toContain("gateway.apibrasil.io");
        expect(url).not.toContain("wdapi2.com.br");
        return new Response(JSON.stringify(miss.json), {
          status: miss.http,
          headers: { "content-type": "application/json" },
        });
      });

    const provider = createPlacasProvider(
      { APIBRASIL_BEARER_TOKEN: "live-token", API_PLACAS_TOKEN: "path-token" },
      { fetch: fetchImpl },
    );

    expect(resolvePlacasAccess({
      APIBRASIL_BEARER_TOKEN: "live-token",
      API_PLACAS_TOKEN: "path-token",
    })).toBe("credentials");
    const result = await provider!.lookup("AAA0000");
    expect(result.status).toBe("not_found");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
