/**
 * Test design (testing-strategy)
 *
 * Setup: pure functions over an injected env map. No process.env, no HTTP.
 *
 * Oracle: deploy — "Published images report their build identity". `commit`
 *   is a 40-char lowercase hex SHA or the literal `unknown`; an image built
 *   without the build input reports `unknown` rather than omitting the field,
 *   so a comparison against an expected SHA fails instead of passing
 *   vacuously. `uiVariant` narrows exactly as `apps/web/src/uiVariant.ts`
 *   does: anything that is not exactly `antigravity` is `cursor`.
 *
 * Axes
 *   A1 GIT_COMMIT — 40-hex / uppercase 40-hex / padded / 39-hex / non-hex /
 *      empty / unset
 *   A2 VITE_UI_VARIANT — "antigravity" / "cursor" / garbage / empty / unset /
 *      "Antigravity"
 *
 * Outputs: O1 the SHA lowercased; O2 UNKNOWN_COMMIT; O3 "antigravity";
 *   O4 "cursor"
 *
 * Sampled-cell
 *   40-hex              | A1 | O1 | return "unknown"
 *   uppercase 40-hex    | A1 | O1 | reject (Fly/CI may upcase)
 *   padded 40-hex       | A1 | O1 | reject on whitespace
 *   39-hex (truncated)  | A1 BVA | O2 | accept a short SHA as a commit
 *   non-hex 40 chars    | A1 | O2 | accept by length alone
 *   empty / unset       | A1 | O2 | throw or return ""
 *   "antigravity"       | A2 | O3 | return "cursor"
 *   "Antigravity"       | A2 | O4 | case-insensitive match
 *   garbage / empty / unset | A2 | O4 | throw on an unknown id
 *
 * Decision / branch map: COMMIT_SHA_PATTERN.test T 40-hex; F 39-hex, non-hex,
 *   empty. `=== "antigravity"` T the exact id; F every other value.
 *
 * Out of scope: the SPA's own narrowing (apps/web/src/uiVariant.test.ts); the
 *   HTTP payload (apps/api/test/health.test.ts).
 */
import { describe, expect, it } from "vitest";
import { UNKNOWN_COMMIT, resolveBuildCommit, resolveUiVariant } from "./build-identity.js";

const SHA = "a7cdf67b1e4d2c9f08b3a561d7e4c2098fb31d45";

describe("resolveBuildCommit", () => {
  it.each([
    ["a full lowercase SHA", SHA, SHA],
    ["an uppercase SHA", SHA.toUpperCase(), SHA],
    ["a padded SHA", `  ${SHA}\n`, SHA],
  ])("returns the SHA for %s", (_label, value, expected) => {
    expect(resolveBuildCommit({ GIT_COMMIT: value })).toBe(expected);
  });

  it.each([
    ["a truncated 39-character SHA", SHA.slice(0, 39)],
    ["a 40-character non-hex string", "z".repeat(40)],
    ["an empty value", ""],
    ["whitespace only", "   "],
  ])("returns unknown for %s", (_label, value) => {
    expect(resolveBuildCommit({ GIT_COMMIT: value })).toBe(UNKNOWN_COMMIT);
  });

  it("returns unknown when the variable is unset", () => {
    expect(resolveBuildCommit({})).toBe(UNKNOWN_COMMIT);
  });
});

describe("resolveUiVariant", () => {
  it("returns antigravity for the exact id", () => {
    expect(resolveUiVariant({ VITE_UI_VARIANT: "antigravity" })).toBe("antigravity");
  });

  it.each([
    ["the cursor id", "cursor"],
    ["a different case", "Antigravity"],
    ["a typo", "antigravty"],
    ["an empty value", ""],
  ])("returns cursor for %s", (_label, value) => {
    expect(resolveUiVariant({ VITE_UI_VARIANT: value })).toBe("cursor");
  });

  it("returns cursor when the variable is unset", () => {
    expect(resolveUiVariant({})).toBe("cursor");
  });
});
