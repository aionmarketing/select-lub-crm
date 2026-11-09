/**
 * Test design (testing-strategy) — how a lubricant is named and typed (add-lubricant-oil-type)
 *
 * SUT: `oilCardName`, `oilTypeLabel`.
 *
 * Oracle: oil-quote delta "Cards carry editable prices and assemble the message live" — the title
 *   is brand, description and viscosity, with the viscosity left out only when the description
 *   already names that grade under the SAE normalization; the type reads in pt-BR, and an untyped
 *   lubricant shows none.
 *
 * Axes
 *   A1 grade in description — absent / exact / unhyphenated / a longer grade sharing digits
 *   A2 oil type — each value / null
 */
import { describe, expect, it } from "vitest";
import { oilCardName, oilTypeLabel } from "./oilCardName.js";

describe("oilCardName", () => {
  it.each([
    ["Motul", "8100 Eco-nergy", "5W-30", "Motul 8100 Eco-nergy 5W-30"],
    ["Mobil", "Super 3000 0W-20", "0W-20", "Mobil Super 3000 0W-20"],
    ["Gen", "Óleo 5w30 1L", "5W-30", "Gen Óleo 5w30 1L"],
    ["Ipiranga", "F1 Master 15W-40", "5W-40", "Ipiranga F1 Master 15W-40 5W-40"],
  ])("%s %s at %s reads %j", (brand, description, viscosity, expected) => {
    expect(oilCardName({ brand, description, lubricant: { viscosity } })).toBe(expected);
  });
});

describe("oilTypeLabel", () => {
  it.each([
    ["SINTETICO", "Sintético"],
    ["SEMISSINTETICO", "Semissintético"],
    ["MINERAL", "Mineral"],
  ] as const)("labels %s as %s", (oilType, label) => {
    expect(oilTypeLabel(oilType)).toBe(label);
  });

  it("has no label for an untyped lubricant", () => {
    expect(oilTypeLabel(null)).toBeNull();
  });
});
