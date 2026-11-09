/**
 * Test design (testing-strategy)
 *
 * Setup: `normalizeMotulName` and `motulIdentitiesMatch` with no HTTP.
 *
 * Spec: openspec/changes/motul-compatibility-by-model/specs/motul-compatibility/spec.md
 * — Identity match uses Motul resolver normalize (NFD, strip marks, uppercase,
 * drop non-alphanumeric); year is integer equality.
 *
 * Techniques: EP of match vs miss; decision coverage of the four `&&` clauses
 * in `motulIdentitiesMatch`. BVA none (string normalize / year equality).
 *
 * Axes
 * A1 name normalize (make/model/version independently use the same fold)
 *   EP same-after-norm: case, accents, punctuation (sampled chèvrolet vs CHEVROLET (GM))
 *   EP different-after-norm: different catalog spelling (sampled Captiva vs Uno)
 * A2 year integer
 *   EP equal; EP not equal
 *
 * Outputs: O1 strings equal after fold; O2 identities match; O3 identities miss
 *
 * Sampled-cell table
 * it                                              | axes        | O | fails if
 * folds accented chevrolet to catalog spelling    | A1 same     | 1 | strings differ
 * matches identities that only differ in make case| A1+A2 equal | 2 | false
 * misses when year differs                        | A2 unequal  | 3 | true
 * misses when make differs after fold             | A1 diff     | 3 | true
 * misses when model differs after fold            | A1 diff     | 3 | true
 * misses when version differs after fold          | A1 diff     | 3 | true
 *
 * Decision / branch map (`motulIdentitiesMatch`)
 * D1 year ===          T: match + field misses; F: year differs
 * D2 make fold ===     T: match + later misses; F: make differs
 * D3 model fold ===    T: match + version miss; F: model differs
 * D4 version fold ===  T: match; F: version differs
 *
 * Out of scope: incomplete identity (caller treats missing fields as miss;
 * this helper assumes four present values). Live Motul HTTP.
 */
import { describe, expect, it } from "vitest";
import { motulIdentitiesMatch, normalizeMotulName } from "./resolver.js";

const base = {
  make: "CHEVROLET (GM)",
  year: 2012,
  model: "Captiva",
  version: "2.4L SIDI ECOTEC",
};

describe("normalizeMotulName", () => {
  it("folds accented chevrolet to the catalog spelling", () => {
    expect(normalizeMotulName("chèvrolet (gm)")).toBe(
      normalizeMotulName("CHEVROLET (GM)"),
    );
  });
});

describe("motulIdentitiesMatch", () => {
  it("matches identities that only differ in make case and accents", () => {
    expect(
      motulIdentitiesMatch(base, { ...base, make: "chèvrolet (gm)" }),
    ).toBe(true);
  });

  it("misses when year differs", () => {
    expect(motulIdentitiesMatch(base, { ...base, year: 2011 })).toBe(false);
  });

  it("misses when make differs after fold", () => {
    expect(motulIdentitiesMatch(base, { ...base, make: "FIAT" })).toBe(false);
  });

  it("misses when model differs after fold", () => {
    expect(motulIdentitiesMatch(base, { ...base, model: "Uno" })).toBe(false);
  });

  it("misses when version differs after fold", () => {
    expect(
      motulIdentitiesMatch(base, { ...base, version: "1.8" }),
    ).toBe(false);
  });
});
