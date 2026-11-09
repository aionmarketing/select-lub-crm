/**
 * Test design (testing-strategy)
 *
 * Setup: `absentString` and `absentPositiveInt` alone, no HTTP.
 *
 * Spec: openspec/specs/plate-lookup/plate-lookup/spec.md
 * — "Unknown fields are omitted, never invented": a field a provider returns as
 * an empty or placeholder value is absent from the suggestion rather than
 * passed through.
 *
 * Techniques: EP over real value vs placeholder vs wrong type; BVA on the
 * all-zero rule, whose interesting boundary is a value that merely begins with
 * a zero and must survive.
 *
 * Axes
 * A1 string content
 *   EP real: ordinary text; leading-zero text
 *   EP placeholder: empty, whitespace-only, all zeros
 *   EP wrong type: number, null, undefined, object
 * A2 numeric value
 *   EP positive: number, numeric string
 *   EP non-positive: 0, negative
 *   EP unparseable: non-numeric string, NaN
 *
 * Outputs: O1 trimmed string; O2 positive integer; O3 `undefined`
 *
 * Sampled-cell table
 * it                                            | axes             | O | fails if
 * keeps and trims a real string                 | A1 real          | 1 | not trimmed
 * keeps a value that only starts with zero      | A1 real BVA      | 1 | undefined
 * drops empty, whitespace and all-zero strings  | A1 placeholder   | 3 | defined
 * drops non-string input                        | A1 wrong type    | 3 | defined
 * reads a positive number and numeric string    | A2 positive      | 2 | undefined
 * drops zero and negative displacement          | A2 non-positive  | 3 | defined
 * drops unparseable numeric input               | A2 unparseable   | 3 | defined
 * truncates a fractional number                 | A2 positive BVA  | 2 | not integer
 *
 * Decision / branch map
 * D1 absentString typeof !== string   T: undefined; F: continue
 * D2 absentString trimmed === ""      T: undefined; F: continue
 * D3 absentString /^0+$/              T: undefined; F: continue
 * D3b absentString INDETERMINADO/DESCONHECIDO T: undefined; F: returns value
 * D4 absentPositiveInt Number.isFinite F: undefined; T: continue
 * D5 absentPositiveInt truncated > 0   T: returns; F: undefined
 *
 * Out of scope: which provider field feeds these — that is the adapters' job,
 * covered in their own tests.
 */
import { describe, expect, it } from "vitest";
import { absentPositiveInt, absentString } from "./absent.js";

describe("absentString", () => {
  it("keeps and trims a real string", () => {
    expect(absentString("  1.0 FLEX 12V 4P  ")).toBe("1.0 FLEX 12V 4P");
  });

  it("keeps a value that merely starts with a zero", () => {
    // Leading zeros are meaningful in identifiers such as a FIPE code.
    expect(absentString("001267-0")).toBe("001267-0");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["all zeros", "00000000000"],
    ["single zero", "0"],
    ["INDETERMINADO", "INDETERMINADO"],
    ["DESCONHECIDO mixed case", "Desconhecido"],
  ])("drops a %s string", (_label, input) => {
    expect(absentString(input)).toBeUndefined();
  });

  it.each([
    ["number", 999],
    ["null", null],
    ["undefined", undefined],
    ["object", { nome: "GOL" }],
  ])("drops a %s", (_label, input) => {
    expect(absentString(input)).toBeUndefined();
  });
});

describe("absentPositiveInt", () => {
  it.each([
    ["number", 999, 999],
    ["numeric string", "1598", 1598],
    ["padded numeric string", "  2021  ", 2021],
  ])("reads a positive %s", (_label, input, expected) => {
    expect(absentPositiveInt(input)).toBe(expected);
  });

  it("truncates a fractional number", () => {
    expect(absentPositiveInt(1598.7)).toBe(1598);
  });

  it.each([
    ["zero", 0],
    ["zero string", "0"],
    ["negative", -1],
  ])("drops %s", (_label, input) => {
    expect(absentPositiveInt(input)).toBeUndefined();
  });

  it.each([
    ["non-numeric string", "DESCONHECIDO"],
    ["empty string", ""],
    ["null", null],
    ["NaN", Number.NaN],
  ])("drops unparseable %s", (_label, input) => {
    expect(absentPositiveInt(input)).toBeUndefined();
  });
});
