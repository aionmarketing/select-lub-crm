/**
 * Test design (testing-strategy)
 *
 * Setup: `encodeFiltros` is pure string building, no HTTP.
 *
 * Spec: openspec/changes/tecfil-filter-pricing/specs/tecfil-fitment/spec.md
 * — "Wire encoding and decoding stay inside the package" (coded pair) and
 * design.md D2 (range filters, via `docs/tecfil-catalogo-expresso-api.md`
 * "The filtros grammar").
 *
 * Techniques: EP of filter shapes (plain, coded, ranged, negated, empty);
 * exact-string assertions against the reference doc's own worked examples,
 * since the wire format is what a real server parses.
 *
 * Axes
 * A1 filter shape: plain value | coded (label + code) | DE-/ATE- range pair |
 *    DE- only (open upper) | ATE- only (open lower) | negated | empty input
 *
 * Outputs: O1 exact wire string
 *
 * Sampled-cell table
 * it                                          | axis            | fails if
 * joins a coded filter with its cod entry     | A1 coded        | wrong sentinel or missing cod entry
 * collapses a DE-/ATE- pair into one range     | A1 range pair   | DE-/ATE- sent uncollapsed (silent 200 on the real API)
 * collapses a lone DE- into an open upper bound| A1 DE- only     | wrong side left empty
 * collapses a lone ATE- into an open lower bound| A1 ATE- only   | wrong side left empty
 * prefixes a negated filter with <!5!>         | A1 negated      | prefix missing or on wrong side
 * returns "" for no filters                    | A1 empty        | non-empty string
 * joins multiple filters with the combined example from the reference doc
 *                                              | A1 coded + plain| any character differs from the doc's worked example
 *
 * Out of scope: URL-encoding (the caller's job, not the encoder's); filter
 * ids the resolver never sends (documented for completeness in the grammar
 * but not exercised by resolveFilters).
 */
import { describe, expect, it } from "vitest";
import { encodeFiltros } from "./filtros.js";

describe("encodeFiltros", () => {
  it("joins a coded filter with its cod entry", () => {
    const wire = encodeFiltros({
      FABRICANTEAPLICACAO: { value: "VOLKSWAGEN", code: 36 },
    });

    expect(wire).toBe(
      "FABRICANTEAPLICACAO<!2!>VOLKSWAGEN<!1!>codFABRICANTEAPLICACAO<!2!>36",
    );
  });

  it("collapses a DE-/ATE- pair into one range entry", () => {
    const wire = encodeFiltros({
      "DE-CPOAUXPROD28": { value: "100" },
      "ATE-CPOAUXPROD28": { value: "200" },
    });

    expect(wire).toBe("CPOAUXPROD28<!2!>100<!4!>200");
  });

  it("collapses a lone DE- into an open upper bound", () => {
    const wire = encodeFiltros({ "DE-CPOAUXPROD28": { value: "100" } });

    expect(wire).toBe("CPOAUXPROD28<!2!>100<!4!>");
  });

  it("collapses a lone ATE- into an open lower bound", () => {
    const wire = encodeFiltros({ "ATE-CPOAUXPROD28": { value: "100" } });

    expect(wire).toBe("CPOAUXPROD28<!2!><!4!>100");
  });

  it("prefixes a negated filter with <!5!>", () => {
    const wire = encodeFiltros({ FlagLancamento: { value: "1", negate: true } });

    expect(wire).toBe("FlagLancamento<!2!><!5!>1");
  });

  it("returns an empty string for no filters", () => {
    expect(encodeFiltros({})).toBe("");
  });

  it("matches the reference doc's combined example", () => {
    const wire = encodeFiltros({
      FABRICANTEAPLICACAO: { value: "VOLKSWAGEN", code: 36 },
      AplicacaoAnoDeAte: { value: "2020" },
    });

    expect(wire).toBe(
      "FABRICANTEAPLICACAO<!2!>VOLKSWAGEN<!1!>codFABRICANTEAPLICACAO<!2!>36<!1!>AplicacaoAnoDeAte<!2!>2020",
    );
  });
});
