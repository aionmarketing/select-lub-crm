/**
 * Test design (testing-strategy) — the identity key (task 2.2, D6)
 *
 * SUT: identityKey, pure.
 *
 * Oracle: design.md D6: the key is the year and the caches' own normalization of make, model
 *   and version, so two identities share a key exactly when `motulIdentitiesMatch` says they
 *   match; accent and case variants share one; `VW` and `Volkswagen` do not (no aliasing); an
 *   incomplete identity has none.
 */
import { describe, expect, it } from "vitest";
import { motulIdentitiesMatch } from "../../../../kernel/clients/motul/index.js";
import { identityKey } from "./identity-key.js";

const GOL = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };

describe("identityKey", () => {
  it("is year|make|model|version, normalized", () => {
    expect(identityKey(GOL)).toBe("2021|VOLKSWAGEN|GOL|10FLEX12V4P");
  });

  it("is shared by accent and case variants", () => {
    expect(identityKey({ make: "Citroën", year: 2020, model: "C3", version: "1.6 Automático" })).toBe(
      identityKey({ make: "CITROEN", year: 2020, model: "c3", version: "1.6 automatico" }),
    );
  });

  it("is not shared by VW and Volkswagen", () => {
    expect(identityKey({ ...GOL, make: "VW" })).not.toBe(identityKey(GOL));
  });

  it.each([
    { ...GOL, make: " " },
    { ...GOL, model: "" },
    { ...GOL, version: null },
    { ...GOL, year: null },
  ])("is null for an incomplete identity: %j", (identity) => {
    expect(identityKey(identity)).toBeNull();
  });

  const pairs: [typeof GOL, typeof GOL][] = [
    [GOL, { ...GOL }],
    [GOL, { ...GOL, version: "1.0 flex 12v 4p" }],
    [GOL, { ...GOL, version: "1.0-FLEX/12V 4P" }],
    [GOL, { ...GOL, version: "1.6 FLEX 12V 4P" }],
    [GOL, { ...GOL, year: 2022 }],
    [GOL, { ...GOL, make: "VW" }],
    [GOL, { ...GOL, model: "Gol G8" }],
    [{ ...GOL, model: "Up!" }, { ...GOL, model: "UP" }],
    [{ ...GOL, make: "Chevrolet (GM)" }, { ...GOL, make: "chevrolet gm" }],
    [{ ...GOL, version: "1.0" }, { ...GOL, version: "10" }],
  ];

  it.each(pairs)("keys are equal exactly when motulIdentitiesMatch: %j vs %j", (a, b) => {
    expect(identityKey(a) === identityKey(b)).toBe(motulIdentitiesMatch(a, b));
  });

  it("has at least one matching and one non-matching pair in its table", () => {
    const matches = pairs.map(([a, b]) => motulIdentitiesMatch(a, b));
    expect(matches).toContain(true);
    expect(matches).toContain(false);
  });
});
