/**
 * Test design (testing-strategy)
 *
 * Setup: resolveCurrentUnit / bearerToken / path helpers. No HTTP.
 *
 * Oracle: auth-unit-matrix design D2 + specs/auth
 *   Header must be a membership; one membership may omit header;
 *   zero memberships cannot pick a unit.
 *
 * Axes
 *   A1 memberships length — 0 / 1 / 2
 *   A2 header — omitted / own / foreign
 *
 * Outputs: O1 unit id string; O2 null
 *
 * Sampled-cell
 *   zero memberships any header | A1 0 | O2 | a unit id
 *   one membership omit header  | A1 1 A2 omit | O1 | null
 *   one membership own header   | A1 1 A2 own | O1 | null
 *   one membership foreign      | A1 1 A2 foreign | O2 | own id
 *   two memberships omit        | A1 2 A2 omit | O2 | first id
 *   two memberships own         | A1 2 A2 own | O1 | null
 *
 * Decision map
 *   D1 memberships.length === 0 T: zero it; F: one/two
 *   D2 header present T: own/foreign; F: omit one and omit two
 *   D3 memberships.includes(header) T: own; F: foreign
 *   D4 memberships.length === 1 on omit T: one omit; F: two omit
 *
 * Path helpers (deploy SPA + /api rewrite)
 *   stripApiPrefix D1 path /api T: /api and /api?q; F: /api/health + untouched
 *   isApiRoutePath D2 prefix match T: /health /conversations/x
 *     /reconciliation-pendings; F: /relatorios
 *   isUnauthenticatedAssetRequest D3 GET/HEAD and not API T: GET /relatorios;
 *     F: GET /conversations, POST /
 *   isHealthPath D4 GET/HEAD /health T: GET+HEAD; F: POST
 *
 * Out of scope: Fastify hook 401 (apps/api/test/accounts.integration.test.ts inject).
 */
import { describe, expect, it } from "vitest";
import {
  bearerToken,
  isApiRoutePath,
  isHealthPath,
  isUnauthenticatedAssetRequest,
  isUnitExemptPath,
  resolveCurrentUnit,
  stripApiPrefix,
} from "./resolve-unit.js";

describe("resolveCurrentUnit", () => {
  it("returns null when the user has zero memberships", () => {
    expect(resolveCurrentUnit("unit-a", [])).toBeNull();
    expect(resolveCurrentUnit(undefined, [])).toBeNull();
  });

  it("uses the sole membership when the header is omitted", () => {
    expect(resolveCurrentUnit(undefined, ["unit-a"])).toBe("unit-a");
  });

  it("accepts a header that is a membership", () => {
    expect(resolveCurrentUnit("unit-a", ["unit-a"])).toBe("unit-a");
    expect(resolveCurrentUnit("unit-b", ["unit-a", "unit-b"])).toBe("unit-b");
  });

  it("returns null for a header that is not a membership", () => {
    expect(resolveCurrentUnit("unit-b", ["unit-a"])).toBeNull();
  });

  it("returns null when two memberships omit the header", () => {
    expect(resolveCurrentUnit(undefined, ["unit-a", "unit-b"])).toBeNull();
  });
});

describe("bearer and path helpers", () => {
  it("reads a Bearer token and ignores missing headers", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
  });

  it("treats GET /health as unauthenticated and /auth/me as unit-exempt", () => {
    expect(isHealthPath("GET", "/health")).toBe(true);
    expect(isHealthPath("HEAD", "/health")).toBe(true);
    expect(isHealthPath("POST", "/health")).toBe(false);
    expect(isUnitExemptPath("GET", "/auth/me")).toBe(true);
    expect(isUnitExemptPath("GET", "/conversations")).toBe(false);
  });

  it("strips a leading /api prefix and leaves other paths unchanged", () => {
    expect(stripApiPrefix("/api")).toBe("/");
    expect(stripApiPrefix("/api?q=1")).toBe("/?q=1");
    expect(stripApiPrefix("/api/health")).toBe("/health");
    expect(stripApiPrefix("/api/conversations?q=1")).toBe("/conversations?q=1");
    expect(stripApiPrefix("/health")).toBe("/health");
    expect(stripApiPrefix("/relatorios")).toBe("/relatorios");
  });

  it("treats CRM HTTP prefixes as API routes and SPA paths as public GETs", () => {
    expect(isApiRoutePath("/health")).toBe(true);
    expect(isApiRoutePath("/conversations/abc")).toBe(true);
    expect(isApiRoutePath("/reconciliation-pendings")).toBe(true);
    expect(isApiRoutePath("/follow-ups")).toBe(true);
    expect(isApiRoutePath("/follow-up")).toBe(false);
    expect(isApiRoutePath("/relatorios")).toBe(false);
    expect(isUnauthenticatedAssetRequest("GET", "/relatorios")).toBe(true);
    expect(isUnauthenticatedAssetRequest("HEAD", "/galeria")).toBe(true);
    expect(isUnauthenticatedAssetRequest("GET", "/conversations")).toBe(false);
    expect(isUnauthenticatedAssetRequest("POST", "/relatorios")).toBe(false);
  });

  it("keeps every route prefix the API actually serves behind auth", () => {
    // This list fails OPEN: a GET path missing from API_PATH_PREFIXES is taken
    // for a static asset and skips JWT validation entirely, with nothing about
    // the route itself revealing it. `/follow-up-counts` shipped missing and was
    // reachable unauthenticated until this test existed. One line per prefix, so
    // adding a route without adding it here fails here rather than in the wild.
    for (const path of [
      "/follow-up-counts",
      "/vehicle-returns/ret-1/reminders",
      "/vehicle-returns/ret-1/archive",
      "/return-reminders/rem-1",
      "/units",
      "/scheduled-messages/sch-1",
      "/vehicles/veh-1/omie-sync",
      "/plate-lookups",
      "/plate-lookups/retry",
    ]) {
      expect(isApiRoutePath(path)).toBe(true);
      expect(isUnauthenticatedAssetRequest("GET", path)).toBe(false);
    }
    // The prefix that nearly caught it: /follow-up is NOT /follow-ups, and a
    // startsWith check on the shorter one would have swallowed the SPA route.
    expect(isApiRoutePath("/follow-up")).toBe(false);
  });
});
