/**
 * Test design (testing-strategy) — a leading SAE does not make a grade invalid (task 1.15, D23)
 *
 * SUT: normalizeSaeGrade / normalizeSaeGrades, validateExtractedSpec, and readForIdentity over a
 *   fake extractor. Pure; no model.
 *
 * Oracle: `oil-quote` delta "An SAE grade is normalized before it is checked": case ignored,
 *   spaces dropped, a leading `SAE` dropped with or without spaces or a hyphen after it, then
 *   hyphenated; a string still not a multigrade is dropped. D23: the `low` benchmark run wrote the
 *   Gol's six grades `SAE 0W 30`, the normalizer dropped every one, and a manual reading of them
 *   would have been recorded `stated_nothing` for good.
 */
import { describe, expect, it } from "vitest";
import { readForIdentity } from "../manuals/read-for-identity.js";
import { GOL_2021_10, golPages } from "../manuals/fixtures/gol-located.js";
import { normalizeSaeGrade, normalizeSaeGrades, validateExtractedSpec, type ExtractedOilSpec } from "./oil-spec.js";

const GOL_PREFIXED = ["SAE 0W 30", "SAE 0W 40", "SAE 5W 30", "SAE 5W 40", "SAE 10W 30", "SAE 10W 40"];
const GOL_GRADES = ["0W-30", "0W-40", "5W-30", "5W-40", "10W-30", "10W-40"];

describe("normalizeSaeGrade", () => {
  it.each([
    ["SAE 0W 30", "0W-30"],
    ["sae0w-30", "0W-30"],
    ["SAE-0W30", "0W-30"],
    ["SAE 10W 40", "10W-40"],
    ["0W 30", "0W-30"],
    ["5w30", "5W-30"],
    ["5W-30", "5W-30"],
  ])("%s gives %s", (written, grade) => {
    expect(normalizeSaeGrade(written)).toBe(grade);
  });

  it.each(["SAE 30", "SAE", ""])("%j gives null", (written) => {
    expect(normalizeSaeGrade(written)).toBeNull();
  });
});

describe("the Gol's SAE-prefixed grades", () => {
  it("normalize to the six hyphenated grades, and validation keeps them", () => {
    expect(normalizeSaeGrades(GOL_PREFIXED)).toEqual(GOL_GRADES);

    const spec: ExtractedOilSpec = { viscosityGrades: GOL_PREFIXED, classification: "", fillLiters: null, fillKind: null };
    expect(validateExtractedSpec(spec)?.viscosityGrades).toEqual(GOL_GRADES);
  });

  it("are read as verified, not stated_nothing, from a passage stating them", async () => {
    const outcome = await readForIdentity(
      { url: "https://www.vw.com.br/gol.pdf", pages: golPages(), identity: GOL_2021_10, meta: { publisher: "vw.com.br", document: "Manual Gol 2021", sourceClass: "manufacturer_manual" }, k: 6 },
      { extract: async () => ({ viscosityGrades: GOL_PREFIXED, classification: "", fillLiters: null, fillKind: null, engineCoverage: "one", enginesNamed: [] }) },
    );

    expect(outcome.status).toBe("verified");
  });
});
